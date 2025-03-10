require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Client } = require("@line/bot-sdk");

const app = express();
app.use(express.json());

const lineClient = new Client({
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET,
});

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const groupSettings = {};

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

          if (!groupSettings[groupId]) {
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: "請先設定產業類別和翻譯語言！",
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

          if (!groupSettings[groupId].targetLang || !groupSettings[groupId].industry) {
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: "請完成產業類別和翻譯語言的設定！",
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
          return;
        }

        // 處理 Postback 事件
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
            groupSettings[groupId] = groupSettings[groupId] || { translate: "on" };
            groupSettings[groupId].industry = industry;
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: `已設定產業類別為：${industry}`,
            });
          } else if (action === "setLanguage") {
            const language = params.get("language");
            groupSettings[groupId] = groupSettings[groupId] || { translate: "on" };
            groupSettings[groupId].targetLang = language;
            if (language === "off") groupSettings[groupId].translate = "off";
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
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

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
          { type: "text", text: "歡迎使用翻譯機器人！", weight: "bold", size: "xl" },
          { type: "text", text: "請選擇產業類別和翻譯語言：", margin: "md" },
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
        ],
      },
    },
  };
  await lineClient.pushMessage(groupId, flexMessage);
}

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
          // 其他產業按鈕...
        ],
      },
    },
  };
  await lineClient.pushMessage(groupId, flexMessage);
}

async function detectGroupMemberLanguages(groupId) {
  return ["繁體中文", "英文"]; // 簡化測試用
}

async function sendLanguageSelectionMenu(groupId, languages) {
  const buttons = languages.map((language) => ({
    type: "button",
    action: {
      type: "postback",
      label: `翻譯成 ${language}`,
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
          {
            type: "button",
            action: {
              type: "postback",
              label: "不翻譯",
              data: `action=setLanguage&groupId=${groupId}&language=off`,
            },
            margin: "md",
          },
        ],
      },
    },
  };
  await lineClient.pushMessage(groupId, flexMessage);
}

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
    const result = response.data.choices[0].message.content.trim();
    console.log(`Translated "${text}" to ${targetLang}: ${result}`);
    return result;
  } catch (error) {
    console.error("Translation API error:", error.response?.data || error.message);
    return "翻譯失敗，請稍後再試";
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 伺服器正在運行，埠號：${port}`));
