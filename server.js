import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";

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

// ================= 優化後的中間件鏈 =================
// 為了讓 LINE middleware 能正確驗證簽名，請使用 raw body parser 保留原始資料，
// 驗證完成後再轉換為 JSON 供後續邏輯使用。
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }), // 保留原始資料供簽名驗證
  middleware(lineConfig),                        // LINE 官方驗證
  express.json(),                                // 轉換 JSON
  async (req, res) => {
    try {
      console.log("🔍 解析後的事件結構:", JSON.stringify(req.body, null, 2));
      
      // 處理所有收到的事件
      await Promise.all(req.body.events.map(async (event) => {
        if (event.type === "join" && event.source?.type === "group") {
          const groupId = event.source.groupId;
          console.log(`🤖 新群組加入: ${groupId}`);
          // 延遲 10 秒後發送語言選單
          setTimeout(() => {
            sendLanguageMenu(groupId);
          }, 10000);
        } else {
          // 其他事件（例如 message、postback）可在此處擴充處理邏輯
          console.log(`📩 收到其他事件，類型：${event.type}`);
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
const sendLanguageMenu = async (groupId, retryCount = 0) => {
  // 為避免短時間內重複發送，可加入簡單的速率限制（例如：60秒內只發送一次）
  if (!canSendMessage(groupId)) {
    console.log(`群組 ${groupId} 在 60 秒內已發送過選單，跳過推送`);
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
      const waitTime = (retryCount + 1) * 5000; // 依次等待 5, 10, 15 秒
      console.warn(`⚠️ LINE API 429 錯誤，等待 ${waitTime / 1000} 秒後重試發送選單...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return sendLanguageMenu(groupId, retryCount + 1);
    }
    console.error(`❌ 發送失敗 (${groupId}):`, error.response?.data || error.message);
  }
};

// 速率限制工具：每個群組 60 秒內只允許發送一次選單
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
    '請求體處理': 'LINE中間件 → Express.json()',
    '簽名驗證': '已啟用 ✅',
    'HTTPS支持': process.env.NODE_ENV === 'production' ? 'Render托管' : '開發模式',
    '環境模式': process.env.NODE_ENV || 'development'
  });
});
