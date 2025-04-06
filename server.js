import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs/promises";
import https from "node:https";

const app = express();
const PORT = process.env.PORT || 10000;

// 驗證環境變數
["LINE_CHANNEL_ACCESS_TOKEN","LINE_CHANNEL_SECRET","DEEPSEEK_API_KEY","PING_URL"]
  .forEach(v=>{ if(!process.env[v]){ console.error(`缺少環境變數 ${v}`); process.exit(1);} });

// LINE 客戶端
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new Client(lineConfig);

// 讀寫群組語言設定
const LANG_FILE = "./groupLanguages.json";
let groupLang = new Map();
const loadLang = async ()=>{
  try {
    const d = await fs.readFile(LANG_FILE,"utf8");
    Object.entries(JSON.parse(d)).forEach(([g,arr])=>groupLang.set(g,new Set(arr)));
  } catch{}
};
const saveLang = async ()=>{
  const obj = {};
  groupLang.forEach((set,g)=> obj[g]=[...set]);
  await fs.writeFile(LANG_FILE,JSON.stringify(obj,null,2));
};

// 判斷中文
const isChinese = s=>/[\u4e00-\u9fff]/.test(s);

// DeepSeek 翻譯
const translateWithDeepSeek = async (text, targetLang, retry=0)=>{
  const sys = `你是一名翻譯員，請將以下句子翻譯成${
    targetLang==="zh-TW"?"繁體中文":
    targetLang==="en"?"英文":
    targetLang==="th"?"泰文":
    targetLang==="vi"?"越南文":
    targetLang==="id"?"印尼文":targetLang
  }，僅回傳翻譯結果。`;
  try {
    const r = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      { model:"deepseek-chat", messages:[{role:"system",content:sys},{role:"user",content:text}] },
      { headers:{ Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    return r.data.choices[0].message.content.trim();
  } catch(e){
    if(e.response?.status===429 && retry<3){
      await new Promise(r=>setTimeout(r,(retry+1)*5000));
      return translateWithDeepSeek(text,targetLang,retry+1);
    }
    console.error("翻譯錯誤:",e.message);
    return "（翻譯暫時不可用）";
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
      // 1) 機器人一進群就自動跳選單
      if(event.type==="join" && gid){
        console.log(`🤖 新群組加入: ${gid}`);
        return sendMenu(gid);
      }
      // 2) 後續要更改再用 !設定
      if(event.type==="message" && event.message.type==="text" && event.message.text==="!設定" && gid){
        return sendMenu(gid);
      }
      // 3) postback 設定/取消
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
          return client.replyMessage(event.replyToken,{type:"text",text:cur});
        }
      }
      // 4) 訊息翻譯
      if(event.type==="message" && event.message.type==="text" && gid){
        const txt=event.message.text;
        const set=groupLang.get(gid);
        if(!set||!set.size) return; // 未設定，不回覆
        if(isChinese(txt)){
          // 中文→各選語言
          for(const c of set){
            const t=await translateWithDeepSeek(txt,c);
            await client.replyMessage(event.replyToken,{type:"text",text:t});
          }
        } else {
          // 非中文→繁中
          const t=await translateWithDeepSeek(txt,"zh-TW");
          await client.replyMessage(event.replyToken,{type:"text",text:t});
        }
      }
    }));
    res.sendStatus(200);
  }
);

// 發選單
const rateLimit={}, INTERVAL=60000;
const canSend=g=>{
  const now=Date.now();
  if(!rateLimit[g]||now-rateLimit[g]>INTERVAL){rateLimit[g]=now;return true;}
  return false;
};
const sendMenu=async(g,retry=0)=>{
  if(!canSend(g)) return;
  const btns=["en","th","vi","id"].map(c=>({
    type:"button",
    action:{type:"postback",label:c.toUpperCase(),data:`action=set_lang&code=${c}`},
    style:"primary",color:"#34B7F1"
  }));
  btns.push({
    type:"button",
    action:{type:"postback",label:"取消選擇",data:"action=set_lang&code=cancel"},
    style:"secondary",color:"#FF3B30"
  });
  const msg={type:"flex",altText:"語言選單",contents:{type:"bubble",body:{type:"box",layout:"vertical",contents:[
    {type:"text",text:"🌍 請選擇翻譯語言",weight:"bold"},
    {type:"separator",margin:"md"},
    ...btns
  ]}}};
  try{await client.pushMessage(g,msg);}
  catch(e){
    if(e.statusCode===429&&retry<3){
      await new Promise(r=>setTimeout(r,(retry+1)*5000));
      return sendMenu(g,retry+1);
    }
    console.error("選單發送失敗:",e.message);
  }
};

// 健康檢查
app.get("/",(req,res)=>res.send("OK"));
app.get("/ping",(req,res)=>res.send("pong"));

// 自我 PING
setInterval(()=>{
  https.get(process.env.PING_URL,r=>console.log("PING",r.statusCode))
       .on("error",e=>console.error("PING失敗",e.message));
},10*60*1000);

// 啟動
app.listen(PORT,async()=>{
  await loadLang();
  console.log(`🚀 服務運行於 ${PORT}`);
});
