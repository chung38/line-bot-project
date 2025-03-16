require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Client } = require("@line/bot-sdk");
const cron = require("node-cron");
const fs = require("fs").promises;

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
const groupLanguages = new Map();

// 翻譯結果快取
const translationCache = new Map();
const languageDetectionCache = new Map(); // 群組層級的語言偵測快取
setInterval(() => translationCache.clear(), 24 * 60 * 60 * 1000); // 每天清除快取

// 已處理的 replyToken 集合
const processedReplyTokens = new Set();

// 支援的語言
const supportedLanguages = ["en", "th", "vi", "id"];

// 語言名稱對應表
const languageNames = {
  en: "英語",
  th: "泰語",
  vi: "越語",
  id: "印尼語",
  "zh-TW": "繁體中文",
};

const STORAGE_FILE = "groupLanguages.json";

// 載入群組語言資料（僅在啟動時執行）
async function loadGroupLanguages() {
  const startTime = Date.now();
  try {
    const data = await fs.readFile(STORAGE_FILE, "utf8");
    const parsedData = JSON.parse(data);
    for (const [groupId, languages] of Object.entries(parsedData)) {
      groupLanguages.set(groupId, new Set(languages));
    }
    console.log(`Loaded group languages in ${Date.now() - startTime}ms:`, parsedData);
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
  const startTime = Date.now();
  try {
    const dataToSave = {};
    for (const [groupId, languages] of groupLanguages.entries()) {
      dataToSave[groupId] = Array.from(languages);
    }
    await fs.writeFile(STORAGE_FILE, JSON.stringify(dataToSave, null, 2));
    console.log(`Saved group languages in ${Date.now() - startTime}ms`);
  } catch (error) {
    console.error("Error saving group languages:", error.message);
  }
}

// 啟動時載入資料
loadGroupLanguages();

// 發送語言選擇選單
async function sendLanguageSelection(groupId) {
  const startTime = Date.now();
  const selectedLanguages = groupLanguages.get(groupId) || new Set();
  const flexMessage = {
    type: "flex",
    altText: "請選擇翻譯語言",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "選擇翻譯語言", weight: "bold", size: "xl", color: "#ffffff" },
        ],
        backgroundColor: "#1DB446",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "目前選擇：" + (selectedLanguages.size > 0 ? Array.from(selectedLanguages).map(lang => lang === "no-translate" ? "不翻譯" : languageNames[lang]).join(", ") : "無"),
            size: "sm",
            color: "#888888",
            margin: "md",
          },
          {
            type: "separator",
            margin: "md",
          },
          {
            type: "text",
            text: "請複選語言：",
            weight: "bold",
            size: "md",
            margin: "md",
          },
          {
            type: "box",
            layout: "vertical",
            contents: [
              ...supportedLanguages.map(lang => ({
                type: "button",
                action: {
                  type: "postback",
                  label: languageNames[lang],
                  data: `action=select&lang=${lang}&groupId=${groupId}`,
                },
                style: selectedLanguages.has(lang) ? "primary" : "secondary",
                margin: "sm",
              })),
              {
                type: "button",
                action: {
                  type: "postback",
                  label: "不翻譯",
                  data: `action=select&lang=no-translate&groupId=${groupId}`,
                },
                style: selectedLanguages.has("no-translate") ? "primary" : "secondary",
                margin: "sm",
              },
            ],
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: {
              type: "postback",
              label: "確認",
              data: `action=confirm&groupId=${groupId}`,
            },
            style: "primary",
            color: "#1DB446",
            margin: "sm",
          },
          {
            type: "text",
            text: "選擇語言後點擊「確認」開始翻譯。",
            size: "xs",
            color: "#888888",
            wrap: true,
            margin: "sm",
          },
        ],
      },
    },
  };
  try {
    console.log(`Sending language selection to group ${groupId}`);
    await withRetry(() => lineClient.pushMessage(groupId, flexMessage));
    console.log(`Sent language selection in ${Date.now() - startTime}ms`);
  } catch (error) {
    console.error("Failed to send language selection:", error.message, "Status:", error.statusCode || "N/A", "Headers:", error.headers || "N/A", "Details:", error.stack);
    throw error;
  }
}

// 保持伺服器活躍的路由
app.get("/ping", (req, res) => res.send("伺服器活躍！"));

// 定時任務，保持伺服器活躍
cron.schedule("* * * * *", async () => {
  try {
    await axios.get("https://line-bot-project-a0bs.onrender.com/ping"); // 請替換為你的實際 Render URL
    console.log("Ping 成功");
  } catch (error) {
    console.error("Ping 錯誤:", error.message, "Status:", error.response?.status || "N/A");
  }
});

// 按句子分割訊息
function splitSentences(text) {
  const sentences = text.split(/(?<=[。！？])/).filter(sentence => sentence.trim().length > 0);
  return sentences.map(sentence => sentence.trim());
}

// 帶有重試的 API 請求
async function withRetry(fn, maxRetries = 3, baseDelay = 10000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      const status = error.statusCode || error.response?.status || "N/A";
      const headers = error.headers || error.response?.headers || "N/A";
      if (status === 429) {
        const retryAfter = parseInt(headers?.["retry-after"]) || (baseDelay / 1000);
        console.warn(`速率限制觸發，將在 ${retryAfter} 秒後重試（嘗試 ${i + 1}/${maxRetries}）`, headers);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      } else {
        throw error;
      }
    }
  }
  throw new Error("達到最大重試次數");
}

// Webhook 處理
app.post("/webhook", async (req, res) => {
  // 添加 10 秒延遲，確保伺服器準備好
  await new Promise(resolve => setTimeout(resolve, 10000));

  const events = req.body.events;

  try {
    await Promise.all(
      events.map(async (event) => {
        const startTime = Date.now();
        if (event.replyToken && processedReplyTokens.has(event.replyToken)) {
          console.log("Skipping duplicate replyToken:", event.replyToken);
          return;
        }
        if (event.replyToken) processedReplyTokens.add(event.replyToken);

        const groupId = event.source.groupId;

        // 處理加入群組事件
        if (event.type === "join") {
          console.log(`Bot joined group: ${groupId}`);
          return; // 不發送自動訊息，等待用戶手動觸發
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
              languages.delete("no-translate");
              languages.add(lang);
            }
            await sendLanguageSelection(groupId);
          } else if (action === "confirm" && selectedGroupId === groupId) {
            await withRetry(() =>
              lineClient.pushMessage(groupId, {
                type: "text",
                text: "語言選擇已確認！隨時輸入「!選單」或「!設定」可重新顯示選單。",
              })
            );
            await saveGroupLanguages();
          }
          return;
        }

        // 處理訊息事件
        if (event.type === "message" && event.message.type === "text") {
          const userMessage = event.message.text;
          const replyToken = event.replyToken;

          // 檢查是否為重新顯示選單的指令
          if (userMessage === "!選單" || userMessage === "!設定") {
            await sendLanguageSelection(groupId);
            return;
          }

          // 獲取群組選擇的語言
          const selectedLanguages = groupLanguages.get(groupId) || new Set();

          // 檢查是否已選擇並確認語言
          if (selectedLanguages.size === 0 || selectedLanguages.has("no-translate")) {
            await withRetry(() =>
              lineClient.replyMessage(replyToken, {
                type: "text",
                text: "請先選擇並確認翻譯語言！請輸入「!選單」或「!設定」選擇語言。",
              })
            );
            return;
          }

          // 按句子分割訊息
          const sentences = splitSentences(userMessage);

          // 使用群組層級的語言偵測快取
          const detectStart = Date.now();
          let detectedLang = languageDetectionCache.get(groupId);
          if (!detectedLang) {
            detectedLang = await withRetry(() => detectLanguageWithDeepSeek(userMessage));
            languageDetectionCache.set(groupId, detectedLang);
            console.log(`Language detection took ${Date.now() - detectStart}ms`);
          }

          let replyText = "";

          if (detectedLang === "zh-TW" || detectedLang === "zh") {
            const translationStart = Date.now();
            const translations = [];
            for (const sentence of sentences) {
              // 添加原始句子
              translations.push(sentence);
              // 為每個句子翻譯成選擇的語言
              const sentenceTranslations = await Promise.all(
                Array.from(selectedLanguages).map(async (lang) => {
                  const translatedText = await withRetry(() => translateWithDeepSeek(sentence, languageNames[lang]));
                  return `【${languageNames[lang]}】${translatedText}`;
                })
              );
              translations.push(...sentenceTranslations);
            }
            console.log(`Translations took ${Date.now() - translationStart}ms`);
            replyText = translations.join("\n");
          } else if (supportedLanguages.includes(detectedLang)) {
            const translationStart = Date.now();
            const translations = [];
            for (const sentence of sentences) {
              // 添加原始句子
              translations.push(sentence);
              // 翻譯成繁體中文
              const translatedText = await withRetry(() => translateWithDeepSeek(sentence, "繁體中文"));
              translations.push(translatedText); // 不顯示【繁體中文】標籤
            }
            console.log(`Translation to zh-TW took ${Date.now() - translationStart}ms`);
            replyText = translations.join("\n");
          }

          if (replyText) {
            const replyStart = Date.now();
            await withRetry(() => lineClient.replyMessage(replyToken, { type: "text", text: replyText.trim() }));
            console.log(`Reply sent in ${Date.now() - replyStart}ms`);
            console.log(`Total response time: ${Date.now() - startTime}ms`);
          }
        }
      })
    );
    res.sendStatus(200);
  } catch (error) {
    const status = error.statusCode || error.response?.status || "N/A";
    const headers = error.headers || error.response?.headers || "N/A";
    const details = error.stack || error.message;
    console.error("Webhook error:", error.message, "Status:", status, "Headers:", headers, "Details:", details);
    res.sendStatus(500);
  }
});

// 使用 DeepSeek API 偵測語言
async function detectLanguageWithDeepSeek(text) {
  const apiUrl = "https://api.deepseek.com/v1/chat/completions";
  return withRetry(() =>
    axios.post(
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
    ).then(response => response.data.choices[0].message.content.trim())
  );
}

// 使用 DeepSeek API 進行翻譯
async function translateWithDeepSeek(text, targetLang) {
  const cacheKey = `${text}-${targetLang}`;
  if (translationCache.has(cacheKey)) {
    console.log(`Cache hit for ${cacheKey}`);
    return translationCache.get(cacheKey);
  }

  const apiUrl = "https://api.deepseek.com/v1/chat/completions";
  return withRetry(() =>
    axios.post(
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
    ).then(response => {
      const result = response.data.choices[0].message.content.trim();
      translationCache.set(cacheKey, result);
      console.log(`Cached translation for ${cacheKey}: ${result}`);
      return result;
    })
  );
}

// 啟動伺服器
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`🚀 伺服器正在運行，埠號：${port}`);
  if (groupLanguages.size === 0) {
    console.log("Warning: No group languages loaded. Check storage file or set languages manually.");
  }
});
