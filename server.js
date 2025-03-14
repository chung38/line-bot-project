require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Client } = require("@line/bot-sdk");
const fs = require("fs").promises;
const cron = require("node-cron");

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

// 群組語言追蹤
const groupLanguages = new Map(); // groupId -> Set of languages
const groupSettings = new Map(); // groupId -> { selected: boolean }

const STORAGE_FILE = "groupLanguages.json";

// 載入群組語言資料
async function loadGroupLanguages() {
  try {
    const data = await fs.readFile(STORAGE_FILE, "utf8");
    const parsedData = JSON.parse(data);
    for (const [groupId, languages] of Object.entries(parsedData)) {
      groupLanguages.set(groupId, new Set(languages));
      groupSettings.set(groupId, { selected: true }); // 假設已選擇
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

// 測試路由
app.get("/ping", (req, res) => {
  console.log("Received ping request");
  res.send("Server is alive!");
});

// 定時任務，保持伺服器活躍
cron.schedule("*/5 * * * *", async () => {
  try {
    await axios.get("http://localhost:3000/ping");
    console.log("Ping sent to keep server alive");
  } catch (error) {
    console.error("Error in keep-alive ping:", error.message);
  }
});

// 發送語言選擇選單
async function sendLanguageSelection(groupId, replyToken) {
  const selectedLanguages = groupLanguages.get(groupId) || new Set();
  const flexMessage = {
    type: "flex",
    altText: "請選擇語言",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [{ type: "text", text: "選擇翻譯語言", weight: "bold", size: "xl", color: "#ffffff" }],
        backgroundColor: "#1DB446",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "目前選擇：" + (selectedLanguages.size > 0 ? Array.from(selectedLanguages).map(lang => languageNames[lang]).join(", ") : "無"),
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
            contents: targetLanguages.map(lang => ({
              type: "button",
              action: {
                type: "postback",
                label: languageNames[lang],
                data: `action=selectLanguage&groupId=${groupId}&language=${lang}`,
              },
              style: selectedLanguages.has(lang) ? "primary" : "secondary",
              margin: "sm",
            })),
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
              data: `action=confirmSelection&groupId=${groupId}`,
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
    await lineClient.replyMessage(replyToken, flexMessage);
  } catch (error) {
    console.error("Failed to send language selection:", error.message);
  }
}

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

        // 處理加入群組事件
        if (event.type === "join") {
          const groupId = event.source.groupId;
          console.log(`Bot joined group: ${groupId}`);
          groupSettings.set(groupId, { selected: false }); // 初始未選擇
          await lineClient.pushMessage(groupId, {
            type: "text",
            text: "歡迎使用翻譯機器人！請選擇翻譯語言。",
          });
          await sendLanguageSelection(groupId, null); // 推送選單
          return;
        }

        // 處理訊息事件
        if (event.type === "message" && event.message.type === "text") {
          const groupId = event.source.groupId;
          const userMessage = event.message.text;
          const replyToken = event.replyToken;

          console.log(`Processing message from group ${groupId}: ${userMessage}`);

          // 檢查是否已選擇語言
          const settings = groupSettings.get(groupId) || { selected: false };
          if (!settings.selected) {
            console.log(`Group ${groupId} has not selected languages yet.`);
            await lineClient.replyMessage(replyToken, {
              type: "text",
              text: "請先選擇翻譯語言！",
            });
            await sendLanguageSelection(groupId, replyToken);
            return;
          }

          // 偵測語言
          console.log("Starting language detection...");
          const detectedLang = await detectLanguageWithDeepSeek(userMessage);
          if (!detectedLang) {
            console.log("Language detection failed for message:", userMessage);
            await lineClient.replyMessage(replyToken, {
              type: "text",
              text: "無法偵測語言，請稍後再試。",
            });
            return;
          }
          console.log(`Detected language: ${detectedLang}`);

          // 初始化或獲取群組語言集合
          if (!groupLanguages.has(groupId)) {
            groupLanguages.set(groupId, new Set());
          }
          const languages = groupLanguages.get(groupId);

          // 記錄該語言（僅用於偵測，不影響選擇）
          if (targetLanguages.includes(detectedLang) || detectedLang === "zh-TW" || detectedLang === "zh") {
            languages.add(detectedLang);
          }

          // 準備翻譯回覆
          let replyText = "";
          console.log("Starting translation process...");

          // 如果是目標語言，翻譯成繁體中文
          if (targetLanguages.includes(detectedLang)) {
            console.log(`Translating from ${detectedLang} to 繁體中文...`);
            const translatedText = await translateWithDeepSeek(userMessage, "繁體中文");
            replyText += `【繁體中文】${translatedText}\n`;
            console.log(`Translation to 繁體中文: ${translatedText}`);
          }

          // 如果是繁體中文，根據選擇的語言翻譯（排除繁體中文）
          if (detectedLang === "zh-TW" || detectedLang === "zh") {
            const selectedLangs = new Set(languages); // 使用選擇的語言
            const translations = await Promise.all(
              Array.from(selectedLangs).map(async (lang) => {
                if (lang !== "zh-TW" && lang !== "zh" && targetLanguages.includes(lang)) {
                  const targetLang = languageNames[lang];
                  console.log(`Translating to ${targetLang}...`);
                  const translatedText = await translateWithDeepSeek(userMessage, targetLang);
                  console.log(`Translation to ${targetLang}: ${translatedText}`);
                  return `【${languageNames[lang]}】${translatedText}`;
                }
                return null;
              })
            );
            const filteredTranslations = translations.filter((t) => t !== null);
            if (filteredTranslations.length > 0) {
              replyText += filteredTranslations.join("\n");
            } else {
              console.log("No selected languages to translate into.");
            }
          }

          // 發送回覆
          if (replyText) {
            console.log("Sending reply:", replyText.trim());
            await lineClient.replyMessage(replyToken, {
              type: "text",
              text: replyText.trim(),
            });
          } else {
            console.log("No reply needed for this message.");
          }
        }

        // 處理 Postback 事件
        if (event.type === "postback") {
          const data = event.postback.data;
          const params = new URLSearchParams(data);
          const action = params.get("action");
          const groupId = params.get("groupId");

          if (action === "selectLanguage") {
            const lang = params.get("language");
            if (!groupLanguages.has(groupId)) {
              groupLanguages.set(groupId, new Set());
            }
            const languages = groupLanguages.get(groupId);
            languages.add(lang);
            console.log(`Selected language ${lang} for group ${groupId}`);
            await sendLanguageSelection(groupId, event.replyToken); // 更新選單
            await saveGroupLanguages(); // 儲存選擇
          } else if (action === "confirmSelection") {
            groupSettings.set(groupId, { selected: true });
            console.log(`Confirmed language selection for group ${groupId}`);
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: "語言選擇完成！現在開始翻譯。",
            });
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
        timeout: 10000,
      }
    );

    const detectedLang = response.data.choices[0].message.content.trim();
    return ["th", "en", "vi", "id", "zh-TW", "zh"].includes(detectedLang)
      ? detectedLang
      : null;
  } catch (error) {
    console.error("Language detection error:", error.message);
    return null;
  }
}

// 使用 DeepSeek API 進行翻譯
async function translateWithDeepSeek(text, targetLang) {
  const cacheKey = `${text}-${targetLang}`;
  if (translationCache.has(cacheKey)) {
    console.log(`Cache hit for ${cacheKey}`);
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
        timeout: 10000,
      }
    );

    const result = response.data.choices[0].message.content.trim();
    translationCache.set(cacheKey, result);
    console.log(`Cached translation for ${cacheKey}: ${result}`);
    return result;
  } catch (error) {
    console.error("Translation error:", error.message);
    if (error.response && error.response.data) {
      console.error("DeepSeek API error details:", error.response.data);
    }
    return "翻譯失敗，請稍後再試";
  }
}

// 啟動伺服器
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 伺服器正在運行，埠號：${port}`));
