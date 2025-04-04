import "dotenv/config"; // 載入環境變數
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import axios from "axios";
import cron from "node-cron";
import fs from "fs/promises";
import LRUCache from "lru-cache";

const app = express();
const PORT = process.env.PORT || 10000;

// 檢查環境變數是否設定
if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
  console.error("❌ 環境變數未設定！請確認 LINE_CHANNEL_ACCESS_TOKEN 和 LINE_CHANNEL_SECRET 是否正確！");
  process.exit(1);
}

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);

app.use(express.json());

// 範例：簡單的 Webhook 驗證與事件處理
app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    console.log("Received events:", events);
    // 你可以在這裡處理不同類型的事件，例如 join、message、postback 等
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook 處理錯誤:", error);
    res.sendStatus(500);
  }
});

// 例如，當機器人加入群組後自動發送語言選單（這裡僅做示範）
app.post("/join", middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type === "join" && event.source.type === "group") {
        const groupId = event.source.groupId;
        console.log("Bot joined group:", groupId);
        // 延遲 10 秒再發送語言選單
        await new Promise((resolve) => setTimeout(resolve, 10000));
        await client.pushMessage(groupId, {
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
        });
      }
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("Join 事件處理錯誤:", error);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 伺服器運行中，端口：${PORT}`);
});
