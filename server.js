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
    const d = await fs.readFile(LANG_FILE, "utf8");
    Object.entries(JSON.parse(d)).forEach(([g, arr]) => {
      groupLang.set(g, new Set(arr));
    });
    console.log("✅ 載入語言設定");
  } catch {}
};
const saveLang = async () => {
  const obj = {};
  groupLang.forEach((set, g) => obj[g] = [...set]);
  await fs.writeFile(LANG_FILE, JSON.stringify(obj, null, 2));
  console.log("✅ 儲存語言設定");
};

// 判斷是否含中文
const isChinese = text => /[\u4e00-\u9fff]/.test(text);

// 批次翻譯快取
const batchCache = new LRUCache({ max: 200, ttl: 24*60*60*1000 });

// 批次翻譯：一次取得多語 JSON
const translateBatch = async (text, codes, retry = 0) => {
  const key = `batch:${codes.sort().join(",")}:${text}`;
  if (batchCache.has(key)) return batchCache.get(key);

  const names = { en:"英文", th:"泰文", vi:"越南文", id:"印尼文" };
  const langList = codes.map(c => names[c]).join("、");
  const sys = `你是一名翻譯員，請將以下句子同時翻譯成 ${langList}，僅回傳純 JSON，不要任何解釋或 code fence。格式範例：{"en":"...","th":"..."}。`;

  try {
    const res = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: text }
        ]
      },
      { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const content = res.data.choices[0].message.content.trim();
    const match = content.match(/\{[\s\S]*\}/);
    const json = match ? JSON.parse(match[0]) : {};
    batchCache.set(key, json);
    return json;
  } catch (e) {
    if (e.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return translateBatch(text, codes, retry + 1);
    }
    console.warn("批次翻譯失敗，退回單語模式:", e.message);
    // fallback: 單語並行
    const fallback = {};
    await Promise.all(codes.map(async c => {
      fallback[c] = await translateSingle(text, c);
    }));
    return fallback;
  }
};

// 單語翻譯（快取）
const singleCache = new LRUCache({ max: 500, ttl: 24*60*60*1000 });
const translateSingle = async (text, lang, retry = 0) => {
  const key = `${lang}:${text}`;
  if (singleCache.has(key)) return singleCache.get(key);

  const names = { en:"英文", th:"泰文", vi:"越南文", id:"印尼文", "zh-TW":"繁體中文" };
  const sys = `你是一名翻譯員，請將以下句子翻譯成${names[lang]||lang}，僅回傳翻譯結果。`;
  try {
    const res = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: text }
        ]
      },
      { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const out = res.data.choices[0].message.content.trim();
    singleCache.set(key, out);
    return out;
  } catch (e) {
    if (e.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return translateSingle(text, lang, retry + 1);
    }
    console.error("單語翻譯失敗:", e.message);
    return "（翻譯失敗）";
  }
};

// Webhook
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  middleware(lineConfig),
  express.json(),
  async (req, res) => {
    await Promise.all(req.body.events.map(async event => {
      const gid = event.source?.groupId;
      const txt = event.message?.text;

      // join → 顯示選單
      if (event.type === "join" && gid) {
        await sendMenu(gid);
        return;
      }
      // !設定 → 顯示選單
      if (event.type === "message" && txt === "!設定" && gid) {
        await sendMenu(gid);
        return;
      }
      // postback → 設定/取消
      if (event.type === "postback" && gid) {
        const p = new URLSearchParams(event.postback.data);
        if (p.get("action") === "set_lang") {
          const code = p.get("code");
          let set = groupLang.get(gid) || new Set();
          if (code === "cancel") set.clear();
          else set.has(code) ? set.delete(code) : set.add(code);
          if (set.size) groupLang.set(gid, set);
          else groupLang.delete(gid);
          await saveLang();
          const names = { en:"英文", th:"泰文", vi:"越南文", id:"印尼文" };
          const cur = [...set].map(c => names[c]).join("、") || "無";
          await client.replyMessage(event.replyToken, { type: "text", text: `目前選擇：${cur}` });
        }
        return;
      }
      // 訊息翻譯
      if (event.type === "message" && event.message.type === "text" && gid) {
        const set = groupLang.get(gid);
        if (!set || set.size === 0) return;

        if (isChinese(txt)) {
          // 中文 → 批次翻譯
          const codes = [...set];
          const json = await translateBatch(txt, codes);
          const msgs = codes.map(c => ({ type: "text", text: json[c] }));
          await client.replyMessage(event.replyToken, msgs);
        } else {
          // 非中文 → 繁體中文
          const t = await translateSingle(txt, "zh-TW");
          await client.replyMessage(event.replyToken, [{ type: "text", text: t }]);
        }
      }
    }));
    res.sendStatus(200);
  }
);

// 發送選單
const rateLimit = {}, INTERVAL = 60000;
const canSend = gid => {
  const now = Date.now();
  if (!rateLimit[gid] || now - rateLimit[gid] > INTERVAL) {
    rateLimit[gid] = now;
    return true;
  }
  return false;
};

const sendMenu = async (gid, retry = 0) => {
  if (!canSend(gid)) return;
  const names = { en:"英文", th:"泰文", vi:"越南文", id:"印尼文" };
  const buttons = Object.entries(names).map(([c,l])=>({
    type:"button",
    action:{type:"postback",label:l,data:`action=set_lang&code=${c}`},
    style:"primary",color:"#34B7F1"
  }));
  buttons.push({
    type:"button",
    action:{type:"postback",label:"取消選擇",data:"action=set_lang&code=cancel"},
    style:"secondary",color:"#FF3B30"
  });

  const msg = {
    type:"flex", altText:"語言設定選單", contents:{
      type:"bubble", body:{
        type:"box", layout:"vertical", contents:[
          {type:"text", text:"🌍 請選擇翻譯語言", weight:"bold"},
          {type:"separator", margin:"md"},
          ...buttons
        ]
      }
    }
  };

  try { await client.pushMessage(gid,msg); }
  catch(e){
    if(e.statusCode===429&&retry<3){
      await new Promise(r=>setTimeout(r,(retry+1)*5000));
      return sendMenu(gid,retry+1);
    }
    console.error("選單發送失敗:",e.message);
  }
};

// 健康檢查
app.get("/", (req,res)=>res.send("OK"));
app.get("/ping", (req,res)=>res.send("pong"));

// 自我 PING
setInterval(()=>{
  https.get(process.env.PING_URL, r=>console.log("📡 PING",r.statusCode))
       .on("error", e=>console.error("PING 失敗", e.message));
}, 10*60*1000);

// 啟動
app.listen(PORT, async ()=>{
  await loadLang();
  console.log(`🚀 服務已啟動，監聽於 ${PORT}`);
});
