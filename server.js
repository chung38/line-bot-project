import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs/promises";

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

// ================= 群組語言設定儲存 =================
const GROUP_LANG_FILE = "groupLanguages.json";
// 使用 Map 儲存，每個群組的語言設定為 Set，允許複選
let groupLanguages = new Map();

const loadGroupLanguages = async () => {
  try {
    const data = await fs.readFile(GROUP_LANG_FILE, "utf8");
    const obj = JSON.parse(data);
    groupLanguages = new Map(Object.entries(obj).map(([groupId, langs]) => [groupId, new Set(langs)]));
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
    const obj = {};
    for (const [groupId, langSet] of groupLanguages.entries()) {
      obj[groupId] = Array.from(langSet);
    }
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
      { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    return response.data.choices[0].message.content.trim();
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

// ================= 判斷是否含中文 =================
const containsChinese = (text) => /[\u4e00-\u9fff]/.test(text);

// ================= 中間件設定 =================
// 使用 raw body parser 保留原始資料供 LINE middleware 驗證簽名，再用 express.json() 轉換成 JSON
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  middleware(lineConfig),
  express.json(),
  async (req, res) => {
    try {
      console.log("🔍 解析後的事件結構:", JSON.stringify(req.body, null, 2));
      await Promise.all(req.body.events.map(async (event) => {
        // 處理機器人加入群組事件：發送語言選單
        if (event.type === "join" && event.source?.type === "group") {
          const groupId = event.source.groupId;
          console.log(`🤖 新群組加入: ${groupId}`);
          sendLanguageMenu(groupId);  // 立即發送選單
        }
        // 處理 postback 事件：設定或取消語言選擇
        else if (event.type === "postback") {
          const data = event.postback.data;
          const params = new URLSearchParams(data);
          const action = params.get("action");
          const code = params.get("code");
          const groupId = event.source.groupId;
          if (action === "set_lang" && code) {
            if (code === "cancel") {
              groupLanguages.delete(groupId);
              await saveGroupLanguages();
              console.log(`✅ 群組 ${groupId} 已清除所有語言選擇`);
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "已取消所有語言選擇。"
              });
            } else {
              let langSet = groupLanguages.get(groupId);
              if (!langSet) {
                langSet = new Set();
                groupLanguages.set(groupId, langSet);
              }
              // 多選：如果已選則取消，否則加入
              if (langSet.has(code)) {
                langSet.delete(code);
              } else {
                langSet.add(code);
              }
              await saveGroupLanguages();
              const langNameMapping = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文" };
              const current = Array.from(langSet).map(c => langNameMapping[c] || c).join("、") || "無";
              console.log(`✅ 群組 ${groupId} 更新語言選擇：${current}`);
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: `${current}`
              });
            }
          } else {
            console.log("收到未知 postback:", data);
          }
        }
        // 處理文字訊息事件：翻譯功能
        else if (event.type === "message" && event.message.type === "text") {
          const groupId = event.source.groupId;
          const text = event.message.text;
          const langSet = groupLanguages.get(groupId);
          if (!langSet || langSet.size === 0) {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "請先設定翻譯語言，您可以點選選單或輸入 !設定。"
            });
            return;
          }
          // 當訊息包含中文時，將其翻譯成所有所選語言（僅回傳翻譯結果）
          if (containsChinese(text)) {
            const results = [];
            for (const code of langSet) {
              const translated = await translateWithDeepSeek(text, code);
              results.push(translated);
            }
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: results.join("\n")
            });
          } else {
            // 當訊息不包含中文，則翻譯成繁體中文（僅回傳翻譯結果）
            const translated = await translateWithDeepSeek(text, "zh-TW");
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: translated
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
// 速率限制：每個群組 60 秒內只發送一次選單
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
          createButton("印尼文", "id"),
          { // 取消按鈕
            type: "button",
            action: { type: "postback", label: "取消選擇", data: "action=set_lang&code=cancel" },
            style: "secondary",
            color: "#FF3B30"
          }
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
