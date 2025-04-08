import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs/promises";
import https from "node:https";
import LRUCache from "lru-cache";

const app = express();
const PORT = process.env.PORT || 10000;

// 驗證環境變數
["LINE_CHANNEL_ACCESS_TOKEN","LINE_CHANNEL_SECRET","DEEPSEEK_API_KEY","PING_URL"]
  .forEach(v => {
    if (!process.env[v]) {
      console.error(`❌ 缺少環境變數 ${v}`);
      process.exit(1);
    }
  });

// LINE 客戶端
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new Client(lineConfig);

// 載入／儲存群組語言設定
const LANG_FILE = "./groupLanguages.json";
let groupLang = new Map();
const loadLang = async () => {
  try {
    const d = await fs.readFile(LANG_FILE,"utf8");
    Object.entries(JSON.parse(d)).forEach(([g,arr])=>{
      groupLang.set(g,new Set(arr));
    });
  } catch {}
};
const saveLang = async () => {
  const obj = {};
  groupLang.forEach((set,g)=> obj[g]=[...set]);
  await fs.writeFile(LANG_FILE,JSON.stringify(obj,null,2));
};

// 判斷是否含中文
const isChinese = text => /[\u4e00-\u9fff]/.test(text);

// 快取
const multiCache = new LRUCache({ max:200, ttl:24*60*60*1000 });

// 一次多語翻譯
const translateMulti = async (text, codes, retry=0) => {
  const key = `${codes.sort().join(",")}|${text}`;
  if (multiCache.has(key)) return multiCache.get(key);

  const names = { en:"英文", th:"泰文", vi:"越南文", id:"印尼文" };
  const langList = codes.map(c=>names[c]).join("、");
  const sys = `你是一名翻譯員，請將以下句子翻譯成 ${langList}。回覆時用「語言: 翻譯」一行一種語言，不要其他文字。`;

  try {
    const res = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      { model:"deepseek-chat", messages:[
          { role:"system", content:sys },
          { role:"user", content:text }
        ] },
      { headers:{ Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const reply = res.data.choices[0].message.content.trim();
    // 解析每行 "語言: 翻譯"
    const lines = reply.split(/\r?\n/);
    const out = {};
    lines.forEach(line=>{
      const m = line.match(/^(\S+)\s*:\s*(.+)$/);
      if(m){
        const code = Object.keys(names).find(k=>names[k]===m[1]);
        out[code||""] = m[2];
      }
    });
    multiCache.set(key,out);
    return out;
  } catch(e){
    if(e.response?.status===429 && retry<3){
      await new Promise(r=>setTimeout(r,(retry+1)*3000));
      return translateMulti(text,codes,retry+1);
    }
    console.error("多語翻譯失敗:",e.message);
    return {};
  }
};

// 單語翻譯
const singleCache = new LRUCache({ max:500, ttl:24*60*60*1000 });
const translateSingle = async (text, lang, retry=0) => {
  const key = `${lang}:${text}`;
  if(singleCache.has(key)) return singleCache.get(key);
  const names = { en:"英文", th:"泰文", vi:"越南文", id:"印尼文", "zh-TW":"繁體中文" };
  const sys = `你是一名翻譯員，請將以下句子翻譯成${names[lang]||lang}，僅回傳翻譯結果。`;
  try {
    const res = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      { model:"deepseek-chat", messages:[
          { role:"system", content:sys },
          { role:"user", content:text }
        ] },
      { headers:{ Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const out = res.data.choices[0].message.content.trim();
    singleCache.set(key,out);
    return out;
  } catch(e){
    if(e.response?.status===429 && retry<3){
      await new Promise(r=>setTimeout(r,(retry+1)*3000));
      return translateSingle(text,lang,retry+1);
    }
    console.error("單語翻譯失敗:",e.message);
    return "（翻譯失敗）";
  }
};

// Webhook
app.post(
  "/webhook",
  bodyParser.raw({type:"application/json"}),
  middleware(lineConfig),
  express.json(),
  async (req,res)=>{
    await Promise.all(req.body.events.map(async event=>{
      const gid = event.source?.groupId;
      const txt = event.message?.text;

      if(event.type==="join" && gid){
        await sendMenu(gid);
        return;
      }
      if(event.type==="message" && txt==="!設定" && gid){
        await sendMenu(gid);
        return;
      }
      if(event.type==="postback" && gid){
        const p=new URLSearchParams(event.postback.data);
        if(p.get("action")==="set_lang"){
          const code=p.get("code");
          let set=groupLang.get(gid)||new Set();
          if(code==="cancel") set.clear();
          else set.has(code)?set.delete(code):set.add(code);
          if(set.size) groupLang.set(gid,set);
          else groupLang.delete(gid);
          await saveLang();
          const names={en:"英文",th:"泰文",vi:"越南文",id:"印尼文"};
          const cur=[...set].map(c=>names[c]).join("、")||"無";
          await client.replyMessage(event.replyToken,{type:"text",text:`目前選擇：${cur}`});
        }
        return;
      }
      if(event.type==="message" && event.message.type==="text" && gid){
        const set=groupLang.get(gid);
        if(!set||set.size===0) return;
        if(isChinese(txt)){
          const codes=[...set];
          const out=await translateMulti(txt,codes);
          await client.replyMessage(event.replyToken,
            codes.map(c=>({type:"text",text:out[c]||"錯誤"}))
          );
        } else {
          const t=await translateSingle(txt,"zh-TW");
          await client.replyMessage(event.replyToken,[{type:"text",text:t}]);
        }
      }
    }));
    res.sendStatus(200);
  }
);

// 發選單
const rateLimit={}, INTERVAL=60000;
const canSend=gid=>{
  const now=Date.now();
  if(!rateLimit[gid]||now-rateLimit[gid]>INTERVAL){rateLimit[gid]=now;return true;}
  return false;
};
const sendMenu=async(gid,retry=0)=>{
  if(!canSend(gid))return;
  const names={en:"英文",th:"泰文",vi:"越南文",id:"印尼文"};
  const btns=Object.entries(names).map(([c,l])=>({
    type:"button",action:{type:"postback",label:l,data:`action=set_lang&code=${c}`},
    style:"primary",color:"#34B7F1"
  }));
  btns.push({type:"button",action:{type:"postback",label:"取消選擇",data:"action=set_lang&code=cancel"},style:"secondary",color:"#FF3B30"});
  const msg={type:"flex",altText:"語言設定選單",contents:{type:"bubble",body:{type:"box",layout:"vertical",contents:[
    {type:"text",text:"🌍 請選擇翻譯語言",weight:"bold"},
    {type:"separator",margin:"md"},
    ...btns
  ]}}};
  try{await client.pushMessage(gid,msg);}
  catch(e){
    if(e.statusCode===429&&retry<3){await new Promise(r=>setTimeout(r,(retry+1)*3000));return sendMenu(gid,retry+1);}
    console.error("選單發送失敗:",e.message);
  }
};

// 健康檢查
app.get("/",(req,res)=>res.send("OK"));
app.get("/ping",(req,res)=>res.send("pong"));

// 自我 PING
setInterval(()=>{
  https.get(process.env.PING_URL,r=>console.log("📡 PING",r.statusCode))
       .on("error",e=>console.error("PING失敗",e.message));
},10*60*1000);

// 啟動
app.listen(PORT,async()=>{
  await loadLang();
  console.log(`🚀 服務已啟動，監聽於 ${PORT}`);
});
