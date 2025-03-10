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

// 處理加入群組事件
app.post("/webhook", async (req, res) => {
  const events = req.body.events;

  try {
    await Promise.all(
      events.map(async (event) => {
        // 處理加入群組事件
        if (event.type === "join") {
          const groupId = event.source.groupId;
          await sendWelcomeMessage(groupId);
          return;
        }

        // 處理訊息事件
        if (event.type === "message" && event.message.type === "text") {
          const groupId = event.source.groupId;
          const userMessage = event.message.text;

          // 檢查群組設定
          if (!groupSettings[groupId] || groupSettings[groupId].translate === "off") {
            // 如果不翻譯，直接回覆原始訊息
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: userMessage,
            });
            return;
          }

          // 翻譯訊息
          const translatedText = await translateWithDeepSeek(
            userMessage,
            groupSettings[groupId].targetLang,
            groupSettings[groupId].industry
          );

          // 回覆翻譯結果
          await lineClient.replyMessage(event.replyToken, {
            type: "text",
            text: `【${groupSettings[groupId].targetLang}】${translatedText}`,
          });
        }
      })
    );

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook 錯誤：", error);
    res.sendStatus(500);
  }
});

// 發送歡迎訊息和選單
async function sendWelcomeMessage(groupId) {
  const flexMessage = {
    type: "flex",
    altText: "請選擇產業類別和翻譯語言",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "歡迎使用翻譯機器人！",
            weight: "bold",
            size: "xl",
          },
          {
            type: "text",
            text: "請選擇產業類別和翻譯語言：",
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "選擇產業類別",
              data: "action=selectIndustry&groupId=" + groupId,
            },
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "選擇翻譯語言",
              data: "action=selectLanguage&groupId=" + groupId,
            },
            margin: "md",
          },
        ],
      },
    },
  };

  await lineClient.pushMessage(groupId, flexMessage);
}

// 處理 Postback 事件（用戶選擇產業類別或翻譯語言）
app.post("/webhook", async (req, res) => {
  const events = req.body.events;

  try {
    await Promise.all(
      events.map(async (event) => {
        if (event.type === "postback") {
          const data = event.postback.data;
          const params = new URLSearchParams(data);
          const action = params.get("action");
          const groupId = params.get("groupId");

          if (action === "selectIndustry") {
            await sendIndustrySelectionMenu(groupId);
          } else if (action === "selectLanguage") {
            const languages = await detectGroupMemberLanguages(groupId);
            await sendLanguageSelectionMenu(groupId, languages);
          } else if (action === "setIndustry") {
            const industry = params.get("industry");
            groupSettings[groupId] = groupSettings[groupId] || {};
            groupSettings[groupId].industry = industry;
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: `已設定產業類別為：${industry}`,
            });
          } else if (action === "setLanguage") {
            const language = params.get("language");
            groupSettings[groupId] = groupSettings[groupId] || {};
            groupSettings[groupId].targetLang = language;
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: `已設定翻譯語言為：${language}`,
            });
          }
        }
      })
    );

    res.sendStatus(200);
  } catch (error) {
    console.error("Postback 錯誤：", error);
    res.sendStatus(500);
  }
});

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
          {
            type: "text",
            text: "請選擇產業類別：",
            weight: "bold",
            size: "xl",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "玻璃業",
              data: "action=setIndustry&groupId=" + groupId + "&industry=玻璃業",
            },
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "紡織業",
              data: "action=setIndustry&groupId=" + groupId + "&industry=紡織業",
            },
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "CNC",
              data: "action=setIndustry&groupId=" + groupId + "&industry=CNC",
            },
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "畜牧業",
              data: "action=setIndustry&groupId=" + groupId + "&industry=畜牧業",
            },
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "農業",
              data: "action=setIndustry&groupId=" + groupId + "&industry=農業",
            },
            margin: "md",
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "一般傳產",
              data: "action=setIndustry&groupId=" + groupId + "&industry=一般傳產",
            },
            margin: "md",
          },
        ],
      },
    },
  };

  await lineClient.pushMessage(groupId, flexMessage);
}

// 偵測群組成員語言
async function detectGroupMemberLanguages(groupId) {
  const memberIds = await lineClient.getGroupMemberIds(groupId);
  const languages = new Set();

  for (const memberId of memberIds) {
    const profile = await lineClient.getGroupMemberProfile(groupId, memberId);
    const displayName = profile.displayName;

    // 根據顯示名稱推測語言
    if (/[\u4E00-\u9FFF]/.test(displayName)) {
      languages.add("繁體中文");
    } else if (/[\u0041-\u007A]/.test(displayName)) {
      languages.add("英文");
    } else if (/[\u1E00-\u1EFF]/.test(displayName)) {
      languages.add("越南語");
    } else if (/[\u0600-\u06FF]/.test(displayName)) {
      languages.add("印尼語");
    } else if (/[\u0E00-\u0E7F]/.test(displayName)) {
      languages.add("泰國語");
    } else if (/[\uAC00-\uD7AF]/.test(displayName)) {
      languages.add("韓國語");
    } else if (/[\u3040-\u309F\u30A0-\u30FF]/.test(displayName)) {
      languages.add("日語");
    }
  }

  return Array.from(languages);
}

// 發送翻譯語言選單
async function sendLanguageSelectionMenu(groupId, languages) {
  const buttons = languages.map((language) => ({
    type: "button",
    action: {
      type: "postback",
      label: `翻譯成 ${language}`,
      data: "action=setLanguage&groupId=" + groupId + "&language=" + language,
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
          {
            type: "text",
            text: "請選擇翻譯語言：",
            weight: "bold",
            size: "xl",
          },
          ...buttons,
          {
            type: "button",
            action: {
              type: "postback",
              label: "不翻譯",
              data: "action=setLanguage&groupId=" + groupId + "&language=off",
            },
            margin: "md",
          },
        ],
      },
    },
  };

  await lineClient.pushMessage(groupId, flexMessage);
}

// DeepSeek 翻譯函式（加入產業類別上下文）
async function translateWithDeepSeek(text, targetLang, industry) {
  const apiUrl = "https://api.deepseek.com/v1/chat/completions";

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

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error("翻譯 API 錯誤：", error.response?.data || error.message);
    return "翻譯失敗，請稍後再試";
  }
}

// 啟動伺服器
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 伺服器正在運行，埠號：${port}`));
