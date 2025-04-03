require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Client } = require("@line/bot-sdk");
const cron = require("node-cron");
const fs = require("fs").promises;
const { LRUCache } = require("lru-cache");
const { RateLimiter } = require("limiter");

const app = express();
app.use(express.json());

// ===== 环境变量校验 =====
const requiredEnvs = ['LINE_ACCESS_TOKEN', 'LINE_SECRET', 'DEEPSEEK_API_KEY'];
requiredEnvs.forEach(env => {
  if (!process.env[env]) throw new Error(`Missing ${env} in environment`);
});

// ===== 速率限制器配置 =====
const lineLimiter = new RateLimiter({
  tokensPerInterval: 30,    // 每分钟最多30次API调用
  interval: "minute",
  fireImmediately: true    // 超限时立即拒绝
});

// ===== LINE 配置 =====
const lineConfig = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET
};
const lineClient = new Client(lineConfig);

// ===== 缓存配置 =====
const translationCache = new LRUCache({
  max: 1000,
  ttl: 24 * 60 * 60 * 1000,
  allowStale: false
});

const languageDetectionCache = new LRUCache({
  max: 500,
  ttl: 6 * 60 * 60 * 1000
});

// ===== API 状态监控 =====
let lineApiStatus = {
  lastError: null,
  errorCount: 0,
  blocked: false,
  resetTimer: null
};

function updateApiStatus(error) {
  lineApiStatus.lastError = new Date();
  lineApiStatus.errorCount++;
  
  if (lineApiStatus.errorCount >= 5) {
    lineApiStatus.blocked = true;
    console.error('⚠️ LINE API 服务已自动禁用（30分钟）');
    clearTimeout(lineApiStatus.resetTimer);
    lineApiStatus.resetTimer = setTimeout(() => {
      lineApiStatus.blocked = false;
      lineApiStatus.errorCount = 0;
      console.log('✅ LINE API 服务已自动启用');
    }, 30 * 60 * 1000);
  }
}

// ===== 智能重试机制 =====
async function withRetry(fn, context = 'LINE_API') {
  const retryConfig = {
    LINE_API: {
      maxRetries: 5,
      baseDelay: 3000,
      statuses: [429, 500, 502, 503, 504],
      factor: 1.8
    },
    DEEPSEEK_API: {
      maxRetries: 3,
      baseDelay: 5000,
      statuses: [429, 500],
      factor: 2
    }
  }[context];

  let attempt = 0;
  let delay = retryConfig.baseDelay;

  while (attempt < retryConfig.maxRetries) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      const shouldRetry = retryConfig.statuses.includes(error.response?.status);
      
      if (!shouldRetry) {
        console.error(`[${context}] 不可重试错误`, error.message);
        throw error;
      }

      const retryAfter = error.response?.headers?.['retry-after'] 
        ? parseInt(error.response.headers['retry-after']) * 1000
        : delay;

      console.warn(`[${context}] 第 ${attempt}/${retryConfig.maxRetries} 次重试 (${retryAfter}ms)`);
      await new Promise(resolve => setTimeout(resolve, retryAfter));
      delay *= retryConfig.factor;

      if (context === 'LINE_API') updateApiStatus(error);
    }
  }

  throw new Error(`[${context}] 达到最大重试次数`);
}

// ===== 群组数据管理 =====
const groupLanguages = new Map();
const STORAGE_FILE = "groupLanguages.json";

async function safeSave(groupId) {
  try {
    const dataToSave = {};
    for (const [id, langs] of groupLanguages.entries()) {
      dataToSave[id] = Array.from(langs);
    }
    await fs.writeFile(STORAGE_FILE, JSON.stringify(dataToSave));
  } catch (error) {
    console.error('存储失败:', error.message);
  }
}

async function loadGroupLanguages() {
  try {
    const data = await fs.readFile(STORAGE_FILE);
    Object.entries(JSON.parse(data)).forEach(([id, langs]) => {
      groupLanguages.set(id, new Set(langs));
    });
  } catch (error) {
    if (error.code !== "ENOENT") console.error('加载失败:', error.message);
  }
}

// ===== 翻译核心功能 =====
const supportedLanguages = ["en", "th", "vi", "id"];
const languageNames = {
  en: "英語", th: "泰語", vi: "越語", id: "印尼語", "zh-TW": "繁體中文"
};

async function batchTranslate(sentences, targetLangs) {
  const BATCH_SIZE = 3;
  const results = [];
  
  for (let i = 0; i < sentences.length; i += BATCH_SIZE) {
    const batch = sentences.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      targetLangs.map(lang => 
        withRetry(() => translateWithDeepSeek(batch.join('\n'), languageNames[lang]), 'DEEPSEEK_API')
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
          { role: "system", content: `專業翻譯成 ${targetLang}，保持原意不簡化` },
          { role: "user", content: text }
        ],
        temperature: 0.3
      },
      { 
        headers: { 
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 10000 
      }
    );
    
    const result = response.data.choices[0].message.content.trim();
    translationCache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.error("[DeepSeek] 翻譯失敗:", error.response?.data || error.message);
    return "（翻譯服務暫時不可用）";
  }
}

// ===== LINE 交互功能 =====
async function sendLanguageMenu(groupId) {
  if (lineApiStatus.blocked) {
    throw new Error("LINE API 服務暫時不可用");
  }

  await lineLimiter.removeTokens(1);
  
  const selected = groupLanguages.get(groupId) || new Set();
  const flexMessage = buildFlexMenu(selected, groupId);

  try {
    await withRetry(() => lineClient.pushMessage(groupId, flexMessage));
    console.log(`成功發送選單至群組 ${groupId}`);
  } catch (error) {
    console.error(`發送選單失敗 [${groupId}]`, error.message);
    throw error;
  }
}

function buildFlexMenu(selectedLangs, groupId) {
  return {
    type: "flex",
    altText: "多語言翻譯設定",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [{
          type: "text",
          text: "🌍 翻譯設定",
          weight: "bold",
          color: "#FFFFFF",
          size: "xl"
        }],
        backgroundColor: "#1DB446",
        paddingAll: "lg"
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: `已選語言：${selectedLangs.size > 0 
              ? Array.from(selectedLangs).map(l => languageNames[l]).join(", ")
              : "尚未選擇"}`,
            wrap: true
          },
          { type: "separator" },
          ...supportedLanguages.map(lang => ({
            type: "button",
            action: {
              type: "postback",
              label: `${languageNames[lang]} ${selectedLangs.has(lang) ? "✓" : ""}`,
              data: `action=select&lang=${lang}&groupId=${groupId}`
            },
            style: selectedLangs.has(lang) ? "primary" : "secondary"
          })),
          {
            type: "button",
            action: {
              type: "postback",
              label: "✅ 完成設定",
              data: `action=confirm&groupId=${groupId}`
            },
            style: "primary",
            color: "#1DB446"
          }
        ]
      }
    }
  };
}

// ===== Webhook 處理 =====
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
      console.error("事件處理失敗:", error.message);
    }
  }
}

async function handlePostback(event) {
  const { action, lang, groupId } = Object.fromEntries(
    new URLSearchParams(event.postback.data)
  );
  
  if (!groupLanguages.has(groupId)) {
    groupLanguages.set(groupId, new Set());
  }
  const langs = groupLanguages.get(groupId);

  if (action === "select") {
    langs.delete("no-translate");
    if (lang === "no-translate") {
      langs.clear().add("no-translate");
    } else {
      langs.add(lang);
    }
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
  
  if (selectedLangs.has("no-translate") || selectedLangs.size === 0) {
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "⚠️ 請先使用「!設定」選擇要翻譯的語言"
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
  try {
    translations = detectedLang === "zh-TW"
      ? await batchTranslate(sentences, Array.from(selectedLangs))
      : await batchTranslate(sentences, ["zh-TW"]);
  } catch (error) {
    return lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "🔧 翻譯服務暫時不可用，請稍後再試"
    });
  }

  await lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: translations.join("\n\n") + "\n\n—— 自動翻譯服務 ——"
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
          { 
            role: "system", 
            content: "嚴格只回覆此文本的ISO 639-1語言代碼，不要任何其他文字" 
          },
          { role: "user", content: text }
        ],
        temperature: 0
      },
      { 
        headers: { 
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 5000 
      }
    );
    return response.data.choices[0].message.content.trim().toLowerCase();
  } catch (error) {
    console.error("語言檢測失敗:", error.message);
    return "zh-TW";
  }
}

// ===== 伺服器配置 =====
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    lineApi: {
      blocked: lineApiStatus.blocked,
      errorCount: lineApiStatus.errorCount,
      lastError: lineApiStatus.lastError
    },
    memoryUsage: process.memoryUsage()
  });
});

cron.schedule("*/5 * * * *", async () => {
  try {
    await axios.get(`${process.env.RENDER_INSTANCE}/ping`);
    console.log("Keepalive ping 成功");
  } catch (error) {
    console.error("Keepalive 錯誤:", error.message);
  }
});

(async () => {
  await loadGroupLanguages();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`🚀 伺服器運行中，端口：${port}`);
    console.log("當前配置：");
    console.log("- 支援語言:", supportedLanguages.map(l => languageNames[l]).join(", "));
    console.log("- 速率限制:", lineLimiter.tokensPerInterval, "次/分鐘");
  });
})();
