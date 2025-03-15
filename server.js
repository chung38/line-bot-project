require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Client } = require("@line/bot-sdk");

const app = express();
app.use(express.json());

// LINE Messaging API 設定
const lineConfig = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET,
};

if (!lineConfig.channelAccessToken || !lineConfig.channelSecret) {
  console.error("Error: LINE_ACCESS_TOKEN or LINE_SECRET is not set in .env");
  process.exit(1);
}

const lineClient = new Client(lineConfig);

// DeepSeek API Key
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) {
  console.error("Error: DEEPSEEK_API_KEY is not set in .env");
  process.exit(1);
}

// 群組語言選擇儲存
const groupLanguages = new Map(); // groupId -> Set of languages or "no-translate"

// 翻譯結果快取
const translationCache = new Map();

// 已處理的 replyToken 集合
const processedReplyTokens = new Set();

// 支援的語言
const supportedLanguages = ["en", "th", "vi", "id"]; // 英語、泰語、越語、印尼語

// 語言名稱對應表
const languageNames = {
  en: "英語",
  th: "泰語",
  vi: "越語",
  id: "印尼語",
  "zh-TW": "繁體中文",
};

// 發送語言選擇選單
async function sendLanguageSelection(groupId) {
  const flexMessage = {
    type: "flex",
    altText: "請選擇翻譯語言",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "請選擇翻譯語言（可複選）", weight: "bold" },
          ...supportedLanguages.map((lang) => ({
            type: "button",
            action: {
              type: "postback",
              label: languageNames[lang],
              data: `action=select&lang=${lang}&groupId=${groupId}`,
            },
          })),
          {
            type: "button",
            action: {
              type: "postback",
              label: "不翻譯",
              data: `action=select&lang=no-translate&groupId=${groupId}`,
            },
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "確認",
              data: `action=confirm&groupId=${groupId}`,
            },
          },
        ],
      },
    },
  };
  await lineClient.pushMessage(groupId, flexMessage);
}

// Webhook 處理
app.post("/webhook", async (req, res) => {
  const events = req.body.events;

  try {
    await Promise.all(
      events.map(async (event) => {
        if (event.replyToken && processedReplyTokens.has(event.replyToken)) {
          return;
        }
        if (event.replyToken) processedReplyTokens.add(event.replyToken);

        const groupId = event.source.groupId;

        // 處理加入群組事件
        if (event.type === "join") {
          await lineClient.pushMessage(groupId, {
            type: "text",
            text: "歡迎使用翻譯機器人！請選擇翻譯語言。",
          });
          await sendLanguageSelection(groupId);
          return;
        }

        // 處理 Postback 事件（語言選擇）
        if (event.type === "postback") {
          const data = new URLSearchParams(event.postback.data);
          const action = data.get("action");
          const lang = data.get("lang");
          const selectedGroupId = data.get("groupId");

          if (action === "select" && selectedGroupId === groupId) {
            if (!groupLanguages.has(groupId)) {
              groupLanguages.set(groupId, new Set());
            }
            const languages = groupLanguages.get(groupId);
            if (lang === "no-translate") {
              languages.clear();
              languages.add("no-translate");
            } else {
              languages.delete("no-translate"); // 移除「不翻譯」選項
              languages.add(lang);
            }
          } else if (action === "confirm" && selectedGroupId === groupId) {
            await lineClient.pushMessage(groupId, {
              type: "text",
              text: "語言選擇已確認！",
            });
          }
          return;
        }

        // 處理訊息事件
        if (event.type === "message" && event.message.type === "text") {
          const userMessage = event.message.text;
          const replyToken = event.replyToken;

          // 獲取群組選擇的語言
          const selectedLanguages = groupLanguages.get(groupId) || new Set();

          // 偵測訊息語言
          const detectedLang = await detectLanguageWithDeepSeek(userMessage);

          let replyText = "";

          if (detectedLang === "zh-TW" || detectedLang === "zh") {
            // 如果是中文，根據選擇的語言翻譯
            if (!selectedLanguages.has("no-translate")) {
              const translations = await Promise.all(
                Array.from(selectedLanguages).map(async (lang) => {
                  const translatedText = await translateWithDeepSeek(userMessage, languageNames[lang]);
                  return `【${languageNames[lang]}】${translatedText}`;
                })
              );
              replyText = translations.join("\n");
            }
          } else if (supportedLanguages.includes(detectedLang)) {
            // 如果是英語、泰語、越語、印尼語，翻譯成繁體中文
            const translatedText = await translateWithDeepSeek(userMessage, "繁體中文");
            replyText = `【繁體中文】${translatedText}`;
          }

          // 發送回覆
          if (replyText) {
            await lineClient.replyMessage(replyToken, {
              type: "text",
              text: replyText.trim(),
            });
          }
        }
      })
    );
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

// 使用 DeepSeek API 偵測語言
async function detectLanguageWithDeepSeek(text) {
  const apiUrl = "https://api.deepseek.com/v1/chat/completions";
  try {
    const response = await axios.post(
      apiUrl,
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: "請識別以下文字的語言，並回覆 ISO 639-1 代碼（例如 en, zh, th, vi, id）。",
          },
          { role: "user", content: text },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error("語言偵測錯誤:", error.message);
    return null;
  }
}

// 使用 DeepSeek API 進行翻譯
async function translateWithDeepSeek(text, targetLang) {
  const cacheKey = `${text}-${targetLang}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  const apiUrl = "https://api.deepseek.com/v1/chat/completions";
  try {
    const response = await axios.post(
      apiUrl,
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: `你是一個專業的翻譯員，請將以下內容翻譯成 ${targetLang}：`,
          },
          { role: "user", content: text },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const result = response.data.choices[0].message.content.trim();
    translationCache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.error("翻譯錯誤:", error.message);
    return "翻譯失敗，請稍後再試";
  }
}

// 啟動伺服器
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 伺服器正在運行，埠號：${port}`));
