import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs/promises";
import https from "node:https";

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
let groupLanguages = new Map();

const loadGroupLanguages = async () => {
  try {
    const data = await fs.readFile(GROUP_LANG_FILE, 'utf8');
    const obj = JSON.parse(data);
    groupLanguages = new Map(Object.entries(obj).map(([g, langs]) => [g, new Set(langs)]));
    console.log('✅ 成功載入群組語言設定');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('載入群組語言設定失敗:', e);
  }
};

const saveGroupLanguages = async () => {
  const obj = {};
  for (const [g, set] of groupLanguages.entries()) obj[g] = Array.from(set);
  try {
    await fs.writeFile(GROUP_LANG_FILE, JSON.stringify(obj, null, 2));
    console.log('✅ 群組語言設定已儲存');
  } catch (e) {
    console.error('儲存群組語言設定失敗:', e);
  }
};

// ================= 翻譯 API 功能 =================
const translateWithDeepSeek = async (text, targetLang, retry = 0) => {
  const systemPrompt = `你是一名翻譯員，請將以下句子翻譯成${targetLang === 'zh-TW' ? '繁體中文' :
    targetLang === 'en' ? '英文' : targetLang === 'th' ? '泰文' : targetLang === 'vi' ? '越南文' : targetLang === 'id' ? '印尼文' : targetLang}，僅輸出翻譯結果，不要任何其他文字或解釋。`;
  try {
    const res = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ]
      },
      { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    return res.data.choices[0].message.content.trim();
  } catch (err) {
    if (err.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return translateWithDeepSeek(text, targetLang, retry + 1);
    }
    console.error('翻譯錯誤:', err.response?.data || err.message);
    return '（翻譯暫時不可用）';
  }
};

// ================= 判斷中文 =================
const containsChinese = s => /[\u4e00-\u9fff]/.test(s);

// ================= 中間件設定 =================
app.post(
  '/webhook',
  bodyParser.raw({ type: 'application/json' }),
  middleware(lineConfig),
  express.json(),
  async (req, res) => {
    try {
      console.log('🔍 解析後的事件結構:', JSON.stringify(req.body, null, 2));
      await Promise.all(req.body.events.map(async event => {
        const groupId = event.source?.groupId;
        // join 事件
        if (event.type === 'join' && event.source.type === 'group') {
          console.log(`🤖 新群組加入: ${groupId}`);
          sendLanguageMenu(groupId);
        }
        // postback 事件
        else if (event.type === 'postback') {
          const params = new URLSearchParams(event.postback.data);
          const action = params.get('action');
          const code = params.get('code');
          if (action === 'set_lang' && groupId) {
            const set = groupLanguages.get(groupId) || new Set();
            if (code === 'cancel') {
              groupLanguages.delete(groupId);
              await saveGroupLanguages();
              await client.replyMessage(event.replyToken, { type: 'text', text: '已取消所有語言選擇。' });
            } else {
              if (set.has(code)) set.delete(code); else set.add(code);
              groupLanguages.set(groupId, set);
              await saveGroupLanguages();
              const names = { en: '英文', th: '泰文', vi: '越南文', id: '印尼文' };
              const cur = Array.from(set).map(c => names[c]).join('、') || '無';
              await client.replyMessage(event.replyToken, { type: 'text', text: cur });
            }
          }
        }
        // message 事件
        else if (event.type === 'message' && event.message.type === 'text' && groupId) {
          const text = event.message.text;
          const set = groupLanguages.get(groupId);
          if (!set || set.size === 0) {
            await client.replyMessage(event.replyToken, { type: 'text', text: '請先設定翻譯語言。' });
            return;
          }
          if (containsChinese(text)) {
            const outs = [];
            for (const c of set) outs.push(await translateWithDeepSeek(text, c));
            await client.replyMessage(event.replyToken, { type: 'text', text: outs.join('\n') });
          } else {
            const t = await translateWithDeepSeek(text, 'zh-TW');
            await client.replyMessage(event.replyToken, { type: 'text', text: t });
          }
        }
      }));
      res.sendStatus(200);
    } catch (e) {
      console.error('⚠️ 處理流程異常:', e);
      res.sendStatus(500);
    }
  }
);

// ================= 選單發送功能 =================
const rateLimit = {};
const INTERVAL = 60000;
const canSend = gid => {
  const now = Date.now();
  if (!rateLimit[gid] || now - rateLimit[gid] > INTERVAL) {
    rateLimit[gid] = now; return true;
  }
  return false;
};
const sendLanguageMenu = async (gid, retry=0) => {
  if (!canSend(gid)) return;
  const msg = { type:'flex', altText:'語言設定選單', contents:{ type:'bubble', body:{ type:'box', layout:'vertical', contents:[
    {type:'text',text:'🌍 請選擇翻譯語言',weight:'bold'},
    {type:'separator',margin:'md'},
    createButton('英文','en'), createButton('泰文','th'), createButton('越南文','vi'), createButton('印尼文','id'),
    {type:'button',action:{type:'postback',label:'取消選擇',data:'action=set_lang&code=cancel'},style:'secondary',color:'#FF3B30'}
  ]}}};
  try { await client.pushMessage(gid,msg); console.log(`📤 選單已發送至 ${gid}`); }
  catch(err){ if(err.statusCode===429 && retry<3){ await new Promise(r=>setTimeout(r,(retry+1)*5000)); return sendLanguageMenu(gid,retry+1);} console.error(err.message);}  
};
const createButton = (l,c)=>({ type:'button', action:{type:'postback',label:`${l} (${c.toUpperCase()})`,data:`action=set_lang&code=${c}`}, style:'primary', color:'#34B7F1'});

// ================= 定時自我 PING 防休眠 =================
const PING_URL = process.env.PING_URL;
if (PING_URL) {
  setInterval(() => {
    https.get(PING_URL, res => console.log(`📡 PING ${res.statusCode}`))
      .on('error', e => console.error('⚠️ PING 失敗', e.message));
  }, 10*60*1000);
} else console.warn('⚠️ 未設定 PING_URL');

// ================= 伺服器啟動 =================
app.listen(PORT, async () => {
  await loadGroupLanguages();
  console.log(`🚀 服務運行於 ${PORT}`);
});
