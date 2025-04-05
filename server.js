import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs/promises";
import LRUCache from "lru-cache";

const app = express();
const PORT = process.env.PORT || 10000;

// ================= 強化配置驗證 =================
const validateConfig = () => {
  const requiredEnv = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'DEEPSEEK_API_KEY'];
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

// ================= 檔案存取：群組語言設定 =================
const GROUP_LANG_FILE = "groupLanguages.json";
let groupLanguages = new Map(); // key: 群組 ID, value: 語言代碼 (例如 "en", "th", "vi", "id")

const loadGroupLanguages = async () => {
  try {
    const data = await fs.readFile(GROUP_LANG_FILE, "utf8");
    const obj = JSON.parse(data);
    groupLanguages = new Map(Object.entries(obj));
    console.log("✅ 成功載入群組語言設定");
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("ℹ️ 尚無群組語言設定檔");
    } else {
      console.error("載入群組語言設定失敗:", error);
    }
  }
};

const saveGroupLanguages = async () => {
  try {
    const obj = Object.fromEntries(groupLanguages);
    await fs.writeFile(GROUP_LANG_FILE, JSON.stringify(obj, null, 2));
    console.log("✅ 群組語言設定已儲存");
  } catch (error) {
    console.error("儲存群組語言設定失敗:", error);
  }
};

// ================= 翻譯 API 功能 =================
const translateWithDeepSeek = async (text, targetLang, retryCount = 0) => {
  try {
    const response = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: `專業翻譯成 ${targetLang === "zh-TW" ? "繁體中文" : targetLang === "en" ? "英文" : targetLang === "th" ? "泰文" : targetLang === "vi" ? "越南文" : targetLang === "id" ? "印尼文" : targetLang}：` },
          { role: "user", content: text }
        ]
      },
      {
        headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      }
    );
    const result = response.data.choices[0].message.content.trim();
    return result;
  } catch (error) {
    if (error.response?.status === 429 && retryCount < 3) {
      const waitTime = (retryCount + 1) * 5000;
      console.warn(`⚠️ DeepSeek API 429 錯誤，等待 ${waitTime / 1000} 秒後重試...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return translateWithDeepSeek(text, targetLang, retryCount + 1);
    }
    console.error("翻譯錯誤:", error.response?.data || error.message);
    return "（翻譯暫時不可用）";
  }
};

// ================= 判斷文字語言工具 =================
const containsChinese = (text) => /[\u4e00-\u9fff]/.test(text);

// ================= 中間件設定 =================
// 為了讓 LINE middleware 正確驗證簽名，使用 raw body parser 保留原始資料，再轉換為 JSON 供後續處理
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  middleware(lineConfig),
  express.json(),
  async (req, res) => {
    try {
      console.log("🔍 解析後的事件結構:", JSON.stringify(req.body, null, 2));
      await Promise.all(req.body.events.map(async (event) => {
        // 處理機器人加入群組事件
        if (event.type === "join" && event.source?.type === "group") {
          const groupId = event.source.groupId;
          console.log(`🤖 新群組加入: ${groupId}`);
          // 直接發送語言選單（無延遲）
          sendLanguageMenu(groupId);
        }
        // 處理 postback 事件：設定語言
        else if (event.type === "postback") {
          const data = event.postback.data;
          const params = new URLSearchParams(data);
          const action = params.get("action");
          const code = params.get("code");
          if (action === "set_lang" && code) {
            const langNameMapping = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文" };
            const langName = langNameMapping[code] || code;
            const groupId = event.source.groupId;
            // 儲存群組語言設定（永久記憶）
            groupLanguages.set(groupId, code);
            await saveGroupLanguages();
            console.log(`✅ 群組 ${groupId} 已設定語言：${langName} (${code.toUpperCase()})`);
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: `您已選擇：${langName}`
            });
          } else {
            console.log("收到未知 postback:", data);
          }
        }
        // 處理文字訊息事件：翻譯功能
        else if (event.type === "message" && event.message.type === "text") {
          const groupId = event.source.groupId;
          const text = event.message.text;
          const targetLang = groupLanguages.get(groupId);
          if (!targetLang) {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "請先設定翻譯語言，您可以點選選單或輸入 !設定"
            });
            return;
          }
          if (containsChinese(text)) {
            // 中文翻譯成群組設定的語言
            const translated = await translateWithDeepSeek(text, targetLang);
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: `翻譯結果 (${targetLang.toUpperCase()}): ${translated}`
            });
          } else {
            // 非中文則翻譯成繁體中文
            const translated = await translateWithDeepSeek(text, "zh-TW");
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: `翻譯結果 (繁中): ${translated}`
            });
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
const RATE_LIMIT_TIME = 60000; // 每個群組 60 秒內只發送一次

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
app.listen(PORT, async () => {
  await loadGroupLanguages();
  console.log(`🚀 服務已啟動，端口：${PORT}`);
  console.log("🛡️ 安全配置狀態：");
  console.table({
    "請求體處理": "LINE中間件 → Express.json()",
    "簽名驗證": "已啟用 ✅",
    "HTTPS支持": process.env.NODE_ENV === "production" ? "Render托管" : "開發模式",
    "環境模式": process.env.NODE_ENV || "development"
  });
});
