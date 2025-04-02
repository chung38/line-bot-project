import "dotenv/config";
import express from "express";
import axios from "axios";
import { Client } from "@line/bot-sdk";
import cron from "node-cron";
import fs from "fs/promises";
import LRUCache from "lru-cache";
import { RateLimiterMemory } from "rate-limiter-flexible";

const app = express();
app.use(express.json());

// 檢查必要的環境變數
const requiredEnvs = ["LINE_ACCESS_TOKEN", "LINE_SECRET", "DEEPSEEK_API_KEY"];
requiredEnvs.forEach((env) => {
  if (!process.env[env]) throw new Error(`Missing ${env} in environment`);
});

// LINE Bot 配置
const lineConfig = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET,
};
const lineClient = new Client(lineConfig);

// 快取設定
const translationCache = new LRUCache({ max: 1000, ttl: 24 * 60 * 60 * 1000 }); // 翻譯快取，24小時
const languageDetectionCache = new LRUCache({ max: 500, ttl: 6 * 60 * 60 * 1000 }); // 語言檢測快取，6小時

// 群組語言資料管理
const groupLanguages = new Map();
const STORAGE_FILE = "groupLanguages.json";
const fileLock = new Map();

// 群組推送時間記錄（速率限制）
const lastPushTime = new Map();

// 全局速率限制器
const rateLimiter = new RateLimiterMemory({
  points: 10, // 每分鐘最多 10 次請求
  duration: 60, // 持續時間 60 秒
});

// 延遲函數
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 安全儲存群組語言設定
async function safeSave(groupId) {
  if (fileLock.has(groupId)) return;
  fileLock.set(groupId, true);
  try {
    const dataToSave = {};
    for (const [id, langs] of groupLanguages.entries()) {
      dataToSave[id] = Array.from(langs);
    }
    await fs.writeFile(STORAGE_FILE, JSON.stringify(dataToSave));
  } finally {
    fileLock.delete(groupId);
  }
}

// 載入群組語言設定
async function loadGroupLanguages() {
  try {
    const data = await fs.readFile(STORAGE_FILE);
    Object.entries(JSON.parse(data)).forEach(([id, langs]) => {
      groupLanguages.set(id, new Set(langs));
    });
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Load error:", error);
  }
}

// 支援的語言及其名稱
const supportedLanguages = ["en", "th", "vi", "id"];
const languageNames = {
  en: "英語",
  th: "泰語",
  vi: "越語",
  id: "印尼語",
  "zh-TW": "繁體中文",
};

// 批次翻譯
async function batchTranslate(sentences, targetLangs) {
  const BATCH_SIZE = 5;
  const results = [];
  for (let i = 0; i < sentences.length; i += BATCH_SIZE) {
    const batch = sentences.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      targetLangs.map((lang) => translateWithDeepSeek(batch.join("\n"), lang))
    );
    results.push(...batchResults.flatMap((t) => t.split("\n")));
  }
  return results;
}

// 使用 DeepSeek API 進行翻譯
async function translateWithDeepSeek(text, targetLang, retryCount = 0) {
  const cacheKey = `${text}-${targetLang}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);
  try {
    const response = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: `專業翻譯成 ${languageNames[targetLang]}：` },
          { role: "user", content: text },
        ],
      },
      { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const result = response.data.choices[0].message.content.trim();
    translationCache.set(cacheKey, result);
    return result;
  } catch (error) {
    if (error.response?.status === 429 && retryCount < 3) {
      const waitTime = Math.pow(2, retryCount) * 10000; // 指數退避：10s, 20s, 40s
      console.warn(`⚠️ DeepSeek API 429錯誤，等待 ${waitTime / 1000} 秒後重試...`);
      await delay(waitTime);
      return translateWithDeepSeek(text, targetLang, retryCount + 1);
    }
    console.error("翻譯錯誤:", error.response?.data || error.message);
    return "（翻譯暫時不可用）";
  }
}

// 發送語言選單（含推送速率限制）
async function sendLanguageMenu(groupId, retryCount = 0) {
  const now = Date.now();
  const minInterval = 60000; // 60 秒
  const lastTime = lastPushTime.get(groupId) || 0;
  if (now - lastTime < minInterval) {
    console.warn(`群組 ${groupId} 在 ${minInterval / 1000} 秒內已發送過消息，跳過推送`);
    return;
  }
  lastPushTime.set(groupId, now);

  try {
    await rateLimiter.consume("global"); // 檢查全局速率限制
    await delay(2000); // 推送前延遲 2 秒
    console.log(`推送語言選單至群組 ${groupId}，時間: ${new Date().toISOString()}`);
    const selected = groupLanguages.get(groupId) || new Set();
    const buttons = supportedLanguages.map((lang) => ({
      type: "button",
      action: {
        type: "postback",
        label: `${languageNames[lang]} ${selected.has(lang) ? "✓" : ""}`,
        data: `action=select&lang=${lang}&groupId=${groupId}`,
      },
      style: selected.has(lang) ? "primary" : "secondary",
    }));
    await lineClient.pushMessage(groupId, {
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
            {
              type: "text",
              text: "✔ 已選: " + Array.from(selected).map((l) => languageNames[l]).join(", "),
            },
            { type: "separator", margin: "md" },
            ...buttons,
          ],
        },
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Rate limit")) {
      console.warn(`全局速率限制，等待 10 秒後重試...`);
      await delay(10000);
      return sendLanguageMenu(groupId, retryCount);
    }
    if (error.response?.status === 429 && retryCount < 3) {
      const waitTime = Math.pow(2, retryCount) * 10000; // 指數退避：10s, 20s, 40s
      console.warn(`⚠️ LINE API 429錯誤，等待 ${waitTime / 1000} 秒後重試...`);
      await delay(waitTime);
      return sendLanguageMenu(groupId, retryCount + 1);
    }
    console.error("發送語言選單失敗:", error.message);
  }
}

// Webhook 處理
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  processEventsAsync(req.body.events).catch(console.error);
});

// 處理 LINE 事件
async function processEventsAsync(events) {
  for (const event of events) {
    try {
      if (event.type === "postback") {
        await handlePostback(event);
      } else if (event.type === "message") {
        await handleMessage(event);
      } else if (event.type === "join") {
        console.log(`Bot joined group: ${event.source.groupId}`);
        await delay(10000); // 加入群組後延遲 10 秒
        await sendLanguageMenu(event.source.groupId);
      }
    } catch (error) {
      console.error("事件處理錯誤:", error);
    }
  }
}

// 處理 Postback 事件
async function handlePostback(event) {
  const { action, lang, groupId } = Object.fromEntries(new URLSearchParams(event.postback.data));
  if (action === "select") {
    if (!groupLanguages.has(groupId)) groupLanguages.set(groupId, new Set());
    const langs = groupLanguages.get(groupId);
    if (lang === "no-translate") {
      langs.clear();
      langs.add("no-translate");
    } else {
      langs.delete("no-translate");
      langs.add(lang);
    }
    await sendLanguageMenu(groupId);
    await safeSave(groupId);
  }
}

// 處理消息事件
async function handleMessage(event) {
  if (event.message.text === "!設定") return sendLanguageMenu(event.source.groupId);
  const groupId = event.source.groupId;
  const selectedLangs = groupLanguages.get(groupId) || new Set();
  if (!selectedLangs.size || selectedLangs.has("no-translate")) {
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "⚠️ 請先使用「!設定」選擇語言",
    });
  }
}

// Ping 端點
app.get("/ping", (req, res) => res.send("🟢 運作中"));

// 定時任務保持伺服器活躍
cron.schedule("*/5 * * * *", async () => {
  try {
    await axios.get(`https://line-bot-project-a0bs.onrender.com/ping`);
    console.log("Keepalive ping sent");
  } catch (error) {
    console.error("Keepalive error:", error.message);
  }
});

// 啟動伺服器
(async () => {
  await loadGroupLanguages();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`🚀 伺服器運行中，端口：${port}`));
})();
