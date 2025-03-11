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

// 臨時設定（用於選擇過程）
const tempSettings = {};

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

          if (userMessage === "更改設定" || userMessage === "查看設定") {
            await sendSettingScreen(groupId, replyToken);
            return;
          }

          if (!groupSettings[groupId] || !groupSettings[groupId].targetLang || !groupSettings[groupId].industry) {
            await lineClient.replyMessage(replyToken, {
              type: "text",
              text: "請先完成產業類別和翻譯語言的設定！",
            });
            return;
          }

          if (groupSettings[groupId].translate === "off") {
            await lineClient.replyMessage(replyToken, {
              type: "text",
              text: userMessage,
            });
            return;
          }

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

        // 處理 Postback 事件
        if (event.type === "postback") {
          const data = event.postback.data;
          const params = new URLSearchParams(data);
          const action = params.get("action");
          const groupId = params.get("groupId");

          if (action === "startSetting") {
            tempSettings[groupId] = {}; // 初始化臨時設定
            await sendSettingScreen(groupId, event.replyToken);
          } else if (action === "selectIndustry") {
            const industry = params.get("industry");
            tempSettings[groupId] = tempSettings[groupId] || {};
            tempSettings[groupId].industry = industry;
            // 不回覆新畫面，僅記錄選擇
            console.log("Industry selected:", tempSettings[groupId]);
          } else if (action === "selectLanguage") {
            const language = params.get("language");
            tempSettings[groupId] = tempSettings[groupId] || {};
            tempSettings[groupId].targetLang = language;
            // 不回覆新畫面，僅記錄選擇
            console.log("Language selected:", tempSettings[groupId]);
          } else if (action === "confirmSetting") {
            if (!tempSettings[groupId] || !tempSettings[groupId].industry || !tempSettings[groupId].targetLang) {
              await lineClient.replyMessage(event.replyToken, {
                type: "text",
                text: "請先選擇產業類別和翻譯語言！",
              });
              return;
            }
            groupSettings[groupId] = {
              industry: tempSettings[groupId].industry,
              targetLang: tempSettings[groupId].targetLang,
              translate: tempSettings[groupId].targetLang === "不翻譯" ? "off" : "on",
            };
            delete tempSettings[groupId]; // 清除臨時設定
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: `設定完成！\n產業類別：${groupSettings[groupId].industry}\n翻譯語言：${groupSettings[groupId].targetLang}`,
            });
            console.log("Group settings updated:", groupSettings[groupId]);
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

// 發送歡迎訊息和選單
async function sendWelcomeMessage(groupId) {
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
              type: "postback",
              label: "開始設定",
              data: `action=startSetting&groupId=${groupId}`,
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

// 發送整合的設定畫面
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
            text: "產業類別：",
            weight: "bold",
            size: "md",
            margin: "md",
          },
          {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "button", action: { type: "postback", label: "玻璃業", data: `action=selectIndustry&groupId=${groupId}&industry=玻璃業` }, style: "secondary", margin: "sm" },
              { type: "button", action: { type: "postback", label: "紡織業", data: `action=selectIndustry&groupId=${groupId}&industry=紡織業` }, style: "secondary", margin: "sm" },
              { type: "button", action: { type: "postback", label: "CNC", data: `action=selectIndustry&groupId=${groupId}&industry=CNC` }, style: "secondary", margin: "sm" },
              { type: "button", action: { type: "postback", label: "畜牧業", data: `action=selectIndustry&groupId=${groupId}&industry=畜牧業` }, style: "secondary", margin: "sm" },
              { type: "button", action: { type: "postback", label: "農業", data: `action=selectIndustry&groupId=${groupId}&industry=農業` }, style: "secondary", margin: "sm" },
              { type: "button", action: { type: "postback", label: "一般傳產", data: `action=selectIndustry&groupId=${groupId}&industry=一般傳產` }, style: "secondary", margin: "sm" },
            ],
          },
          {
            type: "text",
            text: "翻譯語言：",
            weight: "bold",
            size: "md",
            margin: "md",
          },
          {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "button", action: { type: "postback", label: "繁體中文", data: `action=selectLanguage&groupId=${groupId}&language=繁體中文` }, style: "secondary", margin: "sm" },
              { type: "button", action: { type: "postback", label: "英文", data: `action=selectLanguage&groupId=${groupId}&language=英文` }, style: "secondary", margin: "sm" },
              { type: "button", action: { type: "postback", label: "越南語", data: `action=selectLanguage&groupId=${groupId}&language=越南語` }, style: "secondary", margin: "sm" },
              { type: "button", action: { type: "postback", label: "泰國語", data: `action=selectLanguage&groupId=${groupId}&language=泰國語` }, style: "secondary", margin: "sm" },
              { type: "button", action: { type: "postback", label: "印尼語", data: `action=selectLanguage&groupId=${groupId}&language=印尼語` }, style: "secondary", margin: "sm" },
              { type: "button", action: { type: "postback", label: "不翻譯", data: `action=selectLanguage&groupId=${groupId}&language=不翻譯` }, style: "secondary", margin: "sm" },
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
              data: `action=confirmSetting&groupId=${groupId}`,
            },
            style: "primary",
            color: "#1DB446",
          },
          {
            type: "text",
            text: "請選擇產業類別和語言後點擊確認。",
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
