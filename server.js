require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Client } = require("@line/bot-sdk");
const fs = require("fs").promises; // 用於檔案操作

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

// 群組語言追蹤（改為從檔案載入）
const groupLanguages = new Map();

// 檔案路徑
const STORAGE_FILE = "groupLanguages.json";

// 載入群組語言資料
async function loadGroupLanguages() {
  try {
    const data = await fs.readFile(STORAGE_FILE, "utf8");
    const parsedData = JSON.parse(data);
    for (const [groupId, languages] of Object.entries(parsedData)) {
      groupLanguages.set(groupId, new Set(languages));
    }
    console.log("Loaded group languages:", parsedData);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("No existing group languages file found, starting fresh.");
    } else {
      console.error("Error loading group languages:", error.message);
    }
  }
}

// 儲存群組語言資料
async function saveGroupLanguages() {
  try {
    const dataToSave = {};
    for (const [groupId, languages] of groupLanguages.entries()) {
      dataToSave[groupId] = Array.from(languages);
    }
    await fs.writeFile(STORAGE_FILE, JSON.stringify(dataToSave, null, 2));
    console.log("Saved group languages:", dataToSave);
  } catch (error) {
    console.error("Error saving group languages:", error.message);
  }
}

// 啟動時載入資料
loadGroupLanguages();

// 翻譯結果快取
const translationCache = new Map();

// 已處理的 replyToken 集合
const processedReplyTokens = new Set();

// 目標語言
const targetLanguages = ["th", "en", "vi", "id"]; // 泰國語、英語、越南語、印尼語

// 語言名稱對應表
const languageNames = {
  th: "泰國語",
  en: "英語",
  vi: "越南語",
  id: "印尼語",
  "zh-TW": "繁體中文",
  zh: "繁體中文",
};

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

        // 處理加入群組事件
        if (event.type === "join") {
          const groupId = event.source.groupId;
          await lineClient.pushMessage(groupId, {
            type: "text",
            text: "歡迎使用翻譯機器人！我會自動偵測並翻譯訊息。",
          });
          return;
        }

        // 處理訊息事件
        if (event.type === "message" && event.message.type === "text") {
          const groupId = event.source.groupId;
          const userMessage = event.message.text;
          const replyToken = event.replyToken;

          // 偵測語言
          const detectedLang = await detectLanguageWithDeepSeek(userMessage);
          if (!detectedLang) {
            await lineClient.replyMessage(replyToken, {
              type: "text",
              text: "無法偵測語言，請稍後再試。",
            });
            return;
          }

          // 初始化或獲取群組語言集合
          if (!groupLanguages.has(groupId)) {
            groupLanguages.set(groupId, new Set());
          }
          const languages = groupLanguages.get(groupId);

          // 記錄該語言（Set 自動去重）
          let languagesUpdated = false;
          if (targetLanguages.includes(detectedLang) || detectedLang === "zh-TW" || detectedLang === "zh") {
            const previousSize = languages.size;
            languages.add(detectedLang);
            if (languages.size > previousSize) {
              languagesUpdated = true;
            }
          }

          // 準備翻譯回覆
          let replyText = "";

          // 如果是目標語言，翻譯成繁體中文
          if (targetLanguages.includes(detectedLang)) {
            const translatedText = await translateWithDeepSeek(userMessage, "繁體中文");
            replyText += `【繁體中文】${translatedText}\n`;
          }

          // 如果是繁體中文，根據群組語言翻譯成其他語言（排除繁體中文）
          if (detectedLang === "zh-TW" || detectedLang === "zh") {
            const translations = await Promise.all(
              Array.from(languages).map(async (lang) => {
                if (lang !== "zh-TW" && lang !== "zh") { // 避免重複回覆繁體中文
                  const targetLang = languageNames[lang];
                  const translatedText = await translateWithDeepSeek(userMessage, targetLang);
                  return `【${languageNames[lang]}】${translatedText}`;
                }
                return null;
              })
            );
            const filteredTranslations = translations.filter((t) => t !== null);
            if (filteredTranslations.length > 0) {
              replyText += filteredTranslations.join("\n");
            }
          }

          // 發送回覆
          if (replyText) {
            await lineClient.replyMessage(replyToken, {
              type: "text",
              text: replyText.trim(),
            });
          }

          // 如果語言集合有更新，儲存到檔案
          if (languagesUpdated) {
            await saveGroupLanguages();
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
            content:
              "你是一個語言偵測專家。請識別以下文字的語言，並以 ISO 639-1 代碼回覆（例如：en, zh, th, vi, id）。",
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

    const detectedLang = response.data.choices[0].message.content.trim();
    return ["th", "en", "vi", "id", "zh-TW", "zh"].includes(detectedLang)
      ? detectedLang
      : null;
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
