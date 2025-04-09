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
["LINE_CHANNEL_ACCESS_TOKEN","LINE_CHANNEL_SECRET","DEEPSEEK_API_KEY","PING_URL"].forEach(v=>{
  if(!process.env[v]){
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

// 翻譯快取
const translationCache = new LRUCache({ max:500, ttl:24*60*60*1000 });

// 群組語言設定與 inviter 記錄
const LANG_FILE = "./groupLanguages.json";
let groupLang = new Map();      // groupId -> Set<code>
let groupInviter = new Map();   // groupId -> userId

const loadLang = async () => {
  try {
    const d = await fs.readFile(LANG_FILE, "utf8");
    Object.entries(JSON.parse(d)).forEach(([g, arr])=>{
      groupLang.set(g, new Set(arr));
    });
    console.log("✅ 載入語言設定");
  } catch {}
};

const saveLang = async () => {
  const obj = {};
  groupLang.forEach((set,g)=> obj[g]=[...set]);
  await fs.writeFile(LANG_FILE, JSON.stringify(obj,null,2));
  console.log("✅ 儲存語言設定");
};

const isChinese = txt => /[\u4e00-\u9fff]/.test(txt);
const langNames = { en:"英文", th:"泰文", vi:"越南文", id:"印尼文" };

// DeepSeek 翻譯（含快取）
const translateWithDeepSeek = async (text, targetLang, retry=0) => {
  const key = `${targetLang}:${text}`;
  if(translationCache.has(key)) return translationCache.get(key);

  const sys = `你是一名翻譯員，請將以下句子翻譯成${langNames[targetLang]||targetLang}，僅回傳翻譯結果。`;
  try {
    const res = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      { model:"deepseek-chat", messages:[
          { role:"system", content: sys },
          { role:"user", content: text }
        ] },
      { headers:{ Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const out = res.data.choices[0].message.content.trim();
    translationCache.set(key, out);
    return out;
  } catch (e) {
    if(e.response?.status===429 && retry<3){
      await new Promise(r=>setTimeout(r,(retry+1)*5000));
      return translateWithDeepSeek(text,targetLang,retry+1);
    }
    console.error("翻譯失敗:", e.message);
    return "（翻譯暫時不可用）";
  }
};

// Webhook 主程式
app.post(
  "/webhook",
  bodyParser.raw({ type:"application/json" }),
  middleware(lineConfig),
  express.json(),
  async (req, res) => {
    await Promise.all(req.body.events.map(async event => {
      const gid = event.source?.groupId;
      const uid = event.source?.userId;
      const txt = event.message?.text;

      // 1. Bot 加入群組 → 直接顯示選單
      if(event.type==="join" && gid){
        await sendMenu(gid);
        return;
      }

      // 2. !設定 指令
      if(event.type==="message" && txt==="!設定" && gid && uid){
        // 第一個觸發者成為 inviter
        if(!groupInviter.has(gid)){
          groupInviter.set(gid, uid);
        }
        // 非 inviter 無法設定
        if(groupInviter.get(gid) !== uid){
          return client.replyMessage(event.replyToken, {
            type:"text", text:"❌ 只有第一位觸發者可以設定語言選單"
          });
        }
        await sendMenu(gid);
        return;
      }

      // 3. postback（按鈕點擊）
      if(event.type==="postback" && gid && uid){
        const p = new URLSearchParams(event.postback.data);
        const action = p.get("action");

        if(action === "set_lang"){
          // 第一個點按者成為 inviter
          if(!groupInviter.has(gid)){
            groupInviter.set(gid, uid);
          }
          if(groupInviter.get(gid) !== uid){
            return client.replyMessage(event.replyToken, {
              type:"text", text:"❌ 只有第一位觸發者可以設定語言"
            });
          }

          const code = p.get("code");
          let set = groupLang.get(gid) || new Set();
          if(code==="cancel") set.clear();
          else set.has(code) ? set.delete(code) : set.add(code);
          if(set.size) groupLang.set(gid, set);
          else groupLang.delete(gid);
          await saveLang();

          const cur = [...(groupLang.get(gid)||[])].map(c=>langNames[c]).join("、")||"無";
          await client.replyMessage(event.replyToken, {
            type:"text", text:`✅ 群組語言設定：${cur}`
          });
        }
        return;
      }

      // 4. 翻譯訊息
      if(event.type==="message" && event.message.type==="text" && gid && uid){
        const set = groupLang.get(gid);
        if(!set || set.size===0) return;

        // 取得使用者名稱
        let name = uid;
        try {
          const profile = await client.getGroupMemberProfile(gid, uid);
          name = profile.displayName;
        } catch {}

        if(isChinese(txt)){
          // 中文 → 多語翻譯
          const codes = [...set];
          const results = await Promise.all(codes.map(c=>translateWithDeepSeek(txt,c)));
          const msgs = [
            { type:"text", text:`【${name}】說：${txt}` },
            ...results.map(t=>({ type:"text", text:t }))
          ];
          await client.replyMessage(event.replyToken, msgs);
        } else {
          // 其他語 → 繁體中文
          const t = await translateWithDeepSeek(txt,"zh-TW");
          await client.replyMessage(event.replyToken, [
            { type:"text", text:`【${name}】說：${txt}` },
            { type:"text", text:t }
          ]);
        }
      }
    }));
    res.sendStatus(200);
  }
);

// 顯示選單
const rateLimit = {}, INTERVAL=60000;
const canSend = gid => {
  const now = Date.now();
  if(!rateLimit[gid]||now-rateLimit[gid]>INTERVAL){
    rateLimit[gid]=now;
    return true;
  }
  return false;
};
const sendMenu = async (gid,retry=0) => {
  if(!canSend(gid)) return;
  const buttons = Object.entries(langNames).map(([code,label])=>({
    type:"button",
    action:{ type:"postback", label, data:`action=set_lang&code=${code}` },
    style:"primary", color:"#34B7F1"
  }));
  buttons.push({
    type:"button",
    action:{ type:"postback", label:"取消選擇", data:"action=set_lang&code=cancel" },
    style:"secondary", color:"#FF3B30"
  });

  const msg = {
    type:"flex", altText:"語言設定選單", contents:{
      type:"bubble", body:{
        type:"box", layout:"vertical", contents:[
          { type:"text", text:"🌍 請選擇翻譯語言", weight:"bold" },
          { type:"separator", margin:"md" },
          ...buttons
        ]
      }
    }
  };

  try {
    await client.pushMessage(gid,msg);
  } catch(e) {
    if(e.statusCode===429 && retry<3){
      await new Promise(r=>setTimeout(r,(retry+1)*5000));
      return sendMenu(gid,retry+1);
    }
    console.error("選單發送失敗:", e.message);
  }
};

// 健康檢查 & 防休眠
app.get("/",(req,res)=>res.send("OK"));
app.get("/ping",(req,res)=>res.send("pong"));
setInterval(()=>{
  https.get(process.env.PING_URL, r=>console.log("📡 PING",r.statusCode))
       .on("error", e=>console.error("PING失敗",e.message));
},10*60*1000);

// 啟動服務
app.listen(PORT, async ()=>{
  await loadLang();
  console.log(`🚀 服務已啟動，監聽於 ${PORT}`);
});
