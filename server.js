import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
dotenv.config();

// 環境變數檢查
if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
  console.error("❌ 環境變數未設定！請確認 LINE_CHANNEL_ACCESS_TOKEN 和 LINE_CHANNEL_SECRET 是否正確！");
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 10000;

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);

// 速率限制控制
const rateLimit = {};
const RATE_LIMIT_TIME = 60000; // 60秒內最多發送一次

const canSendMessage = (groupId) => {
  const now = Date.now();
  if (!rateLimit[groupId] || now - rateLimit[groupId] > RATE_LIMIT_TIME) {
    rateLimit[groupId] = now;
    return true;
  }
  return false;
};

// 語言選單
const sendLanguageMenu = async (groupId) => {
  if (!canSendMessage(groupId)) return;

  const message = {
    type: "flex",
    altText: "翻譯設定",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [{ type: "text", text: "🌍 翻譯設定" }],
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "✔ 已選: " },
          { type: "separator", margin: "md" },
          { type: "button", action: { type: "postback", label: "英語", data: "action=select&lang=en" }, style: "secondary" },
          { type: "button", action: { type: "postback", label: "泰語", data: "action=select&lang=th" }, style: "secondary" },
          { type: "button", action: { type: "postback", label: "越語", data: "action=select&lang=vi" }, style: "secondary" },
          { type: "button", action: { type: "postback", label: "印尼語", data: "action=select&lang=id" }, style: "secondary" },
        ],
      },
    },
  };

  try {
    await client.pushMessage(groupId, message);
    console.log("✅ 語言選單已發送到群組", groupId);
  } catch (error) {
    console.error("❌ 發送語言選單失敗:", error);
  }
};

// LINE Webhook 事件處理
app.post("/webhook", express.json(), middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.sendStatus(200))
    .catch((err) => {
      console.error("❌ Webhook 錯誤:", err);
      res.sendStatus(500);
    });
});

// 事件處理
const handleEvent = async (event) => {
  if (event.type === "join" && event.source.type === "group") {
    console.log("Bot joined group:", event.source.groupId);
    await sendLanguageMenu(event.source.groupId);
  }
};

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`🚀 伺服器運行中，端口：${PORT}`);
});
