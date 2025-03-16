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

// 發送語言選擇選單
async function sendLanguageSelection(groupId) {
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
    await lineClient.pushMessage(groupId, flexMessage);
    console.log("Language selection sent successfully");
  } catch (error) {
    console.error("Failed to send language selection:", error.message);
  }
}

// 保持伺服器活躍的路由
app.get("/ping", (req, res) => {
  console.log("Received ping request");
  res.send("Server is alive!");
});

// 定時任務，保持伺服器活躍
cron.schedule("*/5 * * * *", async () => {
  try {
    await axios.get("https://line-bot-project-a0bs.onrender.com/ping");
    console.log("Ping sent to keep server alive");
  } catch (error) {
    console.error("Error in keep-alive ping:", error.message);
  }
});

// Webhook 處理
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  console.log("Received webhook events:", JSON.stringify(events, null, 2));

  try {
    await Promise.all(
      events.map(async (event) => {
        if (event.replyToken && processedReplyTokens.has(event.replyToken)) {
          console.log("Skipping duplicate replyToken:", event.replyToken);
          return;
        }
        if (event.replyToken) processedReplyTokens.add(event.replyToken);

        const groupId = event.source.groupId;

        // 處理加入群組事件
        if (event.type === "join") {
          console.log(`Bot joined group: ${groupId}`);
          await lineClient.pushMessage(groupId, {
            type: "text",
            text: "歡迎使用翻譯機器人！請選擇翻譯語言。\n隨時輸入「!選單」或「!設定」可重新顯示選單。",
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
              languages.delete("no-translate");
              languages.add(lang);
            }
            await sendLanguageSelection(groupId);
          } else if (action === "confirm" && selectedGroupId === groupId) {
            await lineClient.pushMessage(groupId, {
              type: "text",
              text: "語言選擇已確認！隨時輸入「!選單」或「!設定」可重新顯示選單。",
            });
            await saveGroupLanguages();
          }
          return;
        }

        // 處理訊息事件
        if (event.type === "message" && event.message.type === "text") {
          const userMessage = event.message.text;
          const replyToken = event.replyToken;
          const startTime = Date.now();

          // 檢查是否為重新顯示選單的指令
          if (userMessage === "!選單" || userMessage === "!設定") {
            await sendLanguageSelection(groupId);
            return;
          }

          // 獲取群組選擇的語言
          const selectedLanguages = groupLanguages.get(groupId) || new Set();

          // 檢查是否已選擇語言
          if (selectedLanguages.size === 0) {
            await lineClient.replyMessage(replyToken, {
              type: "text",
              text: "請先選擇翻譯語言！隨時輸入「!選單」或「!設定」可重新顯示選單。",
            });
            await sendLanguageSelection(groupId);
            return;
          }

          // 偵測訊息語言
          const detectedLang = await detectLanguageWithDeepSeek(userMessage);

          let replyText = "";

          if (detectedLang === "zh-TW" || detectedLang === "zh") {
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
            const translatedText = await translateWithDeepSeek(userMessage, "繁體中文");
            replyText = `【繁體中文】${translatedText}`;
          }

          if (replyText) {
            console.log(`Response time: ${Date.now() - startTime}ms`);
            await lineClient.replyMessage(replyToken, { type: "text", text: replyText.trim() });
          }
        }
      })
    );
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error.message);
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
            content: "請識別以下文字的語言，並
