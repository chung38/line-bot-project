import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs/promises";
import https from "node:https";

const app = express();
const PORT = process.env.PORT || 10000;

// 驗證必要的環境變數
["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET", "DEEPSEEK_API_KEY", "PING_URL"].forEach(v => {
  if (!process.env[v]) {
    console.error(`缺少環境變數 ${v}`);
    process.exit(1);
  }
});

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new Client(lineConfig);

// 翻譯設定記憶
const LANG_FILE = "./groupLanguages.json";
let groupLang = new Map();

const loadLang = async () => {
  try {
    const data = await fs.readFile(LANG_FILE, "utf8");
    Object.entries(JSON.parse(data)).forEach(([group, arr]) => {
      groupLang.set(group, new Set(arr));
    });
  } catch {}
};

const saveLang = async () => {
  const obj = {};
  groupLang.forEach((set, group) => {
    obj[group] = [...set];
  });
  await fs.writeFile(LANG_FILE, JSON.stringify(obj, null, 2));
};

// 判斷是否為中文
const isChinese = text => /[\u4e00-\u9fff]/.test(text);

// DeepSeek 翻譯
const translateWithDeepSeek = async (text, targetLang, retry = 0) => {
  const sys = `你是一名翻譯員，請將以下句子翻譯成${
    targetLang === "zh-TW" ? "繁體中文" :
    targetLang === "en" ? "英文" :
    targetLang === "th" ? "泰文" :
    targetLang === "vi" ? "越南文" :
    targetLang === "id" ? "印尼文" : targetLang
  }，僅回傳翻譯結果。`;

  try {
    const response = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: text }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
        }
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (err) {
    if (err.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return translateWithDeepSeek(text, targetLang, retry + 1);
    }
    console.error("翻譯失敗:", err.message);
    return "（翻譯失敗，請稍後再試）";
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

      // ✅ 機器人剛加入群組時自動顯示語言設定選單
      if (event.type === "join" && gid) {
        await sendMenu(gid);
        return;
      }

      // ✅ 使用者輸入 !設定 顯示語言選單
      if (event.type === "message" && txt === "!設定" && gid) {
        await sendMenu(gid);
        return;
      }

      // ✅ 使用者從選單選擇語言
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
          const names = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文" };
          const cur = [...set].map(c => names[c]).join("、") || "無";
          await client.replyMessage(event.replyToken, { type: "text", text: `目前翻譯語言：${cur}` });
          return;
        }
      }

      // ✅ 翻譯訊息
      if (event.type === "message" && event.message.type === "text" && gid) {
        const set = groupLang.get(gid);
        if (!set || set.size === 0) return;

        if (isChinese(txt)) {
          for (const lang of set) {
            const result = await translateWithDeepSeek(txt, lang);
            await client.replyMessage(event.replyToken, { type: "text", text: result });
          }
        } else {
          const result = await translateWithDeepSeek(txt, "zh-TW");
          await client.replyMessage(event.replyToken, { type: "text", text: result });
        }
      }
    }));

    res.sendStatus(200);
  }
);

// 發送語言設定選單
const rateLimit = {}, INTERVAL = 60000;
const canSend = g => {
  const now = Date.now();
  if (!rateLimit[g] || now - rateLimit[g] > INTERVAL) {
    rateLimit[g] = now;
    return true;
  }
  return false;
};

const sendMenu = async (groupId, retry = 0) => {
  if (!canSend(groupId)) return;

  const buttons = ["en", "th", "vi", "id"].map(code => ({
    type: "button",
    action: {
      type: "postback",
      label: code.toUpperCase(),
      data: `action=set_lang&code=${code}`
    },
    style: "primary",
    color: "#34B7F1"
  }));

  buttons.push({
    type: "button",
    action: {
      type: "postback",
      label: "取消選擇",
      data: "action=set_lang&code=cancel"
    },
    style: "secondary",
    color: "#FF3B30"
  });

  const msg = {
    type: "flex",
    altText: "🌍 請選擇翻譯語言",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "🌍 請選擇翻譯語言", weight: "bold" },
          { type: "separator", margin: "md" },
          ...buttons
        ]
      }
    }
  };

  try {
    await client.pushMessage(groupId, msg);
  } catch (err) {
    if (err.statusCode === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return sendMenu(groupId, retry + 1);
    }
    console.error("發送選單失敗:", err.message);
  }
};

// 健康檢查
app.get("/", (req, res) => res.send("OK"));
app.get("/ping", (req, res) => res.send("pong"));

// 自我 ping（避免 Render 睡眠）
setInterval(() => {
  https.get(process.env.PING_URL, res => {
    console.log("📡 PING", res.statusCode);
  }).on("error", e => {
    console.error("PING 失敗", e.message);
  });
}, 10 * 60 * 1000);

// 啟動服務
app.listen(PORT, async () => {
  await loadLang();
  console.log(`🚀 服務已啟動，監聽於 ${PORT}`);
});
