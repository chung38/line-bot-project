require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Client } = require("@line/bot-sdk");

const app = express();
app.use(express.json());

// 🔹 LINE Messaging API 設定
const lineClient = new Client({
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET,
});

// 🔹 DeepSeek API Key
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// 🔹 用戶語言 & 群組產業設定
const userSettings = {};
const groupIndustrySettings = {};

// 🔹 處理用戶發送的訊息
app.post("/webhook", async (req, res) => {
  const events = req.body.events;

  try {
    // 處理每個事件
    await Promise.all(
      events.map(async (event) => {
        const userId = event.source.userId;

        // 🟢 確認是文字訊息且有 userId
        if (
          event.type !== "message" ||
          event.message.type !== "text" ||
          !userId
        ) {
          return; // 非文字訊息或無 userId，直接返回
        }

        const userMessage = event.message.text;

        // 🟡 檢查用戶語言設定
        if (!userSettings[userId] || userSettings[userId].target === "off") {
          // 如果沒有設定或關閉翻譯，直接回覆原始訊息
          await lineClient.replyMessage(event.replyToken, {
            type: "text",
            text: userMessage,
          });
          return;
        }

        // 🟡 翻譯訊息
        const translatedText = await translateWithDeepSeek(
          userMessage,
          userSettings[userId].target
        );

        // 🟡 回覆翻譯結果
        await lineClient.replyMessage(event.replyToken, {
          type: "text",
          text: `【${userSettings[userId].target}】${translatedText}`, // 修正語法，使用模板字面值
        });
      })
    );

    res.sendStatus(200); // 所有事件處理完成，回應 200
  } catch (error) {
    console.error("Webhook 處理錯誤：", error);
    res.sendStatus(500); // 發生錯誤時回應 500
  }
});

// 🔹 DeepSeek 翻譯 API
async function translateWithDeepSeek(text, targetLang) {
  const apiUrl = "https://api.deepseek.com/v1/chat/completions";

  try {
    const response = await axios.post(
      apiUrl,
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: `請將以下內容翻譯成 ${targetLang}：`, // 修正為模板字面值
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
    console.error("翻譯 API 錯誤：", error.response?.data || error.message);
    return "翻譯失敗，請稍後再試";
  }
}

// 🔹 啟動伺服器
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));