require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Client } = require("@line/bot-sdk");
const cron = require("node-cron");
const fs = require("fs").promises;
const LRU = require("lru-cache");

const app = express();
app.use(express.json());

// ===== 环境变量校验 =====
const requiredEnvs = ['LINE_ACCESS_TOKEN', 'LINE_SECRET', 'DEEPSEEK_API_KEY'];
requiredEnvs.forEach(env => {
  if (!process.env[env]) throw new Error(`Missing ${env} in environment`);
});

// ===== LINE 配置 =====
const lineConfig = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET
};
const lineClient = new Client(lineConfig);

// ===== 缓存配置 =====
const translationCache = new LRU({
  max: 1000,
  ttl: 24 * 60 * 60 * 1000
});

const languageDetectionCache = new LRU({
  max: 500,
  ttl: 6 * 60 * 60 * 1000
});

// ===== 群组数据管理 =====
const groupLanguages = new Map();
const STORAGE_FILE = "groupLanguages.json";
const fileLock = new Map();

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

// ===== 翻译核心功能 =====
const supportedLanguages = ["en", "th", "vi", "id"];
const languageNames = {
  en: "英語", th: "泰語", vi: "越語", id: "印尼語", "zh-TW": "繁體中文"
};

async function batchTranslate(sentences, targetLangs) {
  const BATCH_SIZE = 5;
  const results = [];
  
  for (let i = 0; i < sentences.length; i += BATCH_SIZE) {
    const batch = sentences.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      targetLangs.map(lang => 
        translateWithDeepSeek(batch.join('\n'), languageNames[lang])
      )
    );
    results.push(...batchResults.flatMap(t => t.split('\n')));
  }
  return results;
}

async function translateWithDeepSeek(text, targetLang) {
  const cacheKey = `${text}-${targetLang}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  try {
    const response = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: `專業翻譯成 ${targetLang}：` },
          { role: "user", content: text }
        ]
      },
      { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    
    const result = response.data.choices[0].message.content.trim();
    translationCache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.error("Translation error:", error.response?.data || error.message);
    return "（翻譯暫時不可用）";
  }
}

// ===== LINE 交互功能 =====
async function sendLanguageMenu(groupId) {
  const selected = groupLanguages.get(groupId) || new Set();
  
  const buttons = supportedLanguages.map(lang => ({
    type: "button",
    action: {
      type: "postback",
      label: `${languageNames[lang]} ${selected.has(lang) ? "✓" : ""}`,
      data: `action=select&lang=${lang}&groupId=${groupId}`
    },
    style: selected.has(lang) ? "primary" : "secondary"
  }));

  await lineClient.pushMessage(groupId, {
    type: "flex",
    altText: "翻譯設定",
    contents: {
      type: "bubble",
      header: { type: "box", layout: "vertical", contents: [{ type: "text", text: "🌍 翻譯設定" }] },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "✔ 已選: " + Array.from(selected).map(l => languageNames[l]).join(", ") },
          { type: "separator", margin: "md" },
          ...buttons
        ]
      }
    }
  });
}

// ===== Webhook 处理 =====
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  processEventsAsync(req.body.events).catch(console.error);
});

async function processEventsAsync(events) {
  for (const event of events) {
    try {
      if (event.type === "postback") await handlePostback(event);
      if (event.type === "message") await handleMessage(event);
    } catch (error) {
      console.error("Event processing error:", error);
    }
  }
}

async function handlePostback(event) {
  const { action, lang, groupId } = Object.fromEntries(new URLSearchParams(event.postback.data));
  
  if (action === "select") {
    if (!groupLanguages.has(groupId)) groupLanguages.set(groupId, new Set());
    const langs = groupLanguages.get(groupId);
    
    lang === "no-translate" 
      ? langs.clear().add("no-translate")
      : langs.delete("no-translate") && langs.add(lang);
    
    await sendLanguageMenu(groupId);
    await safeSave(groupId);
  }
}

async function handleMessage(event) {
  if (event.message.text === "!設定") {
    return sendLanguageMenu(event.source.groupId);
  }

  const groupId = event.source.groupId;
  const selectedLangs = groupLanguages.get(groupId) || new Set();
  
  if (!selectedLangs.size || selectedLangs.has("no-translate")) {
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "⚠️ 請先使用「!設定」選擇語言"
    });
  }

  const text = event.message.text;
  const sentences = text.split(/(?<=[。！？])/).map(s => s.trim()).filter(Boolean);
  
  let detectedLang = languageDetectionCache.get(groupId);
  if (!detectedLang) {
    detectedLang = await detectLanguage(text);
    languageDetectionCache.set(groupId, detectedLang);
  }

  let translations;
  if (detectedLang === "zh-TW") {
    translations = await batchTranslate(sentences, Array.from(selectedLangs));
  } else {
    translations = await batchTranslate(sentences, ["zh-TW"]);
  }

  await lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: translations.join("\n")
  });
}

// ===== 辅助函数 =====
async function detectLanguage(text) {
  try {
    const response = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "回覆此文本的ISO 639-1語言代碼" },
          { role: "user", content: text }
        ]
      },
      { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    return response.data.choices[0].message.content.trim() || "zh-TW";
  } catch (error) {
    return "zh-TW";
  }
}

// ===== 伺服器配置 =====
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    groups: groupLanguages.size,
    memoryUsage: process.memoryUsage()
  });
});

app.get("/ping", (req, res) => res.send("🟢 運作中"));

cron.schedule("*/5 * * * *", async () => {
  try {
    await axios.get(`https://line-bot-project-a0bs.onrender.com/ping`);
    console.log("Keepalive ping sent");
  } catch (error) {
    console.error("Keepalive error:", error.message);
  }
});

(async () => {
  await loadGroupLanguages();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`🚀 伺服器運行中，端口：${port}`));
})();
