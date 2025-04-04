import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import cron from "node-cron";
import fs from "fs/promises";
import LRUCache from "lru-cache";

const app = express();
const PORT = process.env.PORT || 10000;

// 環境變數檢查
if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
  console.error("❌ 環境變數未設定！請確認 LINE_CHANNEL_ACCESS_TOKEN 和 LINE_CHANNEL_SECRET 是否正確！");
  process.exit(1);
}

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);

// 這裡不設定全域 bodyParser 以避免干擾 LINE middleware

// 範例：使用 raw body parser 僅對 /webhook 路由使用
app.post("/webhook", bodyParser.raw({ type: "application/json" }), middleware(config), async (req, res) => {
  try {
    const events = req.body ? JSON.parse(req.body.toString()) : [];
    console.log("Received events:", events);
    // 在此處處理事件，例如 join、message、postback 等
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook 處理錯誤:", error);
    res.sendStatus(500);
  }
});

// 其他路由可以正常使用 express.json() 若需要
app.use("/api", express.json(), (req, res) => {
  res.json({ message: "Hello API" });
});

// 以下為額外的功能範例：當機器人加入群組後發送語言選單

const rateLimit = {};
const RATE_LIMIT_TIME = 60000; // 60 秒內只發送一次

const canSendMessage = (groupId) => {
  const now = Date.now();
  if (!rateLimit[groupId] || now - rateLimit[groupId] > RATE_LIMIT_TIME) {
    rateLimit[groupId] = now;
    return true;
  }
  return false;
};

const sendLanguageMenu = async (groupId, retryCount = 0) => {
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
          { type: "text", text: "請選擇語言" },
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
    if (error.statusCode === 429 && retryCount < 3) {
      const waitTime = (retryCount + 1) * 5000;
      console.warn(`⚠️ LINE API 429錯誤，等待 ${waitTime / 1000} 秒後重試...`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return sendLanguageMenu(groupId, retryCount + 1);
    }
    console.error("❌ 發送語言選單失敗:", error);
  }
};

app.post("/join", bodyParser.raw({ type: "application/json" }), middleware(config), async (req, res) => {
  try {
    const events = req.body ? JSON.parse(req.body.toString()) : [];
    for (const event of events) {
      if (event.type === "join" && event.source.type === "group") {
        const groupId = event.source.groupId;
        console.log("Bot joined group:", groupId);
        await new Promise((resolve) => setTimeout(resolve, 10000)); // 延遲 10 秒
        await sendLanguageMenu(groupId);
      }
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("Join 事件處理錯誤:", error);
    res.sendStatus(500);
  }
});

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`🚀 伺服器運行中，端口：${PORT}`);
});
