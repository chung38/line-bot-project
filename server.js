import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import basicAuth from "express-basic-auth";
import rateLimit from "express-rate-limit";
import { Client, middleware } from "@line/bot-sdk";
import crypto from "node:crypto";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const requiredEnv = [
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "OPENAI_API_KEY",
  "FIREBASE_CONFIG",
  "ADMIN_USER",
  "ADMIN_PASS"
];

const missingEnv = requiredEnv.filter(v => !process.env[v]);
if (missingEnv.length > 0) {
  console.error(`❌ 缺少環境變數: ${missingEnv.join(", ")}`);
  process.exit(1);
}

let db;
try {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  if (firebaseConfig.private_key) {
    firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig)
  });
  db = admin.firestore();
  console.log("✅ Firebase 初始化成功");
} catch (e) {
  console.error("❌ Firebase 初始化失敗:", e);
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new Client(lineConfig);

const translationCache = new LRUCache({
  max: 2000,
  ttl: 24 * 60 * 60 * 1000
});

// 每則訊息都會查的資料，用短 TTL 快取，避免重複打 Firestore / LINE API
const subscriptionCache = new LRUCache({
  max: 500,
  ttl: 60 * 1000
});

const usageCache = new LRUCache({
  max: 500,
  ttl: 30 * 1000
});

const displayNameCache = new LRUCache({
  max: 2000,
  ttl: 6 * 60 * 60 * 1000
});

const groupSummaryCache = new LRUCache({
  max: 500,
  ttl: 10 * 60 * 1000
});

// 行業別主檔：後台會頻繁呼叫 loadIndustryMaster()，加上節流避免整個 collection 重讀
let industryMasterLoadedAt = 0;
const INDUSTRY_MASTER_TTL = 60 * 1000;

// 逾時參數集中管理。單次 OpenAI 呼叫 × 2（主模型 + fallback）必須小於總逾時，
// 否則 fallback 還沒回來整批就已經被判逾時。
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 20000);
const TRANSLATION_TOTAL_TIMEOUT_MS = Number(process.env.TRANSLATION_TIMEOUT_MS || 45000);

// mention 還原等細節記錄只在需要時開啟，正式環境不要洗版
const DEBUG_TRANSLATION = process.env.DEBUG_TRANSLATION === "1";

const groupLang = new Map();
const groupInviter = new Map();
const groupIndustry = new Map();
// ✅ Step 1: 退群封鎖集合
const deletedGroups = new Set();
let industryMasterDocs = [];
const SUBSCRIPTION_STATUS = {
  TRIAL: "TRIAL",
  ACTIVE: "ACTIVE",
  MANUAL_ACTIVE: "MANUAL_ACTIVE",
  INACTIVE: "INACTIVE",
  PAYMENT_FAILED: "PAYMENT_FAILED",
};

const MANUAL_OVERRIDE = {
  NONE: "NONE",
  FORCE_ACTIVE: "FORCE_ACTIVE",
  FORCE_INACTIVE: "FORCE_INACTIVE",
};
const SUPPORTED_LANGS = {
  en: "英文",
  th: "泰文",
  vi: "越南文",
  id: "印尼文",
  "zh-TW": "繁體中文"
};

const LANG_ICONS = {
  en: "🇬🇧",
  th: "🇹🇭",
  vi: "🇻🇳",
  id: "🇮🇩",
  "zh-TW": "🇹🇼"
};

const LANG_LABELS = {
  en: "🇬🇧",
  th: "🇹🇭",
  vi: "🇻🇳",
  id: "🇮🇩",
  "zh-TW": "🇹🇼"
};

const NAME_TO_CODE = {};
Object.entries(SUPPORTED_LANGS).forEach(([code, label]) => {
  NAME_TO_CODE[label] = code;
  NAME_TO_CODE[`${label}版`] = code;
});

const i18n = {
  "zh-TW": {
    menuTitle: "翻譯語言設定",
    industrySet: "🏭 行業別已設為：{industry}",
    industryCleared: "❌ 已清除行業別",
    langSelected: "✅ 已選擇語言：{langs}",
    langCanceled: "❌ 已取消所有語言",
    propagandaPushed: "✅ 已推播 {dateStr} 的文宣圖片",
    propagandaFailed: "❌ 推播失敗，請稍後再試",
    propagandaNotFound: "❌ 找不到符合日期或語言的文宣圖片",
    noLanguageSetting: "❌ 尚未設定欲接收語言，請先用 !設定 選擇語言",
    wrongFormat: "格式錯誤，請輸入 !文宣 YYYY-MM-DD",
    noPermission: "❌ 你沒有權限操作此群組設定",
    invalidIndustry: "❌ 無效的行業別",
    invalidUserId: "❌ userId 格式不正確"
  }
};

function getEnabledIndustryNames() {
  return industryMasterDocs
    .filter(x => x.enabled !== false)
    .sort((a, b) => (a.sortOrder || 9999) - (b.sortOrder || 9999))
    .map(x => x.name)
    .filter(Boolean);
}

function isValidIndustry(industry = "") {
  return getEnabledIndustryNames().includes(industry);
}

function hasChinese(txt = "") {
  return /[\u4e00-\u9fff]/.test(txt);
}

function isOnlyEmojiOrWhitespace(txt = "") {
  if (!txt) return true;

  // 只在「括號外還有其他內容」時才把括號註解剝掉。
  // 否則像「（今天休假）」這種整句包在括號裡的訊息會被誤判成純表情而整則跳過。
  const parenRemoved = txt.replace(/[（(][\u4e00-\u9fff\w\s]+[）)]/g, "").trim();
  const stripped = parenRemoved || txt.trim();
  if (!stripped) return true;

  let s = stripped.replace(/[\s.,!?，。？！、:：;；"'"'（）【】《》\[\]()]/g, "");
  s = s.replace(/\uFE0F/g, "").replace(/\u200D/g, "");
  if (!s) return true;

  return /^\p{Extended_Pictographic}+$/u.test(s);
}

function isSymbolOrNum(txt = "") {
  return /^[\d\s.,!?，。？！、:：；"'"'（）【】《》+\-*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);
}
function normalizeTextForLangDetect(text) {
  return String(text ?? "")
    .replace(/__MENTION_\d+__/g, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
// 檢查輸出是否符合目標語言的字元特徵
function isOutputValidForLang(out = "", targetLang = "") {
  const text = String(out).trim();
  if (!text) return false;

  // 只保留各語言的文字；排除電話、數字、數量、符號與標點
  const meaningful = text.replace(
    /[^\p{L}]/gu,
    ""
  );

  if (!meaningful) return false;

  const chineseLen = (meaningful.match(/[\u4e00-\u9fff]/g) || []).length;
  const thaiLen = (meaningful.match(/[\u0E00-\u0E7F]/g) || []).length;

  // 英文、印尼文、越南文都使用拉丁字母
  const latinLen = (
    meaningful.match(/[A-Za-zÀ-ÖØ-öø-ÿ\u0102-\u01B0\u1EA0-\u1EF9]/g) || []
  ).length;

  const totalLen = meaningful.length || 1;
  const chineseRatio = chineseLen / totalLen;

  // 只有中文明顯是整段主體，才視為外語翻譯失敗。
  // 因此允許保留少量中文的廠名、地名、客戶名或內部識別名稱。
  const isChineseDominant =
    chineseLen >= 4 &&
    chineseRatio >= 0.45;

  // 繁中：必須含中文
  if (targetLang === "zh-TW") {
    return chineseLen > 0;
  }

  /*
    拉丁字母系語言（en / vi / id）共用同一套字元，無法用字元範圍區分。

    這裡刻意採用「反證」而非「舉證」：
      ✗ 舊做法：要求輸出含有該語言的特徵詞，否則判定失敗。
        → 「tan ca」「Kode karyawan kita ya」這種完全正確的短句
          常常一個特徵詞都不含，結果正確翻譯被殺掉、變成錯誤訊息。
      ✓ 新做法：只有在偵測到「它是別的語言」的正面證據時才判定失敗。

    兩種誤判的代價不對等：
      漏抓一句錯語言 → 使用者看到一句看得懂但語言不對的訊息。
      誤殺一句正確翻譯 → 使用者看到「（翻譯異常）」，資訊完全喪失。
    所以一律偏向放行。
  */

  // 越南文專屬字元。印尼文與英文都不會出現，是很強的反證。
  const viDiacritics = (meaningful.match(/[\u0102-\u01B0\u1EA0-\u1EF9]/g) || []).length;

  // 英文功能詞。避開會與越南文無聲調拼法相撞的詞（on = ơn、the = thế），
  // 因此要求至少兩個才算數。
  const englishHits = (
    text.match(/\b(the|is|are|was|were|please|this|that|these|those|will|would|should|have|has|been|with|and|for|your|our|they|their|not|there|here|because|when|which|from|about|after|before|need|make|check|already|too|very|but|also)\b/gi) || []
  ).length;

  /*
    印尼文可以用更寬的英文詞表：in / of / to / at / on / it / as / by / be / an / we
    這些在印尼文裡都不是詞（印尼文用 di、ke、dari、dan、ini、itu、kami），
    也不會跟越南文無聲調拼法混淆，因此不會誤傷正確的印尼文譯文。
    這條是為了擋掉「目標印尼文卻回英文」且句中沒有 the / and / please 的情況。
  */
  const englishHitsForId = englishHits + (
    text.match(/\b(in|of|to|at|on|it|as|by|be|an|we|without|into|over|under|between|during|each|some|any|all|more|than|then|only|such|its|his|her|him|she|he)\b/gi) || []
  ).length;

  // 印尼文專屬功能詞（越南文不會出現這些）
  const idHits = (
    text.match(/\b(dan|yang|untuk|dengan|tidak|adalah|sudah|akan|bisa|dari|pada|harus|atau|juga|lagi|saja|karena|kalau)\b/gi) || []
  ).length;

  if (targetLang === "vi") {
    if (latinLen === 0 || isChineseDominant) return false;
    if (thaiLen > 0) return false;                       // 殘留泰文原文
    if (viDiacritics >= 1) return true;                  // 確定是越南文
    if (englishHits >= 2) return false;                  // 明顯是英文
    if (idHits >= 2) return false;                       // 明顯是印尼文
    return true;                                         // 沒有反證 → 放行
  }

  if (targetLang === "id") {
    if (latinLen === 0 || isChineseDominant) return false;
    if (thaiLen > 0) return false;
    if (viDiacritics >= 1) return false;                 // 印尼文不會有越南文聲調字元
    if (idHits >= 1) return true;                        // 確定是印尼文
    if (englishHitsForId >= 2) return false;             // 明顯是英文
    return true;
  }

  if (targetLang === "en") {
    if (latinLen === 0 || isChineseDominant) return false;
    if (thaiLen > 0) return false;
    if (viDiacritics >= 2) return false;
    return true;
  }

  // 泰文：必須有泰文，且不可以中文為主
  if (targetLang === "th") {
    return thaiLen > 0 && !isChineseDominant;
  }

  return true;
}

function detectLang(text) {
  const cleaned = normalizeTextForLangDetect(text);
  if (!cleaned) return "en";

  const noNumCleaned = cleaned.replace(/[0-9]/g, "");
  const totalLen = noNumCleaned.length || 1;

  const chineseLen = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const thaiLen = (cleaned.match(/[\u0E00-\u0E7F]/g) || []).length;
  const viCharLen = (cleaned.match(/[\u0102-\u01B0\u1EA0-\u1EF9]/g) || []).length;
  const latinLen = (cleaned.match(/[a-zA-Z]/g) || []).length;

  const chineseRatio = chineseLen / totalLen;
  const thaiRatio = thaiLen / totalLen;
  const foreignLen = thaiLen + viCharLen + latinLen;

  if (thaiRatio > 0.2 || thaiLen >= 4) return "th";

  // 越南文判斷：原本單一關鍵字命中就回傳 vi，但 da / ca / mai / toi / on / sang / nay
  // 在英文與印尼文句子中很常見，容易誤判。改成需要足夠證據才成立。
  const viStrongHits = (
    cleaned.match(/\b(anh|chi|em|oi|roi|duoc|khong|ko|lam|chieu|hom|vang|xin|cam|biet|viec|ngay|gio|nghi|tang)\b/gi) || []
  ).length;

  // on / sang / nay 本身就是常見英文單字，留在清單裡會把英文句子判成越南文，
  // 因此完全移除；其餘弱訊號字要湊滿兩個才成立。
  const viWeakHits = (
    cleaned.match(/\b(toi|mai|da|ca|hom|chieu)\b/gi) || []
  ).length;

  if (
    viCharLen >= 2 ||
    viStrongHits >= 1 ||
    viWeakHits >= 2
  ) {
    return "vi";
  }

  /*
    印尼文判斷。

    舊版只認日常口語詞（izin、sakit、cuti、gimana），工廠對話幾乎都撈不到，
    於是「Terlalu banyak sampah sehingga aliran air tersumbat」整句被判成英文，
    導致「跳過原文語言」失效 —— 印尼文訊息又被翻成印尼文回貼一次。

    這裡補三種證據，並且跟英文證據比大小才下判斷：
      1. 功能詞與工廠常用詞
      2. 構詞前綴 ter- / ber- / meng- / mem- / pen-（英文極少這樣構詞）
      3. 後綴 -nya / -kan / -lah / -pun
  */
  const idKeywordHits = (
    cleaned.match(/\b(ini|itu|dan|yang|untuk|dengan|tidak|nggak|gak|akan|ada|besok|pagi|kerja|malam|siang|sore|hari|jam|pulang|izin|sakit|iya|terima|kasih|makasih|selamat|cuti|lembur|sudah|udah|belum|belom|juga|tapi|sama|saya|aku|kamu|dia|kita|kami|anda|mereka|baru|lagi|sini|sana|mau|bisa|harus|boleh|tolong|silakan|silahkan|oke|okee|mungkin|gimana|begini|begitu|karena|kalau|atau|saja|masih|sangat|semua|setiap|sehingga|supaya|agar|lebih|kurang|banyak|sedikit|jangan|bukan|hanya|mohon|orang|pak|bapak|ibu|air|mesin|alat|barang|gudang|bagian|ruang|pintu|pipa|listrik|sampah|kotor|bersih|rusak|panas|dingin|mati|hidup|nyala|penuh|kosong|cepat|lambat|ganti|periksa|cek|masuk|keluar|selesai|sekarang|kemarin|coba|pakai|bawa|ambil|buang|perbaiki|kunci|minyak|oli|ya|kode|karyawan|nomor|nama|hasil|waktu|tempat|sedang|sendiri|punya|dapat|buat|lihat|tahu|kirim|terus|langsung|kembali|dulu|nanti|tadi)\b/gi) || []
  ).length;

  // 印尼文構詞前綴。英文偶爾會撞到（terminal、mention、pending），
  // 所以下面用「印尼文證據必須多於英文證據」來把這類情況排除。
  const idMorphHits = (
    cleaned.match(/\b(ter|ber|meng|meny|mem|men|peng|pem|pen)[a-z]{4,}\b/gi) || []
  ).length;

  const idSuffixHits = (
    cleaned.match(/\b[a-z]{3,}(nya|kan|lah|pun)\b/gi) || []
  ).length;

  // 英文證據。印尼文不使用這些詞，因此不會誤傷正確的印尼文句子。
  const enHits = (
    cleaned.match(/\b(the|is|are|was|were|please|this|that|these|those|will|would|should|have|has|had|been|with|and|for|you|your|we|our|they|their|not|there|here|because|when|which|from|about|after|before|need|make|check|of|to|in|on|at|it|as|by|be|an|do|does|did|can|could|may|must|all|any|some|more|than|then|only|but|also|now|today|tomorrow|please|my|me|him|her|his|she|he)\b/gi) || []
  ).length;

  const idScore = idKeywordHits + idMorphHits + idSuffixHits;

  if (chineseLen >= 1 && foreignLen === 0) return "zh-TW";
  if (chineseRatio >= 0.45 && chineseLen >= 1) return "zh-TW";

  if (idScore >= 2 && idScore > enHits) {
    return "id";
  }

  if (latinLen === 0) return "en";
  if (chineseLen >= 1) return "zh-TW";

  return "en";
}



function isPureChineseMessage(text = "") {
  const cleaned = normalizeTextForLangDetect(text);
  if (!cleaned) return false;

  const compact = cleaned.replace(/\s+/g, "");
  if (!compact) return false;

  const chineseLen = (compact.match(/[\u4e00-\u9fff]/g) || []).length;
  const thaiLen = (compact.match(/[\u0E00-\u0E7F]/g) || []).length;
  const viCharLen = (compact.match(/[\u0102-\u01B0\u1EA0-\u1EF9]/g) || []).length;
  const latinLen = (compact.match(/[a-zA-Z]/g) || []).length;
  const foreignLen = thaiLen + viCharLen + latinLen;
  const chineseRatio = chineseLen / (compact.length || 1);
  return chineseLen >= 1 && chineseRatio >= 0.6 && foreignLen === 0
;
}

function extractMentionsFromLineMessage(message) {
  const originalText = String(message?.text ?? "");
  const mentionees = message?.mention?.mentionees;

  if (!Array.isArray(mentionees) || mentionees.length === 0) {
    return {
      masked: originalText,
      segments: [],
      hasOfficialMentionData: false,
    };
  }

  const normalized = mentionees
    .map((m) => {
      const start = Number(m.index);
      const length = Number(m.length);
      const end = start + length;

      if (
        !Number.isInteger(start) ||
        !Number.isInteger(length) ||
        start < 0 ||
        length <= 0 ||
        end > originalText.length
      ) {
        return null;
      }

      return {
        ...m,
        start,
        end,
        mentionText: originalText.slice(start, end),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  if (normalized.length === 0) {
    console.warn("Invalid LINE mention metadata:", JSON.stringify(mentionees));
    return {
      masked: originalText,
      segments: [],
      hasOfficialMentionData: false,
    };
  }

  let masked = originalText;
  const segments = normalized.map((m, i) => ({
    key: `__MENTION_${i}__`,
    text: m.mentionText,
    index: m.start,
  }));

  for (let i = normalized.length - 1; i >= 0; i--) {
    const m = normalized[i];
    const key = `__MENTION_${i}__`;
    masked = masked.slice(0, m.start) + key + masked.slice(m.end);
  }

  if (DEBUG_TRANSLATION) {
    console.log("RAW official mention:", JSON.stringify(message.mention));
    console.log("masked after official replace:", masked);
    console.log("segments:", JSON.stringify(segments));
  }

  return {
    masked,
    segments,
    hasOfficialMentionData: true,
  };
}
function restoreMentions(text, segments) {
  let restored = text;
  segments.forEach(seg => {
    restored = restored.replace(new RegExp(seg.key, "g"), seg.text);
  });
  return restored;
}

function isValidLineUserId(userId = "") {
  return /^U[\w-]{10,}$/.test(userId);
}
function getMonthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

function normalizeMonthKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return getMonthKey();

  const compact = raw.replace(/-/g, "");
  if (/^\d{6}$/.test(compact)) return compact;

  return getMonthKey();
}

function toDateSafe(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const FALLBACK_SUBSCRIPTION_DEFAULTS = {
  trialDays: 14,
  trialMaxGroups: 2,
  trialMonthlyQuota: 300,

  paidPlan: "monthly",
  paidMonths: 1,
  paidMaxGroups: 5,
  paidMonthlyQuota: 3000,

  manualPlan: "custom",
  manualDays: 30,
  manualMaxGroups: 5,
  manualMonthlyQuota: 3000,
};

function toSafeInt(value, fallback, min = 0) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return Math.max(min, Math.floor(num));
}

function normalizeSubscriptionDefaults(raw = {}) {
  return {
    trialDays: toSafeInt(raw.trialDays, FALLBACK_SUBSCRIPTION_DEFAULTS.trialDays, 1),
    trialMaxGroups: toSafeInt(raw.trialMaxGroups, FALLBACK_SUBSCRIPTION_DEFAULTS.trialMaxGroups, 0),
    trialMonthlyQuota: toSafeInt(raw.trialMonthlyQuota, FALLBACK_SUBSCRIPTION_DEFAULTS.trialMonthlyQuota, 0),

    paidPlan: String(raw.paidPlan ?? FALLBACK_SUBSCRIPTION_DEFAULTS.paidPlan).trim() || "monthly",
    paidMonths: toSafeInt(raw.paidMonths, FALLBACK_SUBSCRIPTION_DEFAULTS.paidMonths, 1),
    paidMaxGroups: toSafeInt(raw.paidMaxGroups, FALLBACK_SUBSCRIPTION_DEFAULTS.paidMaxGroups, 0),
    paidMonthlyQuota: toSafeInt(raw.paidMonthlyQuota, FALLBACK_SUBSCRIPTION_DEFAULTS.paidMonthlyQuota, 0),

    manualPlan: String(raw.manualPlan ?? FALLBACK_SUBSCRIPTION_DEFAULTS.manualPlan).trim() || "custom",
    manualDays: toSafeInt(raw.manualDays, FALLBACK_SUBSCRIPTION_DEFAULTS.manualDays, 1),
    manualMaxGroups: toSafeInt(raw.manualMaxGroups, FALLBACK_SUBSCRIPTION_DEFAULTS.manualMaxGroups, 0),
    manualMonthlyQuota: toSafeInt(raw.manualMonthlyQuota, FALLBACK_SUBSCRIPTION_DEFAULTS.manualMonthlyQuota, 0),
  };
}

async function getSubscriptionDefaults() {
  const ref = db.collection("systemSettings").doc("subscriptionDefaults");
  const snap = await ref.get();

  const defaults = normalizeSubscriptionDefaults(snap.exists ? snap.data() : {});

  if (!snap.exists) {
    await ref.set(
      {
        ...defaults,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  return defaults;
}

function normalizeSubscriptionStatus(value, fallback = SUBSCRIPTION_STATUS.INACTIVE) {
  const raw = String(value || "").trim().toUpperCase().replace(/[\s-]/g, "_");
  const map = {
    TRIAL: SUBSCRIPTION_STATUS.TRIAL,
    ACTIVE: SUBSCRIPTION_STATUS.ACTIVE,
    MANUALACTIVE: SUBSCRIPTION_STATUS.MANUAL_ACTIVE,
    MANUAL_ACTIVE: SUBSCRIPTION_STATUS.MANUAL_ACTIVE,
    INACTIVE: SUBSCRIPTION_STATUS.INACTIVE,
    PAYMENTFAILED: SUBSCRIPTION_STATUS.PAYMENT_FAILED,
    PAYMENT_FAILED: SUBSCRIPTION_STATUS.PAYMENT_FAILED,
  };
  return map[raw] || fallback;
}

function normalizeManualOverride(value, fallback = MANUAL_OVERRIDE.NONE) {
  const raw = String(value || "").trim().toUpperCase().replace(/[\s-]/g, "_");
  const map = {
    NONE: MANUAL_OVERRIDE.NONE,
    FORCEACTIVE: MANUAL_OVERRIDE.FORCE_ACTIVE,
    FORCE_ACTIVE: MANUAL_OVERRIDE.FORCE_ACTIVE,
    FORCEINACTIVE: MANUAL_OVERRIDE.FORCE_INACTIVE,
    FORCE_INACTIVE: MANUAL_OVERRIDE.FORCE_INACTIVE,
  };
  return map[raw] || fallback;
}

function normalizeManualAction(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s-]/g, "_");
  const map = {
    activate: "activate",
    deactivate: "deactivate",
    forceactive: "force_active",
    force_active: "force_active",
    forceinactive: "force_inactive",
    force_inactive: "force_inactive",
    clearoverride: "clear_override",
    clear_override: "clear_override",
  };
  return map[raw] || raw;
}

function parseOptionalDateInput(value, fallback = undefined) {
  if (value === undefined) return fallback;
  if (value === "" || value === null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

async function getSubscriptionByUserId(userId) {
  if (!userId) return null;
  const doc = await db.collection("userSubscriptions").doc(userId).get();
  return doc.exists ? doc.data() : null;
}

async function getMonthlyUsage(userId, monthKey = getMonthKey(), { useCache = false } = {}) {
  const normalizedMonthKey = normalizeMonthKey(monthKey);
  const id = `${userId}_${normalizedMonthKey}`;

  if (useCache && usageCache.has(id)) {
    return usageCache.get(id);
  }

  const doc = await db.collection("usageMonthly").doc(id).get();

  const data = doc.exists
    ? doc.data()
    : {
        userId,
        monthKey: normalizedMonthKey,
        translationCount: 0,
        charCount: 0,
      };

  if (useCache) usageCache.set(id, data);
  return data;
}

async function incrementMonthlyUsage(userId, translationCount = 1, charCount = 0) {
  if (!userId) return;
  const monthKey = getMonthKey();
  const ref = db.collection("usageMonthly").doc(`${userId}_${monthKey}`);

  // 寫入後讓快取失效，避免額度判斷讀到過期數字
  usageCache.delete(`${userId}_${monthKey}`);

  await ref.set(
    {
      userId,
      monthKey,
      translationCount: admin.firestore.FieldValue.increment(translationCount),
      charCount: admin.firestore.FieldValue.increment(charCount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  usageCache.delete(`${userId}_${monthKey}`);
}

async function countGroupsByInviter(userId) {
  if (!userId) return 0;
  const snap = await db.collection("groupInviters").where("userId", "==", userId).get();
  return snap.size;
}

function invalidateSubscriptionCache(userId) {
  if (userId) subscriptionCache.delete(userId);
}

async function ensureSubscriptionDoc(userId, { useCache = false } = {}) {
  if (!userId) return null;

  if (useCache && subscriptionCache.has(userId)) {
    return subscriptionCache.get(userId);
  }

  const ref = db.collection("userSubscriptions").doc(userId);
  const doc = await ref.get();
  if (doc.exists) {
    if (useCache) subscriptionCache.set(userId, doc.data());
    return doc.data();
  }

  const defaults = await getSubscriptionDefaults();
  const now = new Date();
  const trialEnd = new Date(now);
  trialEnd.setDate(trialEnd.getDate() + defaults.trialDays);

  const initData = {
    userId,
    status: SUBSCRIPTION_STATUS.TRIAL,
    plan: "trial",
    trialEndsAt: trialEnd,
    currentPeriodEnd: null,
    maxGroups: defaults.trialMaxGroups,
    monthlyQuota: defaults.trialMonthlyQuota,
    usedQuota: 0,
    manualOverride: MANUAL_OVERRIDE.NONE,
    manualReason: "",
    lastPaymentStatus: "",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await ref.set(initData, { merge: true });
  subscriptionCache.set(userId, initData);
  return initData;
}
async function getBoundGroupsByInviter(userId) {
  if (!userId) return [];
  const snap = await db
    .collection("groupInviters")
    .where("userId", "==", userId)
    .get();

  return snap.docs.map(doc => ({
    gid: doc.id,
    ...doc.data(),
  }));
}

async function canBindGroupToInviter(userId, gid) {
  const sub = await ensureSubscriptionDoc(userId);
  const maxGroups = Number(sub?.maxGroups || 0);

  if (maxGroups <= 0) {
    return { ok: true, sub };
  }

  const groups = await getBoundGroupsByInviter(userId);
  const alreadyBound = groups.some(x => x.gid === gid);

  if (alreadyBound) {
    return { ok: true, sub, alreadyBound: true };
  }

  if (groups.length >= maxGroups) {
    return {
      ok: false,
      code: "BIND_GROUP_LIMIT",
      sub,
      message: `此授權最多只能綁定 ${maxGroups} 個群組，請先移除舊群組或升級方案。`,
    };
  }

  return { ok: true, sub };
}

async function canUseGroup(gid) {
  const inviterUserId = groupInviter.get(gid);
  if (!gid || !inviterUserId) {
    return { ok: false, code: "NO_INVITER", message: "此群組尚未綁定授權者。" };
  }

  // 這個函式每則訊息都會跑，訂閱狀態與用量都走短 TTL 快取，
  // 避免每則訊息固定兩次 Firestore read。
  const sub = await ensureSubscriptionDoc(inviterUserId, { useCache: true });
  const now = new Date();

  if (sub.manualOverride === MANUAL_OVERRIDE.FORCE_INACTIVE) {
    return {
      ok: false,
      code: "FORCE_INACTIVE",
      inviterUserId,
      sub,
      message: "此授權已被後台手動停用。"
    };
  }

  if (sub.manualOverride === MANUAL_OVERRIDE.FORCE_ACTIVE) {
    return { ok: true, code: "FORCE_ACTIVE", inviterUserId, sub };
  }

  const usage = await getMonthlyUsage(inviterUserId, getMonthKey(), { useCache: true });

  if (sub.monthlyQuota > 0 && (usage.translationCount || 0) >= sub.monthlyQuota) {
    return {
      ok: false,
      code: "QUOTA_EXCEEDED",
      inviterUserId,
      sub,
      usage,
      message: `本月額度已用完（${sub.monthlyQuota}）。`,
    };
  }

  if (sub.status === SUBSCRIPTION_STATUS.TRIAL) {
    const trialEndsAt = toDateSafe(sub.trialEndsAt);
    if (trialEndsAt && trialEndsAt >= now) {
      return { ok: true, code: "TRIAL_OK", inviterUserId, sub, usage };
    }
    return {
      ok: false,
      code: "TRIAL_EXPIRED",
      inviterUserId,
      sub,
      usage,
      message: "試用已到期，請完成付款。"
    };
  }

  if (
    sub.status === SUBSCRIPTION_STATUS.ACTIVE ||
    sub.status === SUBSCRIPTION_STATUS.MANUAL_ACTIVE
  ) {
    const currentPeriodEnd = toDateSafe(sub.currentPeriodEnd);
    if (!currentPeriodEnd || currentPeriodEnd >= now) {
      return { ok: true, code: "ACTIVE_OK", inviterUserId, sub, usage };
    }
    return {
      ok: false,
      code: "SUB_EXPIRED",
      inviterUserId,
      sub,
      usage,
      message: "訂閱已到期。"
    };
  }

  if (sub.status === SUBSCRIPTION_STATUS.PAYMENT_FAILED) {
    return {
      ok: false,
      code: "PAYMENT_FAILED",
      inviterUserId,
      sub,
      usage,
      message: "付款失敗，已停用服務。"
    };
  }

  return {
    ok: false,
    code: "INACTIVE",
    inviterUserId,
    sub,
    usage,
    message: "尚未開通訂閱。"
  };
}


async function activatePaidSubscription(userId, options = {}) {
  const defaults = await getSubscriptionDefaults();

  const plan = String(options.plan ?? defaults.paidPlan).trim() || defaults.paidPlan;
  const months = toSafeInt(options.months, defaults.paidMonths, 1);
  const maxGroups = toSafeInt(options.maxGroups, defaults.paidMaxGroups, 0);
  const monthlyQuota = toSafeInt(options.monthlyQuota, defaults.paidMonthlyQuota, 0);

  const ref = db.collection("userSubscriptions").doc(userId);
  const snap = await ref.get();
  const current = snap.exists ? snap.data() : null;

  const now = new Date();
  const currentEnd = toDateSafe(current?.currentPeriodEnd);
  const baseDate = currentEnd && currentEnd > now ? currentEnd : now;

  const end = new Date(baseDate);
  end.setMonth(end.getMonth() + months);

  const payload = {
    userId,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    plan,
    currentPeriodEnd: end,
    maxGroups,
    monthlyQuota,
    manualOverride: MANUAL_OVERRIDE.NONE,
    manualReason: "",
    lastPaymentStatus: "paid",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (!snap.exists) {
    payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }

  await ref.set(payload, { merge: true });
  invalidateSubscriptionCache(userId);
}

async function markPaymentFailed(userId) {
  const ref = db.collection("userSubscriptions").doc(userId);
  const snap = await ref.get();
  const current = snap.exists ? snap.data() : null;

  const isManualProtected =
    current?.status === SUBSCRIPTION_STATUS.MANUAL_ACTIVE ||
    current?.manualOverride === MANUAL_OVERRIDE.FORCE_ACTIVE;

  if (isManualProtected) {
    await ref.set(
      {
        userId,
        lastPaymentStatus: "failed",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    invalidateSubscriptionCache(userId);
    return;
  }

  await ref.set(
    {
      userId,
      status: SUBSCRIPTION_STATUS.PAYMENT_FAILED,
      lastPaymentStatus: "failed",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  invalidateSubscriptionCache(userId);
}


function getAllKnownGroupIds() {
  return [...new Set([
    ...groupLang.keys(),
    ...groupInviter.keys(),
    ...groupIndustry.keys()
  ])].sort();
}

function isAuthorizedOperator(gid, uid) {
  const inviter = groupInviter.get(gid);
  if (!inviter) return true;
  return inviter === uid;
}

// ✅ Step 3: ensureInviterIfMissing 加入封鎖檢查
async function ensureInviterIfMissing(gid, uid) {
  if (!gid || !uid) {
    return { ok: false, message: "缺少 gid 或 uid" };
  }

  // 機器人曾退出或被踢出的群組，不重建設定
  if (deletedGroups.has(gid)) {
    return { ok: false, code: "GROUP_DELETED", message: "此群組已停用翻譯服務。" };
  }

  let inviter = groupInviter.get(gid);
  if (inviter) {
    return { ok: true, inviter, alreadyBound: true };
  }

  const bindCheck = await canBindGroupToInviter(uid, gid);
  if (!bindCheck.ok) {
    return bindCheck;
  }

  groupInviter.set(gid, uid);
  await saveInviterForGroup(gid, {
    boundAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: uid,
  });

  return { ok: true, inviter: uid };
}


async function getGroupMemberDisplayName(gid, uid) {
  if (!gid || !uid) return uid || "未知使用者";

  const cacheKey = `${gid}:${uid}`;
  const cached = displayNameCache.get(cacheKey);
  if (cached) return cached;

  try {
    const profile = await client.getGroupMemberProfile(gid, uid);
    const name = profile.displayName || uid;
    displayNameCache.set(cacheKey, name);
    return name;
  } catch {
    return uid;
  }
}

async function getGroupSummaryCached(gid) {
  if (!gid) return null;
  if (groupSummaryCache.has(gid)) return groupSummaryCache.get(gid);

  const result = { groupName: null, memberCount: null };

  try {
    const summary = await client.getGroupSummary(gid);
    result.groupName = summary?.groupName || null;
  } catch (e) {
    console.warn("取得群組名稱失敗:", gid, e.message);
  }

  try {
    const countRes = await client.getGroupMembersCount(gid);
    result.memberCount = countRes?.count ?? null;
  } catch (e) {
    console.warn("取得群組人數失敗:", gid, e.message);
  }

  groupSummaryCache.set(gid, result);
  return result;
}
async function getUserDisplayNameByUserId(userId) {
  if (!userId) return null;

  try {
    const snap = await db
      .collection("groupInviters")
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snap.empty) return null;

    const gid = snap.docs[0].id;
    return await getGroupMemberDisplayName(gid, userId);
  } catch {
    return null;
  }
}

async function safeReply(replyToken, text) {
  if (!replyToken) {
    console.error("❌ 無 replyToken，略過回覆");
    return false;
  }

  try {
    await client.replyMessage(replyToken, {
      type: "text",
      text
    });
    return true;
  } catch (e) {
    console.error(
      "❌ LINE Reply 失敗，不改用 Push：",
      e.response?.data || e.message
    );
    return false;
  }
}
async function safeReplyOrPush(replyToken, gid, text) {
  if (replyToken) {
    try {
      await client.replyMessage(replyToken, {
        type: "text",
        text
      });
      return true;
    } catch (e) {
      console.error(
        "LINE Reply 失敗，改用 Push：",
        e.response?.data || e.message
      );
    }
  }

  if (!gid) {
    console.error("safeReplyOrPush 缺少 gid");
    return false;
  }

  try {
    await client.pushMessage(gid, {
      type: "text",
      text
    });
    return true;
  } catch (e) {
    console.error(
      "LINE Push 失敗：",
      e.response?.data || e.message
    );
    return false;
  }
}
// LINE 文字訊息上限 5000 字元，留一點安全邊界。
// 超過上限時整則 API 呼叫會失敗，翻譯就整個消失。
const LINE_TEXT_LIMIT = 4800;

function splitTextForLine(text, limit = LINE_TEXT_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let buffer = "";

  for (const line of text.split("\n")) {
    // 單行本身就超長，硬切
    if (line.length > limit) {
      if (buffer) {
        chunks.push(buffer);
        buffer = "";
      }
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      continue;
    }

    if (buffer.length + line.length + 1 > limit) {
      chunks.push(buffer);
      buffer = line;
    } else {
      buffer = buffer ? `${buffer}\n${line}` : line;
    }
  }

  if (buffer) chunks.push(buffer);
  return chunks;
}

async function sendLongText(replyToken, gid, text) {
  const chunks = splitTextForLine(text);

  const ok = await safeReplyOrPush(replyToken, gid, chunks[0]);

  for (let i = 1; i < chunks.length; i++) {
    if (!gid) break;
    try {
      await client.pushMessage(gid, { type: "text", text: chunks[i] });
    } catch (e) {
      console.error("LINE Push 續傳失敗：", e.response?.data || e.message);
      break;
    }
  }

  return ok;
}

async function loadLang() {
  const snapshot = await db.collection("groupLanguages").get();
  snapshot.forEach(doc => {
    const langs = Array.isArray(doc.data().langs) ? doc.data().langs : [];
    groupLang.set(doc.id, new Set(langs));
  });
}

async function loadInviter() {
  const snapshot = await db.collection("groupInviters").get();
  snapshot.forEach(doc => {
    const userId = doc.data().userId;
    if (userId) groupInviter.set(doc.id, userId);
  });
}

async function loadIndustry() {
  const snapshot = await db.collection("groupIndustries").get();
  snapshot.forEach(doc => {
    const industry = doc.data().industry;
    if (industry) groupIndustry.set(doc.id, industry);
  });
}

let industryContextMap = new Map(); // name → promptContext

async function loadIndustryMaster({ force = false } = {}) {
  // 後台多支 API 都會呼叫這支，沒有節流的話等於每次請求都重讀整個 collection
  if (!force && Date.now() - industryMasterLoadedAt < INDUSTRY_MASTER_TTL) {
    return;
  }

  const snapshot = await db.collection("systemIndustries").get();
  industryMasterLoadedAt = Date.now();
  industryMasterDocs = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
  // 同步更新 context map
  industryContextMap.clear();
  industryMasterDocs.forEach(doc => {
    if (doc.name && doc.promptContext) {
      industryContextMap.set(doc.name, doc.promptContext);
    }
  });
}

// ✅ Step 2: 載入已封鎖的群組 ID
async function loadDeletedGroups() {
  const snapshot = await db.collection("deletedGroups").get();
  snapshot.forEach(doc => deletedGroups.add(doc.id));
  console.log(`✅ 已載入 ${deletedGroups.size} 個封鎖群組`);
}

async function saveLangForGroup(gid) {
  const ref = db.collection("groupLanguages").doc(gid);
  const set = groupLang.get(gid) || new Set();
  if (set.size > 0) {
    await ref.set({ langs: [...set] }, { merge: true });
  } else {
    await ref.delete().catch(() => {});
  }
}

async function saveInviterForGroup(gid, extra = {}) {
  const ref = db.collection("groupInviters").doc(gid);
  const userId = groupInviter.get(gid);

  if (userId) {
    await ref.set(
      {
        userId,
        ...extra,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await ref.delete().catch(() => {});
  }
}

async function saveIndustryForGroup(gid) {
  const ref = db.collection("groupIndustries").doc(gid);
  const industry = groupIndustry.get(gid);
  if (industry) {
    await ref.set({ industry }, { merge: true });
  } else {
    await ref.delete().catch(() => {});
  }
}

// ✅ Step 3 (deleteGroupSettings): 退群時寫入 deletedGroups
async function deleteGroupSettings(gid) {
  /*
    群組名稱必須在「bot 還在群組裡」的此刻就記下來。
    一旦退群，就無法再向 LINE API 查詢群組資訊，
    事後補查一定失敗，後台封鎖清單就只剩一串看不懂的 gid。
  */
  let groupName = null;
  try {
    const summary = await getGroupSummaryCached(gid);
    groupName = summary?.groupName || null;
  } catch {
    // 已退群或 API 失敗都不該影響封鎖流程，名稱留空即可
  }

  const inviterUserId = groupInviter.get(gid) || null;

  await Promise.allSettled([
    db.collection("groupLanguages").doc(gid).delete(),
    db.collection("groupInviters").doc(gid).delete(),
    db.collection("groupIndustries").doc(gid).delete(),
    // 寫入封鎖清單，防止重新自動建立
    db.collection("deletedGroups").doc(gid).set({
      groupName,
      inviterUserId,
      deletedAt: admin.firestore.FieldValue.serverTimestamp()
    })
  ]);
  groupLang.delete(gid);
  groupInviter.delete(gid);
  groupIndustry.delete(gid);
  groupSummaryCache.delete(gid);
  deletedGroups.add(gid);
}

async function addAdminLog(action, detail, actor = "admin", extra = {}) {
  try {
    await db.collection("adminLogs").add({
      action,
      detail,
      actor,
      extra,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.error("admin log 寫入失敗:", e.message);
  }
}
function buildTranslationPrompt(targetLang, industry, forceStrict = false) {
  const langLabel = SUPPORTED_LANGS[targetLang] || targetLang;

  const industryDoc = industry
    ? industryMasterDocs.find(x => x.name === industry)
    : null;

  const industryContext =
    industryDoc?.promptContext ||
    (industry
      ? `工作類型：${industry}。僅在原文明確涉及此領域時，使用常用、清楚的術語。`
      : "");

  const targetLanguageRule = `
輸出語言規則：
- 本次目標語言是「${langLabel}」。
- 必須將原文中可翻譯的內容完整翻譯為「${langLabel}」。
- 不得直接照抄原文，不得輸出以中文為主的內容。
- 公司名稱、客戶名稱、廠區名稱、地名、站所名稱、產品名稱或內部識別名稱，
  若沒有可靠的常用譯名，可以保留原樣。
- 但是故障情況、維修動作、設備零件、材料、數量描述、工作指示與一般名詞，
  一律必須翻譯成「${langLabel}」。
- 除機台代號、型號、批號、料號、工單號、ERP 代碼、數字、日期、時間、
  URL、Email、@提及 placeholder 外，不得保留整句中文原文。
- 輸出中不得殘留任何中文計量單位（米、條、支、個、台、片、組、箱、張、層、號…）。
  數量描述必須整組翻譯，例如「2米X 1條」不可原樣保留。
- 只輸出翻譯結果，不要解釋、不要加標題、不要說明翻譯規則。
`.trim();


  return `
你是專業即時翻譯引擎。將原文翻譯成「${langLabel}」。

翻譯規則：
1. 先理解原文的實際情境，再進行自然、準確的翻譯。涉及特定工作領域時優先使用該領域的專業術語；日常對話則使用自然、簡單、口語的表達，避免公文式語氣。
2. 只翻譯原文寫出來的內容。不要補上原文沒有的動作、指示、原因或結論——名詞就翻成名詞，除非原文本身有動詞。
3. 忠實傳達原文語意，不得自行增加、刪除或改變原文未明確表達的主詞、受詞、代詞、對象或人稱。
4. 以下內容一律原樣保留，不翻譯也不改寫：
   - 機台代號、房號、床號、型號、批號、料號、工單號、ERP 代碼
   - 英文縮寫、全大寫英文詞、英數混合代碼、單一英文字母代號（A、B、C）
   - 數字、日期、時間、URL、Email、@提及 placeholder
   例外：該英文詞在句中明顯是一般單字時（如 email me、check、OK），照一般文字翻譯。
   注意：「保留數字」指的是保留阿拉伯數字本身，不包含中文計量單位。
   數量與尺寸的中文單位（米、公尺、公分、條、支、片、個、台、組、箱、包、
   張、塊、根、把、件、層、樓、號、度、公斤、小時…）一律必須翻譯成目標語言。
   例如「2米X 1條」要翻成目標語言的「2 公尺 X 1 條」對應說法，不可原樣輸出「2米X 1條」。
   已經是英數格式的尺寸（如 98cmx291cm）則保留原樣。
5. 保留原文的換行格式。只輸出翻譯結果，不要加上說明、前後綴或語言名稱。
6. 公司名稱、客戶名稱、地點名稱、廠區名稱、站所名稱、產品名稱或其他專有識別名稱，
若沒有可靠、常用的目標語言名稱，可以原樣保留；其餘描述、動作、故障情況、維修項目與指示，必須翻譯為目標語言。

${industryContext}
${targetLanguageRule}
`.trim();
}
const LANG_ENGLISH_NAMES = {
  en: "English",
  th: "Thai",
  vi: "Vietnamese",
  id: "Bahasa Indonesia",
  "zh-TW": "Traditional Chinese"
};

/*
  判斷原文是否為「短的專有名詞／代號」。

  prompt 第 6 條本來就允許公司名、廠區名、產品名原樣保留，
  但輸出語系檢查看到「目標是越南文卻沒有拉丁字母」就會判定失敗，
  等於自己打自己。像「景碩」這種兩個字的公司名會白跑一次 fallback，
  最後吐出「（翻譯異常，請稍後再試）」。

  這裡只認定「短、且沒有句子結構」的內容，
  一般短句（下班、休假、加班）仍然會照常要求翻譯。
*/
function looksLikeShortProperNoun(text = "") {
  const raw = String(text).trim();
  if (!raw) return false;

  // 有標點、換行或多個詞 → 是句子，不是名稱
  if (/[\n。，、！？；：,.!?;]/.test(raw)) return false;
  if (raw.split(/\s+/).filter(Boolean).length > 2) return false;

  const letters = raw.replace(/[^\p{L}]/gu, "");
  if (!letters) return false;

  const chineseLen = (letters.match(/[\u4e00-\u9fff]/g) || []).length;

  if (chineseLen === letters.length) {
    // 中文名稱：4 字以內（景碩、台積電、鴻海精密）
    if (chineseLen > 4) return false;

    // 但「下班」「休假」「加班」也是短中文，這些必須照常翻譯。
    // 含常用動作／狀態字的一律不走這條快速通道。
    // 誤擋的公司名（例如「上銀」）仍會由下方「兩個模型都原樣輸出」那層接住，
    // 只是多花一次 API 呼叫，比放行未翻譯的句子安全。
    if (/[請要有沒去來上下開關停修換做走到在班假休加工好壞多少幾點早晚今明昨天嗎吧了會能可不是我你他們送收發領交籤退進出]/.test(raw)) {
      return false;
    }

    return true;
  }

  // 拉丁字母代號：短且是型號樣式
  return /^[A-Za-z0-9\-_/.]{1,12}$/.test(raw);
}

/*
  偵測「數字後面接中文計量單位」的殘留，例如 2米、1條、3片。

  這是刻意設計成很窄的檢查：
  - isOutputValidForLang 是用來抓「整句沒翻譯」的，看的是中文比例，
    像「2米X 1條」這種只佔 2 個字的殘留完全抓不到（也不該用比例去抓）。
  - 但如果放寬成「輸出含任何中文就算失敗」，公司名、廠區名原樣保留
    （prompt 本來就允許）就會被誤殺。

  因此只認「阿拉伯數字 + 中文單位字」這個組合。公司名或人名不會長這樣，
  誤判率極低，卻能精準抓到這類漏翻。
*/
const CHINESE_UNIT_CHARS = "米條支片個台組箱包張塊根把件層樓號度捲卷袋桶瓶罐顆粒隻只束捆盒杯碗份位名排套副對雙打車面尺寸吋碼升斤克噸坪";
const LEFTOVER_UNIT_RE = new RegExp(`\\d\\s*[${CHINESE_UNIT_CHARS}]`);

function hasLeftoverChineseUnit(out = "", targetLang = "") {
  if (targetLang === "zh-TW") return false;
  return LEFTOVER_UNIT_RE.test(String(out));
}

function buildTranslationCacheKey(text, targetLang, industry, systemPrompt) {
  // 原本的 key 帶了 gid 和整段 systemPrompt：
  //  - gid 讓「同行業別、不同群組」無法共用快取，命中率大幅下降
  //  - systemPrompt 完全由 targetLang + industry 決定，是冗餘資訊，還讓每筆 key 多背 1KB
  const promptHash = crypto
    .createHash("sha1")
    .update(systemPrompt)
    .digest("hex")
    .slice(0, 8);

  return `${targetLang}:${industry || ""}:${promptHash}:${text}`;
}

async function translateWithChatGPT(
  text,
  targetLang,
  gid = null,
  retry = 0,
  customPrompt = "",
  modelName = "gpt-5.6-luna",
  options = {}
) {
  if (!text?.trim()) return text;
  if (isOnlyEmojiOrWhitespace(text)) return text;

  const industry = gid ? groupIndustry.get(gid) : null;
  const sourceLang = options.sourceLang || null;

  // 所有翻譯為繁中的訊息，都直接啟用繁中嚴格規則
  const systemPrompt =
    customPrompt ||
    buildTranslationPrompt(
      targetLang,
      industry,
      targetLang === "zh-TW"
    );

  const cacheKey = buildTranslationCacheKey(text, targetLang, industry, systemPrompt);

  // fallback 成功時，結果要同時寫回「原始 key」，
  // 否則同一句話下次進來還是會先讓主模型失敗一次，等於長期付雙倍成本。
  const primaryCacheKey = options.primaryCacheKey || cacheKey;

  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  try {
    const res = await axios.post(
  "https://api.openai.com/v1/chat/completions",
  {
    model: modelName,
    max_completion_tokens: 1000,
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: text
      }
    ]
  },
  {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    timeout: OPENAI_TIMEOUT_MS
  }
);

    let out =
      res.data?.choices?.[0]?.message?.content?.trim() || "";

    out = out
      .split("\n")
      .map(line => line.trimEnd())
      .join("\n")
      .trim();

    // 共用輸出語系檢查 ＋ 繁中特殊處理
    const unchanged = out.trim() === text.trim();
    const sourceHasChinese = /[\u4e00-\u9fff]/.test(text);

    // 原本就是中文，且目標也是繁中，AI 原樣輸出 → 視為正常（人名、型號、代碼等）
    if (targetLang === "zh-TW" && unchanged && sourceHasChinese) {
      translationCache.set(cacheKey, out);
      if (primaryCacheKey !== cacheKey) translationCache.set(primaryCacheKey, out);
      return out;
    }

    // 短的專有名詞／代號被原樣輸出，是 prompt 明確允許的行為，
    // 不該送進輸出語系檢查（否則「景碩」翻越南文永遠會失敗）
    if (unchanged && looksLikeShortProperNoun(text)) {
      console.log("ℹ️ 專有名詞原樣保留：", { targetLang, text });
      translationCache.set(cacheKey, out);
      if (primaryCacheKey !== cacheKey) translationCache.set(primaryCacheKey, out);
      return out;
    }

    // 檢查輸出是否符合目標語言的字元特徵
    const isValid = isOutputValidForLang(out, targetLang);

    if (!isValid) {
      console.warn("⚠️ 翻譯輸出語系不符合目標語言，準備重試：", {
        targetLang,
        retry,
        text,
        out
      });

      // Luna 的輸出語言不符合要求時，不再用 Luna 連續重試，
      // 直接改由較穩定的 gpt-4.1-mini 做一次 fallback。
      if (retry < 1) {
        const targetLanguageName = LANG_ENGLISH_NAMES[targetLang] || targetLang;

        // 原本這段寫死「the user's Chinese message」，
        // 但泰文／越南文原文翻成繁中時也會走到這裡，提示語言就是錯的。
        const sourceLanguageName = sourceLang
          ? (LANG_ENGLISH_NAMES[sourceLang] || sourceLang)
          : null;

        const sourceClause = sourceLanguageName
          ? `The source message is in ${sourceLanguageName}.`
          : "";

        const fallbackPrompt = `
${buildTranslationPrompt(targetLang, industry, true)}

FINAL OUTPUT CORRECTION — MANDATORY:
The previous response failed to translate: it echoed the source language
or produced a different language than requested.

Translate the user's message into ${targetLanguageName}. ${sourceClause}

Output requirements:
- Output ONLY the ${targetLanguageName} translation.
- Do NOT copy or repeat the source sentence in its original language.
- Do NOT answer in any language other than ${targetLanguageName}.
- Translate all repair actions, equipment names, fault descriptions, materials and instructions.
- A short company name, factory name, place name, model number, code, quantity,
  phone number, date, time, URL, Email, or __MENTION_n__ placeholder may remain unchanged.
- The output must contain substantial ${targetLanguageName} text.
- Do not explain. Do not add a title.
`.trim();

        console.warn("↪️ Luna 輸出不合格，改用 gpt-4.1-mini fallback：", {
          targetLang,
          sourceLang,
          retry,
          text
        });

        return translateWithChatGPT(
          text,
          targetLang,
          gid,
          retry + 1,
          fallbackPrompt,
          "gpt-4.1-mini",
          { sourceLang, primaryCacheKey }
        );
      }

      // 重試仍失敗。
      // 但若 fallback 模型也選擇原樣輸出，代表兩個獨立模型都認為這段內容不需要翻譯
      // （廠名、人名、代號…），這是可信的訊號，直接原樣放行比吐錯誤訊息好。
      if (unchanged) {
        console.log("ℹ️ 兩個模型皆原樣輸出，視為不可翻譯內容：", { targetLang, text });
        translationCache.set(cacheKey, out);
        if (primaryCacheKey !== cacheKey) translationCache.set(primaryCacheKey, out);
        return out;
      }

      // 輸出既不是目標語言、也不是原文 → 真的異常，不要貼出去。
      // 這種佔位字串不進快取，否則整整 24 小時都會回同一句錯誤訊息。
      return targetLang === "zh-TW"
        ? "（繁中翻譯異常，請稍後再試）"
        : "（翻譯異常，請稍後再試）";
    }

    /*
      輸出語言正確，但殘留了「2米X 1條」這種中文計量單位。
      這是「大致正確、局部漏翻」，跟整句沒翻不同，所以處理方式也不同：
      重試一次，而且只有在重試結果確實變好時才採用。
      重試失敗就沿用原本的翻譯 —— 局部漏翻仍然遠比一句錯誤訊息有用。
    */
    if (retry < 1 && hasLeftoverChineseUnit(out, targetLang)) {
      const targetLanguageName = LANG_ENGLISH_NAMES[targetLang] || targetLang;

      const unitFixPrompt = `
${buildTranslationPrompt(targetLang, industry, true)}

UNIT CORRECTION — MANDATORY:
The previous response left Chinese measure words untranslated
(for example 米 / 條 / 支 / 個 / 台 / 片 / 張 / 層).

Rewrite the translation into ${targetLanguageName} so that:
- Every quantity and dimension uses ${targetLanguageName} unit words.
  "2米X 1條" must become the ${targetLanguageName} equivalent of "2 meters X 1 strip".
- Arabic numerals stay as digits.
- Sizes already written in Latin form (e.g. 98cmx291cm) stay unchanged.
- No Chinese unit character may remain anywhere in the output.
- Output ONLY the translation. Do not explain.
`.trim();

      console.warn("⚠️ 輸出殘留中文計量單位，嘗試修正：", { targetLang, out });

      const retried = await translateWithChatGPT(
        text,
        targetLang,
        gid,
        retry + 1,
        unitFixPrompt,
        "gpt-4.1-mini",
        { sourceLang }
      );

      const improved =
        typeof retried === "string" &&
        retried.trim() &&
        isOutputValidForLang(retried, targetLang) &&
        !hasLeftoverChineseUnit(retried, targetLang);

      if (improved) {
        out = retried;
      } else {
        console.warn("↩️ 單位修正未改善，沿用原譯文");
      }
    }

    translationCache.set(cacheKey, out);
    if (primaryCacheKey !== cacheKey) translationCache.set(primaryCacheKey, out);
    return out;


  } catch (e) {
    const errMsg =
      e.response?.data?.error?.message || e.message;

    console.error(
      `❌ [${SUPPORTED_LANGS[targetLang] || targetLang}] 翻譯失敗:`,
      errMsg
    );

    const isRetryable =
      e.code === "ECONNABORTED" ||
      e.code === "ETIMEDOUT" ||
      [429, 500, 502, 503].includes(e.response?.status);

    if (isRetryable && retry < 1) {
      const delay = Math.min(
        1000 * Math.pow(2, retry),
        5000
      );

      await new Promise(resolve => setTimeout(resolve, delay));

      return translateWithChatGPT(
        text,
        targetLang,
        gid,
        retry + 1,
        customPrompt,
        modelName,
        { sourceLang, primaryCacheKey }
      );
    }

    return `[${text.substring(0, 20)}...翻譯失敗]`;
  }
}

async function translateLineSegments(line, targetLang, gid, segments, sourceLang = null) {
    const lineWithoutMentions = line.replace(/__MENTION_\d+__/g, "").trim();
  if (!lineWithoutMentions) {
    return restoreMentions(line, segments);  // 直接還原，不翻譯
  }
  const segs = [];
  let lastIndex = 0;
  const mentionRegex = /__MENTION_\d+__/g;
  let match;

  while ((match = mentionRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segs.push({ type: "text", text: line.slice(lastIndex, match.index) });
    }
    segs.push({ type: "mention", text: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < line.length) {
    segs.push({ type: "text", text: line.slice(lastIndex) });
  }

  let outLine = "";

  for (const seg of segs) {
    if (seg.type === "mention") {
      outLine += seg.text;
      continue;
    }

    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    let lastIdx = 0;
    let urlMatch;

    while ((urlMatch = urlRegex.exec(seg.text)) !== null) {
const beforeUrl = seg.text.slice(lastIdx, urlMatch.index);
if (beforeUrl.trim()) {
  const leadingSpace = beforeUrl.match(/^\s*/)[0];
  const trailingSpace = beforeUrl.match(/\s*$/)[0];
  if (!hasChinese(beforeUrl) && isSymbolOrNum(beforeUrl.trim())) {
    outLine += beforeUrl;
  } else {
    outLine += leadingSpace + (await translateWithChatGPT(beforeUrl.trim(), targetLang, gid, 0, "", "gpt-5.6-luna", { sourceLang })).trim() + trailingSpace;
  }
}
outLine += urlMatch[0];
lastIdx = urlMatch.index + urlMatch[0].length;
    }

const afterLastUrl = seg.text.slice(lastIdx);
if (afterLastUrl.trim()) {
  const leadingSpace = afterLastUrl.match(/^\s*/)[0];
  const trailingSpace = afterLastUrl.match(/\s*$/)[0];
  if (!hasChinese(afterLastUrl) && isSymbolOrNum(afterLastUrl.trim())) {
    outLine += afterLastUrl;
  } else {
    outLine += leadingSpace + (await translateWithChatGPT(afterLastUrl.trim(), targetLang, gid, 0, "", "gpt-5.6-luna", { sourceLang })).trim() + trailingSpace;
  }
}
  }
const restored = restoreMentions(outLine, segments);

if (DEBUG_TRANSLATION) {
  console.log("🔎 mention restore check:", {
    targetLang,
    originalLine: line,
    beforeRestore: outLine,
    segments,
    afterRestore: restored
  });
}

return restored;
}

async function processTranslationInBackground(replyToken, gid, uid, masked, segments, rawLines, langSet, sourceLang, ownerUserId, hasOfficialMentionData = false) {
  const allNeededLangs = new Set();
  const langOutputs = {};

  const textOnly = masked
    .replace(/__MENTION_\d+__/g, "")
    .replace(/(https?:\/\/[^\s]+)/gi, "")
    .replace(/\s+/g, "")
    .trim();

  if (!textOnly) {
  console.log("Skip mention-only or URL-only message");
  return;
}

  const mergedText = rawLines.join("\n");
  const normalizedMergedText = normalizeTextForLangDetect(mergedText);

  const chineseLen = (normalizedMergedText.match(/[\u4e00-\u9fff]/g) || []).length;
  const thaiLen = (normalizedMergedText.match(/[\u0E00-\u0E7F]/g) || []).length;
  const viCharLen = (normalizedMergedText.match(/[\u0102-\u01B0\u1EA0-\u1EF9]/g) || []).length;
  const latinLen = (normalizedMergedText.match(/[a-zA-Z]/g) || []).length;

  const totalMeaningfulLen = normalizedMergedText.replace(/\s+/g, "").length || 1;
  const chineseRatio = chineseLen / totalMeaningfulLen;
  const foreignLen = thaiLen + viCharLen + latinLen;

  const isChineseDominant =
    (chineseLen >= 2 && chineseRatio >= 0.45) ||
    (chineseLen >= 4 && foreignLen === 0);

if (!isChineseDominant) {
  allNeededLangs.add("zh-TW");
}

/*
  sourceLang 是目前訊息偵測出的原文語言。

  - 中文為主：群組勾選的每個外文都要翻。
    例如「明天請 @Pakat 06:30 上班」，
    即使 @Pakat 是泰文姓名，也仍必須輸出泰文。

  - 非中文為主：跳過原文語言，避免把泰文再翻泰文、
    越南文再翻越南文或印尼文再翻印尼文。

  hasOfficialMentionData 保留給 mention 的官方遮罩／還原流程使用，
  不用它來決定是否跳過來源語言。
*/
const isForeignSource = ["en", "th", "vi", "id"].includes(sourceLang);

const shouldSkipSourceLanguage =
  isForeignSource &&
  !isChineseDominant;

[...langSet].forEach(code => {
  if (code === "zh-TW") return;

  if (shouldSkipSourceLanguage && code === sourceLang) {
    return;
  }

  allNeededLangs.add(code);
});

  const targetLangs = [...allNeededLangs];
  if (!targetLangs.length) return;

  let translationTimedOut = false;

  const tasks = targetLangs.map(async code => {
    try {
      const result = await translateLineSegments(mergedText, code, gid, segments, sourceLang);
      langOutputs[code] = result;
    } catch (e) {
      console.error(`❌ ${code} 翻譯失敗:`, e.message);
      langOutputs[code] = "";
    }
  });

  // 原本的 setTimeout 沒有清掉，每則訊息都會多留一個 28 秒的 timer
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      translationTimedOut = true;
      reject(new Error("Translation timeout"));
    }, TRANSLATION_TOTAL_TIMEOUT_MS);
  });

  try {
    await Promise.race([Promise.allSettled(tasks), timeoutPromise]);
  } catch (e) {
    console.error("⚠️ 翻譯處理超時或部分失敗:", e.message);
  } finally {
    clearTimeout(timeoutHandle);
  }

  let replyText = "";

  for (const code of targetLangs) {
    const result = langOutputs[code];
    if (!result || !result.trim()) {
      replyText += `${LANG_LABELS[code] || code}：\n（翻譯失敗或逾時）\n\n`;
      continue;
    }
    replyText += `${LANG_LABELS[code] || code}：\n${result.trim()}\n\n`;
  }

  if (!replyText.trim()) return;

  /*
    所有語言的結果都跟原文完全相同 → 整則訊息只有廠名／人名／代號，
    回覆「🇻🇳：景碩」對群組沒有任何資訊量，只是洗版。直接不回。
    （translateLineSegments 會還原 mention，所以要拿還原後的原文來比對）
  */
  const restoredSource = restoreMentions(mergedText, segments).trim();
  const allIdenticalToSource =
    targetLangs.length > 0 &&
    targetLangs.every(code => (langOutputs[code] || "").trim() === restoredSource);

  if (allIdenticalToSource) {
    console.log("ℹ️ 各語言輸出皆與原文相同，略過回覆：", restoredSource);
    return;
  }

  if (translationTimedOut) {
    replyText = `⚠️ 部分翻譯逾時，以下內容可能不完整。\n\n${replyText}`;
  }

  const userName = await getGroupMemberDisplayName(gid, uid);
  const fullText = `【${userName}】說：\n${replyText.trim()}`;

  // 這裡原本用 safeReply（明確不 push）。但翻譯是背景進行的，
  // 主模型 25 秒 + fallback 25 秒之後 replyToken 很可能已失效，
  // 一旦 reply 失敗整則翻譯就無聲消失，額度卻照扣。改用 reply 失敗自動轉 push。
  await sendLongText(replyToken, gid, fullText);

  // 成本與目標語言數成正比，額度不應該固定只扣 1
  await incrementMonthlyUsage(ownerUserId, targetLangs.length, masked.length);
}

async function fetchImageUrlsByDate(gid, dateStr) {
  try {
    const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file", { timeout: 20000 });
    const $ = load(res.data);
    const detailUrls = [];

    $("table.sub-table tbody.tbody tr").each((_, tr) => {
      const tds = $(tr).find("td");
      const dateCell = tds.eq(1).text().trim().replace(/\s+/g, "");
      if (/\d{4}\/\d{2}\/\d{2}/.test(dateCell) && dateCell === dateStr.replace(/-/g, "/")) {
        const href = tds.eq(0).find("a").attr("href");
        if (href) detailUrls.push(`https://fw.wda.gov.tw${href}`);
      }
    });

    const wanted = groupLang.get(gid) || new Set();
    const images = new Set();

    for (const url of detailUrls) {
      try {
        const d = await axios.get(url, { timeout: 20000 });
        const $$ = load(d.data);
        $$(".text-photo a").each((_, el) => {
          const label = $$(el).find("p").text().trim().replace(/\d.*$/, "").trim();
          const code = NAME_TO_CODE[label];
          if (code && wanted.has(code)) {
            const imgUrl = $$(el).find("img").attr("src");
            if (imgUrl) images.add(`https://fw.wda.gov.tw${imgUrl}`);
          }
        });
      } catch (e) {
        console.error("❌ 細節頁失敗:", e.message);
      }
    }

    return [...images];
  } catch (e) {
    console.error("❌ 主頁抓圖失敗:", e.message);
    return [];
  }
}

async function sendImagesToGroup(gid, dateStr) {
  const imgs = await fetchImageUrlsByDate(gid, dateStr);
  let success = 0;

  for (const url of imgs) {
    try {
      await client.pushMessage(gid, {
        type: "image",
        originalContentUrl: url,
        previewImageUrl: url
      });
      success++;
    } catch (e) {
      console.error(`❌ 推播圖片失敗: ${url}`, e.message);
    }
  }

  return success;
}

async function sendMenu(gid, retry = 0) {
  const langItems = Object.entries(SUPPORTED_LANGS)
    .filter(([code]) => code !== "zh-TW")
    .map(([code, label]) => ({ code, label, icon: LANG_ICONS[code] || "" }));

  const langRows = [];
  for (let i = 0; i < langItems.length; i += 2) {
    const row = [];
    const item1 = langItems[i];

    row.push({
      type: "button",
      action: { type: "postback", label: `${item1.icon} ${item1.label}`, data: `action=set_lang&code=${item1.code}` },
      style: "primary",
      color: "#1E293B",
      height: "sm",
      flex: 1,
      margin: "sm"
    });

    if (i + 1 < langItems.length) {
      const item2 = langItems[i + 1];
      row.push({
        type: "button",
        action: { type: "postback", label: `${item2.icon} ${item2.label}`, data: `action=set_lang&code=${item2.code}` },
        style: "primary",
        color: "#1E293B",
        height: "sm",
        flex: 1,
        margin: "sm"
      });
    } else {
      row.push({ type: "filler", flex: 1 });
    }

    langRows.push({ type: "box", layout: "horizontal", contents: row, margin: "md" });
  }

  const msg = {
    type: "flex",
    altText: "語言設定控制台",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0F172A",
        paddingAll: "20px",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              { type: "text", text: "⚙️ SYSTEM CONFIG", color: "#38BDF8", weight: "bold", size: "xs", flex: 1 },
              { type: "text", text: "v4.0", color: "#64748B", size: "xs", align: "end" }
            ],
            paddingBottom: "md"
          },
          { type: "separator", color: "#334155" },
          { type: "text", text: i18n["zh-TW"].menuTitle, weight: "bold", size: "xl", color: "#F8FAFC", margin: "md", align: "center" },
          { type: "text", text: "TARGET LANGUAGE SELECTOR", weight: "bold", size: "xxs", color: "#38BDF8", margin: "xs", align: "center" },
          { type: "box", layout: "vertical", margin: "lg", contents: langRows },
          { type: "separator", color: "#334155", margin: "xl" },
          { type: "text", text: "ADVANCED SETTINGS", color: "#64748B", size: "xxs", margin: "lg" },
          {
            type: "button",
            action: { type: "postback", label: "🏭 設定行業別", data: "action=show_industry_menu" },
            style: "primary",
            color: "#10B981",
            margin: "md",
            height: "sm"
          },
          {
            type: "button",
            action: { type: "postback", label: "❌ 清除語言設定", data: "action=set_lang&code=cancel" },
            style: "secondary",
            color: "#EF4444",
            margin: "sm",
            height: "sm"
          }
        ]
      }
    }
  };

  try {
    await client.pushMessage(gid, msg);
  } catch (e) {
    console.error("sendMenu 失敗:", e.response?.data || e.message);
    if (e.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 10000));
      return sendMenu(gid, retry + 1);
    }
  }
}

function buildIndustryMenu() {
  const industries = getEnabledIndustryNames();
  const buttons = industries.map(ind => ({
    type: "button",
    action: { type: "postback", label: ind, data: `action=set_industry&industry=${encodeURIComponent(ind)}` },
    style: "primary",
    color: "#334155",
    height: "sm",
    margin: "xs"
  }));

  if (!buttons.length) {
    buttons.push({ type: "text", text: "目前尚未建立可用行業類別", color: "#CBD5E1", size: "sm", wrap: true });
  }

  return {
    type: "flex",
    altText: "行業模式選擇",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0F172A",
        paddingAll: "20px",
        contents: [
          { type: "text", text: "INDUSTRY MODE", color: "#38BDF8", weight: "bold", size: "xs" },
          { type: "text", text: "選擇行業類別", weight: "bold", size: "xl", color: "#F8FAFC", margin: "sm" },
          { type: "separator", color: "#334155", margin: "md" },
          { type: "box", layout: "vertical", margin: "lg", contents: buttons },
          { type: "separator", color: "#334155", margin: "xl" },
          {
            type: "button",
            action: { type: "postback", label: "🚫 清除設定 / 不指定", data: "action=set_industry&industry=" },
            style: "secondary",
            color: "#EF4444",
            margin: "lg",
            height: "sm"
          }
        ]
      }
    }
  };
}

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

const adminAuth = basicAuth({
  users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
  challenge: false,
  safe: true, // timing-safe 比較，避免帳密被時間差推敲
  unauthorizedResponse: () => ({ success: false, error: "未登入或帳號密碼錯誤" })
});

/*
  注意：public/ 是完全公開的靜態目錄。
  /admin 這組 API 有 basic auth 保護，但後台「頁面本身」（HTML/JS）沒有，
  任何人都能直接開啟並看到後台介面結構。

  設定 PROTECT_ADMIN_STATIC=1 可以把檔名含 admin 的靜態檔一併納入驗證。
  這裡使用 challenge: true，瀏覽器才會跳出輸入帳密的視窗。
  預設關閉，以免影響現有前端的載入方式。
*/
if (process.env.PROTECT_ADMIN_STATIC === "1") {
  const staticAdminAuth = basicAuth({
    users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
    challenge: true,
    safe: true
  });

  app.use((req, res, next) => {
    if (/admin/i.test(req.path)) return staticAdminAuth(req, res, next);
    return next();
  });
}

app.use(express.static(path.join(__dirname, "public")));

const adminRouter = express.Router();
adminRouter.use(adminLimiter);
adminRouter.use(adminAuth);
adminRouter.use(express.json({ limit: "1mb" }));

adminRouter.get("/constants", async (req, res) => {
  await loadIndustryMaster();
  res.json({ success: true, SUPPORTED_LANGS, industries: getEnabledIndustryNames() });
});

adminRouter.get("/dashboard", async (req, res) => {
  try {
    await loadIndustryMaster();

    const monthKey = getMonthKey();
    const now = new Date();
    const expiringThreshold = new Date(now);
    expiringThreshold.setDate(expiringThreshold.getDate() + 7);

    const allGids = getAllKnownGroupIds();
    const groupsWithIndustry = allGids.filter(gid => !!groupIndustry.get(gid)).length;
    const groupsWithLang = allGids.filter(
      gid => (groupLang.get(gid) || new Set()).size > 0
    ).length;

    const langUsage = {};
    Object.keys(SUPPORTED_LANGS).forEach(code => {
      langUsage[code] = 0;
    });
    allGids.forEach(gid => {
      (groupLang.get(gid) || new Set()).forEach(code => {
        langUsage[code] = (langUsage[code] || 0) + 1;
      });
    });

    const [logSnapshot, subscriptionSnapshot, usageSnapshot] = await Promise.all([
      db.collection("adminLogs").orderBy("createdAt", "desc").limit(20).get(),
      db.collection("userSubscriptions").get(),
      db.collection("usageMonthly").where("monthKey", "==", monthKey).get(),
    ]);

    const usageByUser = new Map();
    let monthlyTranslations = 0;
    let monthlyChars = 0;

    usageSnapshot.forEach(doc => {
      const usage = doc.data();
      const userId = usage.userId;
      const translationCount = Number(usage.translationCount || 0);
      const charCount = Number(usage.charCount || 0);

      if (userId) {
        usageByUser.set(userId, {
          translationCount,
          charCount,
          monthKey: usage.monthKey || monthKey,
        });
      }

      monthlyTranslations += translationCount;
      monthlyChars += charCount;
    });

    const subscriptionStatus = {
      trial: 0,
      active: 0,
      manualActive: 0,
      inactive: 0,
      paymentFailed: 0,
    };

    const quotaAlerts = {
      normal: 0,
      warning80: 0,
      exhausted: 0,
      unlimited: 0,
    };

    const expiringSoon = [];

    subscriptionSnapshot.forEach(doc => {
      const sub = doc.data();
      const userId = doc.id;
      const status = normalizeSubscriptionStatus(sub.status);
      const manualOverride = normalizeManualOverride(sub.manualOverride);
      const usage = usageByUser.get(userId) || {
        translationCount: 0,
        charCount: 0,
      };

      if (status === SUBSCRIPTION_STATUS.TRIAL) subscriptionStatus.trial++;
      else if (status === SUBSCRIPTION_STATUS.ACTIVE) subscriptionStatus.active++;
      else if (status === SUBSCRIPTION_STATUS.MANUAL_ACTIVE) subscriptionStatus.manualActive++;
      else if (status === SUBSCRIPTION_STATUS.PAYMENT_FAILED) subscriptionStatus.paymentFailed++;
      else subscriptionStatus.inactive++;

      const quota = Number(sub.monthlyQuota || 0);
      const used = Number(usage.translationCount || 0);

      if (quota <= 0) {
        quotaAlerts.unlimited++;
      } else if (used >= quota) {
        quotaAlerts.exhausted++;
      } else if (used / quota >= 0.8) {
        quotaAlerts.warning80++;
      } else {
        quotaAlerts.normal++;
      }

      const expiresAt = status === SUBSCRIPTION_STATUS.TRIAL
        ? toDateSafe(sub.trialEndsAt)
        : toDateSafe(sub.currentPeriodEnd);

      if (
        expiresAt &&
        expiresAt >= now &&
        expiresAt <= expiringThreshold &&
        status !== SUBSCRIPTION_STATUS.INACTIVE &&
        status !== SUBSCRIPTION_STATUS.PAYMENT_FAILED
      ) {
        expiringSoon.push({
          userId,
          status,
          plan: sub.plan || "",
          expiresAt,
          used,
          quota,
        });
      }
    });

    expiringSoon.sort((a, b) => a.expiresAt - b.expiresAt);

    const recentLogs = logSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({
      success: true,
      stats: {
        totalGroups: allGids.length,
        groupsWithLang,
        groupsWithIndustry,
        totalIndustries: industryMasterDocs.length,
        enabledIndustries: getEnabledIndustryNames().length,
        langUsage,

        monthKey,
        monthlyTranslations,
        monthlyChars,
        subscriptionStatus,
        quotaAlerts,
        expiringSoonCount: expiringSoon.length,
      },
      expiringSoon: expiringSoon.slice(0, 10),
      recentLogs,
    });
  } catch (e) {
    console.error("GET /admin/dashboard:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/groups", async (req, res) => {
  try {
    const monthKey = getMonthKey();
    const allGids = getAllKnownGroupIds();

    const inviterIds = [
      ...new Set(
        allGids
          .map(gid => groupInviter.get(gid))
          .filter(Boolean)
      ),
    ];

    const [subscriptionDocs, usageDocs] = await Promise.all([
      Promise.all(
        inviterIds.map(async userId => [
          userId,
          await getSubscriptionByUserId(userId),
        ])
      ),
      Promise.all(
        inviterIds.map(async userId => [
          userId,
          await getMonthlyUsage(userId, monthKey),
        ])
      ),
    ]);

    const subscriptionByUser = new Map(subscriptionDocs);
    const usageByUser = new Map(usageDocs);

    const groups = await Promise.all(
      allGids.map(async gid => {
        const inviter = groupInviter.get(gid) || null;
        let inviterName = null;

        // 原本每個群組固定打 3 次 LINE API，群組一多就會非常慢且容易撞 rate limit
        const summary = await getGroupSummaryCached(gid);
        const groupName = summary?.groupName ?? null;
        const memberCount = summary?.memberCount ?? null;

        if (inviter) {
          inviterName = await getGroupMemberDisplayName(gid, inviter);
        }

        const rawSub = inviter ? subscriptionByUser.get(inviter) : null;
        const rawUsage = inviter
          ? usageByUser.get(inviter)
          : { translationCount: 0, charCount: 0, monthKey };

        const subscription = rawSub
          ? {
              status: normalizeSubscriptionStatus(rawSub.status),
              plan: rawSub.plan || "",
              monthlyQuota: Number(rawSub.monthlyQuota || 0),
              maxGroups: Number(rawSub.maxGroups || 0),
              trialEndsAt: rawSub.trialEndsAt || null,
              currentPeriodEnd: rawSub.currentPeriodEnd || null,
              manualOverride: normalizeManualOverride(rawSub.manualOverride),
            }
          : null;

        const usage = {
          translationCount: Number(rawUsage?.translationCount || 0),
          charCount: Number(rawUsage?.charCount || 0),
          monthKey: rawUsage?.monthKey || monthKey,
        };

        const quota = subscription?.monthlyQuota ?? 0;
        const used = usage.translationCount;
        const usagePercent = quota > 0
          ? Math.round((used / quota) * 100)
          : null;

        return {
          gid,
          groupName,
          memberCount,
          langs: [...(groupLang.get(gid) || new Set())],
          industry: groupIndustry.get(gid) || null,
          inviter,
          inviterName,
          subscription,
          usage: {
            ...usage,
            usagePercent,
            quotaState: quota <= 0
              ? "UNLIMITED"
              : used >= quota
                ? "EXHAUSTED"
                : usagePercent >= 80
                  ? "WARNING"
                  : "NORMAL",
          },
        };
      })
    );

    res.json({ success: true, monthKey, groups });
  } catch (e) {
    console.error("GET /admin/groups:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});
adminRouter.get("/groups/:gid", async (req, res) => {
  try {
    const { gid } = req.params;
    const inviter = groupInviter.get(gid) || null;

    let inviterName = null;

    const summary = await getGroupSummaryCached(gid);
    const groupName = summary?.groupName ?? null;
    const memberCount = summary?.memberCount ?? null;

    if (inviter) {
      inviterName = await getGroupMemberDisplayName(gid, inviter);
    }

    res.json({
      success: true,
      group: {
        gid,
        groupName,
        memberCount,
        langs: [...(groupLang.get(gid) || new Set())],
        industry: groupIndustry.get(gid) || null,
        inviter,
        inviterName
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


adminRouter.put("/groups/:gid/settings", async (req, res) => {
  try {
    const { gid } = req.params;
    const langs = Array.isArray(req.body.langs) ? req.body.langs.filter(code => SUPPORTED_LANGS[code]) : [];
    const industry = String(req.body.industry || "").trim();
    const inviter = String(req.body.inviter || "").trim();

    if (industry && !isValidIndustry(industry)) {
      return res.status(400).json({ success: false, error: i18n["zh-TW"].invalidIndustry });
    }
    if (inviter && !isValidLineUserId(inviter)) {
      return res.status(400).json({ success: false, error: i18n["zh-TW"].invalidUserId });
    }
    if (inviter) {
  const bindCheck = await canBindGroupToInviter(inviter, gid);
  if (!bindCheck.ok) {
    return res.status(400).json({
      success: false,
      error: bindCheck.message,
      code: bindCheck.code,
    });
  }
}

    groupLang.set(gid, new Set(langs));
    if (industry) groupIndustry.set(gid, industry); else groupIndustry.delete(gid);
    if (inviter) groupInviter.set(gid, inviter); else groupInviter.delete(gid);

    await Promise.all([
      saveLangForGroup(gid),
      saveIndustryForGroup(gid),
      saveInviterForGroup(gid)
    ]);

    await addAdminLog("UPSERT_GROUP_SETTINGS", `更新群組 ${gid} 設定`, req.auth.user, { gid, langs, industry, inviter });

    res.json({ success: true, group: { gid, langs, industry: industry || null, inviter: inviter || null } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.delete("/groups/:gid/settings", async (req, res) => {
  try {
    const { gid } = req.params;
    await deleteGroupSettings(gid);
    await addAdminLog("DELETE_GROUP_SETTINGS", `刪除群組 ${gid} 設定`, req.auth.user, { gid });
    res.json({ success: true, gid });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
adminRouter.get("/groups-blocked", async (req, res) => {
  try {
    const snapshot = await db.collection("deletedGroups")
      .orderBy("deletedAt", "desc")
      .get();

    const items = await Promise.all(
      snapshot.docs.map(async doc => {
        const data = doc.data();
        let groupName = data.groupName || null;

        /*
          舊的封鎖紀錄沒有存 groupName。
          bot 通常已經不在群組裡，查詢多半會失敗，但成本很低（有快取），
          萬一是「還在群組但被後台封鎖」的情況就能補到名稱。
          查不到就給 null，前端自行顯示 gid。
        */
        if (!groupName) {
          const summary = await getGroupSummaryCached(doc.id);
          groupName = summary?.groupName || null;
        }

        let inviterName = null;
        if (data.inviterUserId) {
          inviterName = await getGroupMemberDisplayName(doc.id, data.inviterUserId);
        }

        return {
          gid: doc.id,
          ...data,
          groupName,
          inviterName,
          // 前端可直接顯示這欄，不必自己判斷有沒有名稱
          displayName: groupName || `(未命名群組) ${doc.id.slice(0, 10)}…`
        };
      })
    );

    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
// ✅ 後台手動解除封鎖（讓群組可以重新綁定）
adminRouter.delete("/groups/:gid/blocked", async (req, res) => {
  try {
    const { gid } = req.params;

    // 先讀出名稱再刪，否則刪掉就查不到了，log 會只剩 gid
    let groupName = null;
    try {
      const doc = await db.collection("deletedGroups").doc(gid).get();
      groupName = doc.exists ? (doc.data().groupName || null) : null;
    } catch {
      // 讀不到不影響解除封鎖
    }

    await db.collection("deletedGroups").doc(gid).delete();
    deletedGroups.delete(gid);
    await addAdminLog(
      "UNBLOCK_GROUP",
      `解除封鎖群組 ${groupName ? `${groupName} (${gid})` : gid}`,
      req.auth.user,
      { gid, groupName }
    );
    res.json({ success: true, gid });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.post("/groups/:gid/send-menu", async (req, res) => {
  try {
    await sendMenu(req.params.gid);
    await addAdminLog("SEND_GROUP_MENU", `推送設定選單到群組 ${req.params.gid}`, req.auth.user, { gid: req.params.gid });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/industries", async (req, res) => {
  try {
    await loadIndustryMaster();
    const items = industryMasterDocs.sort((a, b) => (a.sortOrder || 9999) - (b.sortOrder || 9999));
    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.post("/industries", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const sortOrder = Number(req.body.sortOrder || 9999);
    const enabled = req.body.enabled !== false;

    if (!name) return res.status(400).json({ success: false, error: "name 不可空白" });

    await loadIndustryMaster();
    if (industryMasterDocs.some(x => x.name === name)) {
      return res.status(400).json({ success: false, error: "行業名稱已存在" });
    }

    const ref = await db.collection("systemIndustries").add({
      name,
      sortOrder,
      enabled,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await loadIndustryMaster({ force: true });
    await addAdminLog("CREATE_INDUSTRY", `新增行業 ${name}`, req.auth.user, { id: ref.id, name });
    res.json({ success: true, item: { id: ref.id, name, sortOrder, enabled } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.put("/industries/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const name = String(req.body.name || "").trim();
    const sortOrder = Number(req.body.sortOrder ?? 9999);
    const enabled = req.body.enabled !== false;
    const promptContext = String(req.body.promptContext || "").trim();

    if (!name) return res.status(400).json({ success: false, error: "name 不可空白" });

    await loadIndustryMaster();
    const exists = industryMasterDocs.find(x => x.id === id);
    if (!exists) return res.status(404).json({ success: false, error: "找不到此行業" });

    const ref = db.collection("systemIndustries").doc(id);
    await ref.set(
      {
        name,
        sortOrder,
        enabled,
        promptContext,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    await loadIndustryMaster({ force: true });
    await addAdminLog("UPDATE_INDUSTRY", `更新行業 ${id} → ${name}`, req.auth.user, { id, name, sortOrder, enabled, promptContext });

    res.json({ success: true, id, name, sortOrder, enabled, promptContext });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.delete("/industries/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.collection("systemIndustries").doc(id).get();
    const name = doc.exists ? doc.data().name : null;
    await db.collection("systemIndustries").doc(id).delete();
    await loadIndustryMaster({ force: true });
    await addAdminLog("DELETE_INDUSTRY", `刪除行業 ${name || id}`, req.auth.user, { id, name });
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/logs", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const action = String(req.query.action || "").trim();
    const snapshot = await db.collection("adminLogs").orderBy("createdAt", "desc").limit(200).get();
    let items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    if (action) items = items.filter(x => x.action === action);
    if (q) {
      items = items.filter(x => [x.action, x.detail, x.actor, JSON.stringify(x.extra || {})].join(" ").toLowerCase().includes(q));
    }

    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/subscriptions", async (req, res) => {
  try {
    const snapshot = await db.collection("userSubscriptions").get();

    const items = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const userId = doc.id;
        const displayName = await getUserDisplayNameByUserId(userId);
        const groupsCount = await countGroupsByInviter(userId);

        return {
          userId,
          displayName: displayName || "",
          groupsCount,
          ...doc.data(),
        };
      })
    );

    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


adminRouter.get("/subscription-defaults", async (req, res) => {
  try {
    const defaults = await getSubscriptionDefaults();
    res.json({ success: true, defaults });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.put("/subscription-defaults", async (req, res) => {
  try {
    const ref = db.collection("systemSettings").doc("subscriptionDefaults");
    const snap = await ref.get();

    const defaults = normalizeSubscriptionDefaults(req.body || {});
    const payload = {
      ...defaults,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!snap.exists) {
      payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await ref.set(payload, { merge: true });

    await addAdminLog(
      "UPDATE_SUBSCRIPTION_DEFAULTS",
      "subscriptionDefaults",
      req.auth.user,
      defaults
    );

    res.json({ success: true, defaults });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/subscriptions/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const sub = await getSubscriptionByUserId(userId);
    const usage = await getMonthlyUsage(userId);
    const groupsCount = await countGroupsByInviter(userId);
    const displayName = await getUserDisplayNameByUserId(userId);

    res.json({
      success: true,
      userId,
      displayName: displayName || "",
      subscription: sub
        ? {
            ...sub,
            userId,
            displayName: displayName || "",
          }
        : null,
      usage,
      groupsCount,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ 新增：刪除使用者授權資料
adminRouter.delete("/subscriptions/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ success: false, error: "缺少 userId" });

    await db.collection("userSubscriptions").doc(userId).delete();
    invalidateSubscriptionCache(userId);

    await addAdminLog(
      "DELETE_SUBSCRIPTION",
      `刪除使用者授權 ${userId}`,
      req.auth.user,
      { userId }
    );

    res.json({ success: true, userId });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
// 設定授權
adminRouter.put("/subscriptions/:userId/config", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isValidLineUserId(userId)) {
      return res.status(400).json({ error: "userId 格式不正確" });
    }

    const {
      status,
      plan,
      lastPaymentStatus,
      trialEndsAt,
      currentPeriodEnd,
      maxGroups,
      monthlyQuota,
      manualOverride,
      manualReason,
    } = req.body;

    const payload = {
      userId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (status !== undefined)           payload.status           = normalizeSubscriptionStatus(status);
    if (plan !== undefined)             payload.plan             = String(plan || "").trim();
    if (lastPaymentStatus !== undefined) payload.lastPaymentStatus = String(lastPaymentStatus || "").trim();
    if (maxGroups !== undefined)        payload.maxGroups        = toSafeInt(maxGroups, 0, 0);
    if (monthlyQuota !== undefined)     payload.monthlyQuota     = toSafeInt(monthlyQuota, 0, 0);
    if (manualOverride !== undefined)   payload.manualOverride   = normalizeManualOverride(manualOverride);
    if (manualReason !== undefined)     payload.manualReason     = String(manualReason || "").trim();

    const trialDate = parseOptionalDateInput(trialEndsAt);
    if (trialDate !== undefined)        payload.trialEndsAt      = trialDate;

    const periodDate = parseOptionalDateInput(currentPeriodEnd);
    if (periodDate !== undefined)       payload.currentPeriodEnd = periodDate;

    const ref = db.collection("userSubscriptions").doc(userId);
    const snap = await ref.get();
    if (!snap.exists) payload.createdAt = admin.firestore.FieldValue.serverTimestamp();

    await ref.set(payload, { merge: true });
    invalidateSubscriptionCache(userId);

    await addAdminLog("subscription_config", `設定授權 ${userId}`, "admin", payload);

    res.json({ ok: true });
  } catch (e) {
    console.error("PUT /subscriptions/:userId/config 錯誤:", e.message);
    res.status(500).json({ error: e.message });
  }
});
adminRouter.put("/subscriptions/:userId/manual", async (req, res) => {
  try {
    const userId = req.params.userId;
    const defaults = await getSubscriptionDefaults();

    const action = normalizeManualAction(req.body?.action);
    const plan = String(req.body?.plan ?? defaults.manualPlan).trim() || defaults.manualPlan;
    const days = toSafeInt(req.body?.days, defaults.manualDays, 1);
    const maxGroups = toSafeInt(req.body?.maxGroups, defaults.manualMaxGroups, 0);
    const monthlyQuota = toSafeInt(req.body?.monthlyQuota, defaults.manualMonthlyQuota, 0);
    const reason = String(req.body?.reason || "").trim();

    const ref = db.collection("userSubscriptions").doc(userId);
    const snap = await ref.get();
    const current = snap.exists ? snap.data() : null;

    if (action === "activate") {
      const now = new Date();
      const currentEnd = toDateSafe(current?.currentPeriodEnd);
      const baseDate = currentEnd && currentEnd > now ? currentEnd : now;

      const end = new Date(baseDate);
      end.setDate(end.getDate() + days);

      const payload = {
        userId,
        status: SUBSCRIPTION_STATUS.MANUAL_ACTIVE,
        plan,
        currentPeriodEnd: end,
        maxGroups,
        monthlyQuota,
        manualOverride: MANUAL_OVERRIDE.NONE,
        manualReason: reason || "admin manual activate",
        lastPaymentStatus: "manual",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!snap.exists) {
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
        payload.usedQuota = 0;
      }

      await ref.set(payload, { merge: true });
    } else if (action === "deactivate") {
      const payload = {
        userId,
        status: SUBSCRIPTION_STATUS.INACTIVE,
        manualOverride: MANUAL_OVERRIDE.NONE,
        manualReason: reason || "admin manual deactivate",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!snap.exists) {
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
      }

      await ref.set(payload, { merge: true });
    } else if (action === "force_active") {
      const payload = {
        userId,
        manualOverride: MANUAL_OVERRIDE.FORCE_ACTIVE,
        manualReason: reason || "admin force active",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!snap.exists) {
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
        payload.status = SUBSCRIPTION_STATUS.MANUAL_ACTIVE;
        payload.usedQuota = 0;
      }

      await ref.set(payload, { merge: true });
    } else if (action === "force_inactive") {
      const payload = {
        userId,
        manualOverride: MANUAL_OVERRIDE.FORCE_INACTIVE,
        manualReason: reason || "admin force inactive",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!snap.exists) {
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
      }

      await ref.set(payload, { merge: true });
    } else if (action === "clear_override") {
      await ref.set(
        {
          manualOverride: MANUAL_OVERRIDE.NONE,
          manualReason: "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      return res.status(400).json({ success: false, error: `不支援的 action: ${action}` });
    }

    invalidateSubscriptionCache(userId);

    await addAdminLog("MANUAL_SUBSCRIPTION", `手動操作 ${userId} → ${action}`, req.auth.user, { userId, action, plan, days, maxGroups, monthlyQuota, reason });

    const updated = await getSubscriptionByUserId(userId);
    res.json({ success: true, userId, subscription: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.use("/admin", adminRouter);
app.get("/ping", (req, res) => res.sendStatus(200));
app.post(
  "/webhook",
  webhookLimiter,
  middleware(lineConfig),
  async (req, res) => {
    res.sendStatus(200);
    const events = req.body.events || [];

    // 原本是序列 for await：一批多個事件時，後面事件的 replyToken
    // 會被前面的處理時間拖到過期。改成併發處理。
    await Promise.allSettled(
      events.map(event =>
        handleEvent(event).catch(e => {
          console.error("handleEvent error:", e);
        })
      )
    );
  }
);

async function handleEvent(event) {
  const gid = event.source?.groupId || null;
  const uid = event.source?.userId || null;
  const replyToken = event.replyToken || null;

  if (event.type === "leave" && gid) {
    await deleteGroupSettings(gid);
    return null;
  }

  if (event.type === "join" && gid) {
    await sendMenu(gid);
    return null;
  }

  if (event.type === "postback" && gid && uid) {
    const data = new URLSearchParams(event.postback?.data || "");
    const action = data.get("action");

    if (action === "set_lang") {
      const ensureRes = await ensureInviterIfMissing(gid, uid);
      if (!ensureRes.ok) {
        await safeReplyOrPush(replyToken, gid, ensureRes.message);
        return null;
      }

      if (!isAuthorizedOperator(gid, uid)) {
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].noPermission);
        return null;
      }

      const code = data.get("code");

      if (code === "cancel") {
        groupLang.set(gid, new Set());
        await saveLangForGroup(gid);
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].langCanceled);
        return null;
      }

      if (!SUPPORTED_LANGS[code]) return null;

      const set = groupLang.get(gid) || new Set();
      if (set.has(code)) {
        set.delete(code);
      } else {
        set.add(code);
      }
      groupLang.set(gid, set);
      await saveLangForGroup(gid);

      const selectedLabels = [...set].map(c => SUPPORTED_LANGS[c]).join("、");
      const msg = set.size > 0
        ? i18n["zh-TW"].langSelected.replace("{langs}", selectedLabels)
        : i18n["zh-TW"].langCanceled;

      await safeReplyOrPush(replyToken, gid, msg);
      return null;
    }

    if (action === "show_industry_menu") {
      const ensureRes = await ensureInviterIfMissing(gid, uid);
      if (!ensureRes.ok) {
        await safeReplyOrPush(replyToken, gid, ensureRes.message);
        return null;
      }

      if (!isAuthorizedOperator(gid, uid)) {
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].noPermission);
        return null;
      }

      await loadIndustryMaster();
      await client.replyMessage(replyToken, buildIndustryMenu());
      return null;
    }

    if (action === "set_industry") {
      const ensureRes = await ensureInviterIfMissing(gid, uid);
      if (!ensureRes.ok) {
        await safeReplyOrPush(replyToken, gid, ensureRes.message);
        return null;
      }

      if (!isAuthorizedOperator(gid, uid)) {
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].noPermission);
        return null;
      }

      const industry = decodeURIComponent(data.get("industry") || "").trim();

      if (!industry) {
        groupIndustry.delete(gid);
        await saveIndustryForGroup(gid);
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].industryCleared);
        return null;
      }

      await loadIndustryMaster();
      if (!isValidIndustry(industry)) {
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].invalidIndustry);
        return null;
      }

      groupIndustry.set(gid, industry);
      await saveIndustryForGroup(gid);
      await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].industrySet.replace("{industry}", industry));
      return null;
    }
  }

  if (event.type === "message" && event.message?.type === "text" && gid && uid) {
    const rawText = event.message.text || "";

    if (rawText.trim() === "!設定") {
      const ensureRes = await ensureInviterIfMissing(gid, uid);
      if (!ensureRes.ok) {
        await safeReplyOrPush(replyToken, gid, ensureRes.message);
        return null;
      }

      if (!isAuthorizedOperator(gid, uid)) {
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].noPermission);
        return null;
      }

      await sendMenu(gid);
      return null;
    }

    const propagandaMatch = rawText.trim().match(/^!文宣\s+(\d{4}-\d{2}-\d{2})$/);
    if (propagandaMatch) {
      const dateStr = propagandaMatch[1];
      const langSet = groupLang.get(gid) || new Set();

      if (langSet.size === 0) {
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].noLanguageSetting);
        return null;
      }

      await safeReplyOrPush(replyToken, gid, `正在抓取 ${dateStr} 的文宣圖片，請稍候...`);
      const count = await sendImagesToGroup(gid, dateStr);

      if (count > 0) {
        await client.pushMessage(gid, { type: "text", text: i18n["zh-TW"].propagandaPushed.replace("{dateStr}", dateStr) });
      } else {
        await client.pushMessage(gid, { type: "text", text: i18n["zh-TW"].propagandaNotFound });
      }
      return null;
    }

    if (rawText.trim().startsWith("!")) return null;

    const langSet = groupLang.get(gid);
    if (!langSet || langSet.size === 0) return null;
if (DEBUG_TRANSLATION && event.message?.mention) {
  console.log("RAW official mention:", JSON.stringify(event.message.mention));
}

    const { masked, segments, hasOfficialMentionData } = extractMentionsFromLineMessage(event.message);
    const normalizedForDetect = normalizeTextForLangDetect(masked);

    if (!normalizedForDetect.trim()) return null;
    if (isOnlyEmojiOrWhitespace(normalizedForDetect)) return null;
    if (isSymbolOrNum(normalizedForDetect)) return null;
    // 單一英文字母通常是尺寸、代號、表格欄位或設備標記；不翻譯、不回覆。
if (
  /^[A-Za-z]$/.test(normalizedForDetect) ||
  (
    /^[A-Za-z0-9_-]{2,10}$/.test(normalizedForDetect) &&
    (
      /\d/.test(normalizedForDetect) ||
      normalizedForDetect === normalizedForDetect.toUpperCase()
    )
  )
) {
  return null;
}


    const sourceLang = detectLang(normalizedForDetect);

    const useResult = await canUseGroup(gid);
    if (!useResult.ok) return null;

 const rawLines = masked.split("\n");
    if (!rawLines.length) return null;

    processTranslationInBackground(
      replyToken, gid, uid, masked, segments, rawLines,
      langSet, sourceLang, useResult.inviterUserId, hasOfficialMentionData
    ).catch(e => console.error("背景翻譯失敗:", e));
  }

  return null;
}
// === PING 伺服器 ===
// PING_URL 未設定時原本每 10 分鐘就會丟一次例外，這裡直接跳過
if (process.env.PING_URL) {
  setInterval(() => {
    try {
      https.get(process.env.PING_URL, r => console.log("📡 PING", r.statusCode))
        .on("error", e => console.error("PING 失敗:", e.message));
    } catch (e) {
      console.error("PING 失敗:", e.message);
    }
  }, 10 * 60 * 1000).unref();
} else {
  console.warn("⚠️ 未設定 PING_URL，略過保活 ping");
}

process.on("unhandledRejection", reason => {
  console.error("❌ unhandledRejection:", reason);
});

process.on("uncaughtException", err => {
  console.error("❌ uncaughtException:", err);
});
// ✅ Step 4: 啟動時載入封鎖群組清單
Promise.all([
  loadLang(),
  loadInviter(),
  loadIndustry(),
  loadIndustryMaster(),
  loadDeletedGroups()
]).then(() => {
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
  });

  const shutdown = signal => {
    console.log(`🛑 收到 ${signal}，準備關閉...`);
    server.close(() => {
      console.log("✅ HTTP server 已關閉");
      process.exit(0);
    });
    // 逾時仍未關閉就強制結束，避免卡住部署流程
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}).catch(e => {
  console.error("❌ 初始化失敗:", e);
  process.exit(1);
});
