import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs/promises";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 10000;

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new Client(lineConfig);
const groupLanguagesFile = "./groupLanguages.json";
let groupLanguages = {};

// ================= 讀取語言設定檔 =================
const loadGroupLanguages = async () => {
  try {
    const data = await fs.readFile(groupLanguagesFile, "utf8");
    groupLanguages = JSON.parse(data);
  } catch {
    groupLanguages = {};
  }
};

const saveGroupLanguages = async () => {
  await fs.writeFile(groupLanguagesFile, JSON.stringify(groupLanguages, null, 2));
};

// ================= webhook 接收 =================
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  middleware(lineConfig),
  express.json(),
  async (req, res) => {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  }
);

// ================= 事件處理邏輯 =================
const handleEvent = async (event) => {
  const groupId = event.source?.groupId;
  const userId = event.source?.userId;

  if (event.type === "join" && event.source.type === "group") {
    sendLanguageMenu(groupId);
  }

  if (event.type === "postback") {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get("action");
    const code = params.get("code");

    if (action === "set_lang" && groupId) {
      groupLanguages[groupId] = groupLanguages[groupId] || [];

      const langs = groupLanguages[groupId];
      const index = langs.indexOf(code);
      if (index > -1) {
        langs.splice(index, 1); // 取消選擇
      } else {
        langs.push(code); // 加入語言
      }

      await saveGroupLanguages();

      const langNames = {
        en: "英文", th: "泰文", vi: "越南文", id: "印尼文"
      };

      const selected = langs.map(c => langNames[c] || c).join("、");
      const replyText = langs.length
        ? `✅ 群組語言設定已儲存：${selected}`
        : `✅ 已清除所有語言選擇`;

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: replyText
      });
    }
  }

  if (event.type === "message" && event.message.type === "text" && groupId) {
    const text = event.message.text.trim();
    const langs = groupLanguages[groupId] || [];

    if (!langs.length) return;

    // 中文 → 多語翻譯
    if (/^[\u4e00-\u9fff]/.test(text)) {
      for (const lang of langs) {
        const translated = await translateText(text, lang);
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: translated
        });
        break; // 回一個語言就好（可改為多語一起回）
      }
    }

    // 英文或選定語言 → 中文
    else {
      const detectLang = await detectLanguage(text);
      if (langs.includes(detectLang) || detectLang === "en") {
        const translated = await translateText(text, "zh");
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: translated
        });
      }
    }
  }
};

// ================= 發送語言選單 =================
const sendLanguageMenu = async (groupId) => {
  const message = {
    type: "flex",
    altText: "🌐 請選擇翻譯語言",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "🌍 請選擇翻譯語言", weight: "bold", size: "lg" },
          { type: "separator", margin: "md" },
          ...["en", "th", "vi", "id"].map(code => createButton(code))
        ]
      }
    }
  };

  try {
    await client.pushMessage(groupId, message);
    console.log(`📤 已發送語言選單至群組 ${groupId}`);
  } catch (err) {
    console.error("❌ 發送語言選單失敗:", err.message);
  }
};

const createButton = (code) => {
  const langNames = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文" };
  return {
    type: "button",
    action: {
      type: "postback",
      label: `${langNames[code]} (${code.toUpperCase()})`,
      data: `action=set_lang&code=${code}`
    },
    style: "primary",
    color: "#34B7F1"
  };
};

// ================= 翻譯功能 =================
const translateText = async (text, targetLang) => {
  try {
    const response = await axios.post("https://api.deepseek.com/chat/completions", {
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content: "你是一個翻譯員，請直接翻譯用戶的句子，不要解釋。"
        },
        {
          role: "user",
          content: `請將以下文字翻譯成 ${targetLang}：${text}`
        }
      ]
    }, {
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    return response.data.choices[0].message.content.trim();
  } catch (err) {
    console.error("❌ 翻譯失敗:", err.message);
    return "⚠️ 翻譯失敗";
  }
};

const detectLanguage = async (text) => {
  try {
    const res = await axios.post("https://libretranslate.de/detect", {
      q: text
    });
    return res.data[0]?.language || "unknown";
  } catch {
    return "unknown";
  }
};

// ================= 定時自我 PING 機制 =================
const SELF_URL = process.env.SELF_URL;
if (SELF_URL) {
  setInterval(() => {
    fetch(SELF_URL)
      .then(res => console.log(`🔁 Ping 成功 - 狀態碼: ${res.status}`))
      .catch(err => console.error("❌ Ping 失敗:", err.message));
  }, 5 * 60 * 1000); // 每 5 分鐘
} else {
  console.warn("⚠️ 尚未設定 SELF_URL，無法定時自我喚醒");
}

// ================= 啟動伺服器 =================
app.listen(PORT, async () => {
  await loadGroupLanguages();
  console.log(`🚀 服務已啟動，端口：${PORT}`);
});
