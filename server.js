import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
dotenv.config();

// 環境變數檢查
const REQUIRED_ENV = ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);

if (missingEnv.length > 0) {
  console.error("❌ 缺少必要的環境變數:", missingEnv.join(", "));
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
  if (!canSendMessage(groupId)) {
    console.log(`⏳ 群組 ${groupId} 觸發速率限制`);
    return;
  }

  const message = {
    type: "flex",
    altText: "翻譯設定",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [{ type: "text", text: "🌍 翻譯設定", weight: "bold" }],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { 
            type: "text", 
            text: "請選擇要翻譯的語言", 
            size: "md",
            wrap: true
          },
          { 
            type: "button", 
            action: { 
              type: "postback", 
              label: "🇬🇧 英語", 
              data: "action=select&lang=en",
              displayText: "您選擇了英語"
            }, 
            style: "primary",
            color: "#FF6B6B",
            margin: "md"
          },
          // 其他語言按鈕...
        ],
      },
    },
  };

  try {
    await client.pushMessage(groupId, message);
    console.log("✅ 語言選單已發送到群組:", groupId);
  } catch (error) {
    console.error("❌ 發送語言選單失敗:", error.originalError?.response?.data || error.message);
    throw error; // 重新拋出錯誤讓上層處理
  }
};

// 增強錯誤處理的中間件
const errorHandler = (err, req, res, next) => {
  console.error("⚠️ 全局錯誤處理:", err);
  res.status(500).json({ error: "Internal Server Error" });
};

// 調整中間件順序：先驗證簽章再解析JSON
app.post(
  "/webhook",
  middleware(config), // LINE 簽章驗證
  express.json(),    // 解析JSON
  async (req, res, next) => {
    try {
      // 確保events存在且是陣列
      if (!Array.isArray(req.body.events)) {
        console.warn("⚠️ 無效的Webhook格式:", req.body);
        return res.sendStatus(200); // 仍返回200避免LINE重試
      }

      // 並行處理所有事件
      await Promise.all(
        req.body.events.map(event => 
          handleEvent(event).catch(e => {
            console.error(`⚠️ 單一事件處理失敗 (${event.type}):`, e);
          })
        )
      );
      
      res.sendStatus(200);
    } catch (error) {
      next(error); // 傳遞給全局錯誤處理
    }
  }
);

// 事件處理器
const handleEvent = async (event) => {
  try {
    switch (event.type) {
      case "join":
        if (event.source.type === "group") {
          console.log("👥 Bot加入群組:", event.source.groupId);
          await sendLanguageMenu(event.source.groupId);
        }
        break;
      
      case "postback":
        // 處理按鈕回傳的範例
        console.log("🔄 收到Postback數據:", event.postback.data);
        break;
        
      default:
        console.log("ℹ️ 未處理的事件類型:", event.type);
    }
  } catch (error) {
    console.error(`❌ 處理 ${event.type} 事件失敗:`, error);
    throw error; // 讓上層捕獲
  }
};

// 健康檢查端點
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date() });
});

// 全局錯誤處理
app.use(errorHandler);

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`🚀 伺服器運行中: http://localhost:${PORT}`);
  console.log("🔒 Webhook URL:", `${process.env.NGROK_URL || ''}/webhook`);
});
