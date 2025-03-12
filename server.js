require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Client } = require("@line/bot-sdk");

const app = express();
app.use(express.json());

// LINE Messaging API 設定
const lineClient = new Client({
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET,
});

// DeepSeek API Key
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// 群組設定（產業類別和翻譯語言）
const groupSettings = {};

// 翻譯結果快取
const translationCache = new Map();

// 已處理的 replyToken 集合
const processedReplyTokens = new Set();

// Webhook 處理
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  console.log("Received events:", JSON.stringify(events, null, 2));

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
          console.log("Bot joined group:", groupId);
          await sendWelcomeMessage(groupId);
          return;
        }

        // 處理訊息事件
        if (event.type === "message" && event.message.type === "text") {
          const groupId = event.source.groupId;
          const userMessage = event.message.text;
          const replyToken = event.replyToken;

          // 觸發設定選單
          if (userMessage === "更改設定" || userMessage === "查看設定") {
            console.log("Triggering setting screen for group:", groupId);
            await sendSettingScreen(groupId, replyToken);
            return;
          }

          // 檢查是否已完成設定
          if (!groupSettings[groupId] || !groupSettings[groupId].targetLang || !groupSettings[groupId].industry) {
            await lineClient.replyMessage(replyToken, {
              type: "text",
              text: "請先完成產業類別和翻譯語言的設定！",
            });
            return;
          }

          // 如果翻譯功能關閉，直接回覆原始訊息
          if (groupSettings[groupId].translate === "off") {
            await lineClient.replyMessage(replyToken, {
              type: "text",
              text: userMessage,
            });
            return;
          }

          // 進行翻譯
          const translatedText = await translateWithDeepSeek(
            userMessage,
            groupSettings[groupId].targetLang,
            groupSettings[groupId].industry
          );

          await lineClient.replyMessage(replyToken, {
            type: "text",
            text: `【${groupSettings[groupId].targetLang}】${translatedText}`,
          });
          console.log("Reply sent:", translatedText);
          return;
        }
      })
    );
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

// 發送歡迎訊息和選單
async function sendWelcomeMessage(groupId) {
  if (!groupSettings[groupId]) {
    groupSettings[groupId] = {
      industry: null,
      targetLang: null,
      translate: "off",
    };
  }
  const flexMessage = {
    type: "flex",
    altText: "歡迎使用翻譯機器人！",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "歡迎使用翻譯機器人！", weight: "bold", size: "xl" },
          { type: "text", text: "請點擊下方按鈕開始設定：", margin: "md" },
          {
            type: "button",
            action: {
              type: "uri",
              label: "開始設定",
              uri: `https://your-website.com/settings?groupId=${groupId}`, // 替換為你的網頁連結
            },
            margin: "md",
          },
        ],
      },
    },
  };
  try {
    await lineClient.pushMessage(groupId, flexMessage);
    console.log("Welcome message sent to group:", groupId);
  } catch (error) {
    console.error("Failed to send welcome message:", error);
  }
}

// 發送設定選單（開啟網頁連結）
async function sendSettingScreen(groupId, replyToken) {
  const flexMessage = {
    type: "flex",
    altText: "請選擇產業類別和翻譯語言",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [{ type: "text", text: "設定翻譯機器人", weight: "bold", size: "xl", color: "#ffffff" }],
        backgroundColor: "#1DB446",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "請點擊下方按鈕開啟設定頁面：",
            weight: "bold",
            size: "md",
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "uri",
              label: "開啟設定頁面",
              uri: `https://your-website.com/settings?groupId=${groupId}`, // 替換為你的網頁連結
            },
            style: "primary",
            margin: "md",
          },
        ],
      },
    },
  };
  try {
    await lineClient.replyMessage(replyToken, flexMessage);
    console.log("Setting screen sent to group:", groupId);
  } catch (error) {
    console.error("Failed to send setting screen:", error);
  }
}

// DeepSeek 翻譯函數（加入快取和計時器）
async function translateWithDeepSeek(text, targetLang, industry) {
  const cacheKey = `${text}-${targetLang}-${industry}`; // 快取鍵
  if (translationCache.has(cacheKey)) {
    console.log("Cache hit:", cacheKey);
    return translationCache.get(cacheKey); // 直接返回快取結果
  }

  const apiUrl = "https://api.deepseek.com/v1/chat/completions";
  const startTime = Date.now(); // 開始計時

  try {
    const response = await axios.post(
      apiUrl,
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: `你是一個專業的翻譯員，專精於 ${industry} 產業。請將以下內容翻譯成 ${targetLang}，並確保使用正確的產業術語：`,
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
    const endTime = Date.now(); // 結束計時
    console.log(`Translated "${text}" to ${targetLang} in ${endTime - startTime}ms: ${result}`);

    translationCache.set(cacheKey, result); // 將結果存入快取
    return result;
  } catch (error) {
    console.error("Translation API error:", error.response?.data || error.message);
    if (error.response?.data?.error?.message === "Insufficient Balance") {
      return "翻譯失敗：API 餘額不足，請聯繫管理員充值。";
    }
    return "翻譯失敗，請稍後再試";
  }
}

// 啟動伺服器
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 伺服器正在運行，埠號：${port}`));
