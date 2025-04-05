import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import cron from "node-cron";
import fs from "fs/promises";
import LRUCache from "lru-cache";
import https from "node:https";

const app = express();
const PORT = process.env.PORT || 10000;

// ================= 強化配置驗證 =================
const validateConfig = () => {
  const requiredEnv = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET'];
  const missing = requiredEnv.filter(v => !process.env[v]);
  if (missing.length) {
    console.error("❌ 缺少關鍵環境變數:");
    missing.forEach(v => console.error(`   - ${v}`));
    process.exit(1);
  }
};
validateConfig();

// ================= LINE 客戶端配置 =================
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new Client(lineConfig);

// ================= 中間件設定 =================
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  middleware(lineConfig),
  express.json(),
  async (req, res) => {
    try {
      console.log("🔍 解析後的事件結構:", JSON.stringify(req.body, null, 2));
      await Promise.all(req.body.events.map(async (event) => {
        if (event.type === "join" && event.source?.type === "group") {
          const groupId = event.source.groupId;
          console.log(`🤖 新群組加入: ${groupId}`);
          sendLanguageMenu(groupId);
        } else if (event.type === "postback") {
          const data = event.postback.data;
          const params = new URLSearchParams(data);
          const action = params.get("action");
          const code = params.get("code");
          if (action === "set_lang") {
            const langNameMapping = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文" };
            const langName = langNameMapping[code] || code;
            console.log(`✅ 使用者選擇語言：${langName} (${code.toUpperCase()})`);
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: `您已選擇：${langName}`
            });
          } else {
            console.log("收到未知 postback:", data);
          }
        } else {
          console.log("📩 收到其他事件，類型：", event.type);
        }
      }));
      res.status(200).json({ status: "success" });
    } catch (error) {
      console.error("⚠️ 處理流程異常:", error);
      res.status(500).json({
        status: "error",
        code: error.code || "INTERNAL_ERROR",
        message: error.message
      });
    }
  }
);

// ================= 選單發送功能 =================
const rateLimit = {};
const RATE_LIMIT_TIME = 60000;

const canSendMessage = (groupId) => {
  const now = Date.now();
  if (!rateLimit[groupId] || now - rateLimit[groupId] > RATE_LIMIT_TIME) {
    rateLimit[groupId] = now;
    return true;
  }
  return false;
};

const sendLanguageMenu = async (groupId, retryCount = 0) => {
  if (!canSendMessage(groupId)) {
    console.log(`群組 ${groupId} 在 ${RATE_LIMIT_TIME / 1000} 秒內已發送過選單，跳過推送`);
    return;
  }

  const message = {
    type: "flex",
    altText: "語言設定選單",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "🌍 請選擇翻譯語言", weight: "bold" },
          { type: "separator", margin: "md" },
          createButton("英文", "en"),
          createButton("泰文", "th"),
          createButton("越南文", "vi"),
          createButton("印尼文", "id")
        ]
      }
    }
  };

  try {
    console.log(`📤 正在發送選單至群組 ${groupId}...`);
    await client.pushMessage(groupId, message);
    console.log("✅ 選單發送成功");
  } catch (error) {
    if (error.statusCode === 429 && retryCount < 3) {
      const waitTime = (retryCount + 1) * 5000;
      console.warn(`⚠️ LINE API 429 錯誤，等待 ${waitTime / 1000} 秒後重試發送選單...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return sendLanguageMenu(groupId, retryCount + 1);
    }
    console.error(`❌ 發送選單失敗 (${groupId}):`, error.response?.data || error.message);
  }
};

// ================= 工具函數 =================
const createButton = (label, code) => ({
  type: "button",
  action: {
    type: "postback",
    label: `${label} (${code.toUpperCase()})`,
    data: `action=set_lang&code=${code}`
  },
  style: "primary",
  color: "#34B7F1"
});

// ================= 伺服器啟動 =================
app.listen(PORT, () => {
  console.log(`🚀 服務已啟動，端口：${PORT}`);
  console.log("🛡️ 安全配置狀態：");
  console.table({
    "請求體處理": "LINE中間件 → Express.json()",
    "簽名驗證": "已啟用 ✅",
    "HTTPS支持": process.env.NODE_ENV === "production" ? "Render托管" : "開發模式",
    "環境模式": process.env.NODE_ENV || "development"
  });
});

// ================= 防止 Render 睡眠的 PING 功能 =================
const PING_INTERVAL = 10 * 60 * 1000; // 每 10 分鐘
const PING_URL = process.env.PING_URL || "https://line-bot-project-a0bs.onrender.com"; // 自行替換網址

setInterval(() => {
  https.get(PING_URL, (res) => {
    console.log(`📡 PING 成功：${res.statusCode}`);
  }).on("error", (err) => {
    console.error("⚠️ PING 錯誤：", err.message);
  });
}, PING_INTERVAL);
