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

const groupSettings = {};

app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  console.log("Received events:", JSON.stringify(events, null, 2));

  try {
    await Promise.all(
      events.map(async (event) => {
        if (event.type === "join") {
          const groupId = event.source.groupId;
          console.log("Bot joined group:", groupId);
          await sendWelcomeMessage(groupId);
          return;
        }

        if (event.type === "postback") {
          console.log("Postback data:", event.postback.data);
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
  console.log("Sending industry menu to:", groupId);
  await lineClient.pushMessage(groupId, flexMessage);
}

async function detectGroupMemberLanguages(groupId) {
  // 假設實現正確，這裡簡化為返回固定值
  return ["繁體中文", "英文"];
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
        ],
      },
    },
  };
  await lineClient.pushMessage(groupId, flexMessage);
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 伺服器正在運行，埠號：${port}`));
