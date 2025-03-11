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

// Webhook 處理
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  console.log("Received events:", JSON.stringify(events, null, 2));

  try {
    await Promise.all(
      events.map(async (event) => {
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

          // 檢查是否為設定指令
          if (userMessage === "更改設定" || userMessage === "查看設定") {
            await sendSettingMenu(groupId);
            return;
          }

          if (!groupSettings[groupId] || !groupSettings[groupId].targetLang || !groupSettings[groupId].industry) {
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: "請先完成產業類別和翻譯語言的設定！",
            });
            return;
          }

          if (groupSettings[groupId].translate === "off") {
            await lineClient.replyMessage(event.replyToken, {
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

          await lineClient.replyMessage(event.replyToken, {
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
            await sendSettingMenu(groupId);
          } else if (action === "selectIndustry") {
            await sendIndustrySelectionMenu(groupId);
          } else if (action === "selectLanguage") {
            await sendLanguageSelectionMenu(groupId);
          } else if (action === "setIndustry") {
            const industry = params.get("industry");
            groupSettings[groupId] = groupSettings[groupId] || { translate: "on" };
            groupSettings[groupId].industry = industry;
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: `已設定產業類別為：${industry}`,
            });
            console.log("Group settings updated:", groupSettings[groupId]);
          } else if (action === "setLanguage") {
            const language = params.get("language");
            groupSettings[groupId] = groupSettings[groupId] || { translate: "on" };
            groupSettings[groupId].targetLang = language;
            if (language === "off" || language === "不翻譯") groupSettings[groupId].translate = "off";
            else groupSettings[groupId].translate = "on";
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: `已設定翻譯語言為：${language}`,
            });
            console.log("Group settings updated:", groupSettings[groupId]);
          } else if (action === "completeSetting") {
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: "設定已完成！",
            });
          } else if (action === "cancelTranslation") {
            groupSettings[groupId] = groupSettings[groupId] || {};
            groupSettings[groupId].translate = "off";
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: "已取消翻譯功能。",
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
  await lineClient.pushMessage(groupId, flexMessage);
  console.log("Welcome message sent to group:", groupId);
}

// 發送設定選單
async function sendSettingMenu(groupId) {
  const flexMessage = {
    type: "flex",
    altText: "請選擇產業類別和翻譯語言",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "請選擇設定項目：", weight: "bold", size: "xl" },
          {
            type: "button",
            action: {
              type: "postback",
              label: "選擇產業類別",
              data: `action=selectIndustry&groupId=${groupId}`,
            },
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "選擇翻譯語言",
              data: `action=selectLanguage&groupId=${groupId}`,
            },
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "取消翻譯",
              data: `action=cancelTranslation&groupId=${groupId}`,
            },
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "設定完成",
              data: `action=completeSetting&groupId=${groupId}`,
            },
            margin: "md",
          },
        ],
      },
    },
  };
  await lineClient.pushMessage(groupId, flexMessage);
  console.log("Setting menu sent to group:", groupId);
}

// 發送產業類別選單
async function sendIndustrySelectionMenu(groupId) {
  const flexMessage = {
    type: "flex",
    altText: "請選擇產業類別",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "請選擇產業類別：", weight: "bold", size: "xl" },
          {
            type: "button",
            action: {
              type: "postback",
              label: "玻璃業",
              data: `action=setIndustry&groupId=${groupId}&industry=玻璃業`,
            },
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "紡織業",
              data: `action=setIndustry&groupId=${groupId}&industry=紡織業`,
            },
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "CNC",
              data: `action=setIndustry&groupId=${groupId}&industry=CNC`,
            },
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "畜牧業",
              data: `action=setIndustry&groupId=${groupId}&industry=畜牧業`,
            },
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "農業",
              data: `action=setIndustry&groupId=${groupId}&industry=農業`,
            },
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "一般傳產",
              data: `action=setIndustry&groupId=${groupId}&industry=一般傳產`,
            },
            margin: "md",
          },
        ],
      },
    },
  };
  await lineClient.pushMessage(groupId, flexMessage);
  console.log("Industry selection menu sent to group:", groupId);
}

// 發送翻譯語言選單
async function sendLanguageSelectionMenu(groupId) {
  const languages = ["繁體中文", "英文", "越南語", "泰國語", "日語", "韓語", "不翻譯"];
  const buttons = languages.map((language) => ({
    type: "button",
    action: {
      type: "postback",
      label: language === "不翻譯" ? "不翻譯" : `翻譯成 ${language}`,
      data: `action=setLanguage&groupId=${groupId}&language=${language}`,
    },
    margin: "md",
  }));

  const flexMessage = {
    type: "flex",
    altText: "請選擇翻譯語言",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "請選擇翻譯語言：", weight: "bold", size: "xl" },
          ...buttons,
        ],
      },
    },
  };
  await lineClient.pushMessage(groupId, flexMessage);
  console.log("Language selection menu sent to group:", groupId);
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
