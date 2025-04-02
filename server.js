import express from "express";
import { Client } from "@line/bot-sdk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

app.use(express.json());

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 儲存群組的語言選單發送時間（避免短時間內重複發送）
const groupLastSent = new Map();

// 處理 LINE Webhook 事件
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events;
    if (!events || events.length === 0) {
      return res.sendStatus(200);
    }

    await processEventsAsync(events);
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook 處理錯誤:", error);
    res.sendStatus(500);
  }
});

// 處理 LINE Bot 事件
async function processEventsAsync(events) {
  for (const event of events) {
    try {
      if (event.type === "postback") {
        await handlePostback(event);
      } else if (event.type === "message") {
        await handleMessage(event);
      } else if (event.type === "join") {
        await handleGroupJoin(event);
      }
    } catch (error) {
      console.error("事件處理錯誤:", error);
    }
  }
}

// 處理群組加入事件
async function handleGroupJoin(event) {
  const groupId = event.source.groupId;
  console.log(`Bot joined group: ${groupId}`);

  if (!shouldSendLanguageMenu(groupId)) return;

  await delay(10000); // 加入後延遲 10 秒
  await sendLanguageMenu(groupId);
  groupLastSent.set(groupId, Date.now());
}

// 確保語言選單不會頻繁發送（1 小時內不重複發送）
function shouldSendLanguageMenu(groupId) {
  const lastSent = groupLastSent.get(groupId) || 0;
  const now = Date.now();
  return now - lastSent > 3600000; // 1 小時內不重複發送
}

// 發送語言選單（帶重試機制）
async function sendLanguageMenu(groupId, retryCount = 0) {
  if (retryCount > 2) {
    console.error(`發送語言選單失敗 (重試次數超過 3 次)`);
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
        contents: [{ type: "text", text: "🌍 翻譯設定" }],
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "✔ 已選: " },
          { type: "separator", margin: "md" },
          {
            type: "button",
            action: { type: "postback", label: "英語", data: "action=select&lang=en" },
            style: "secondary",
          },
          {
            type: "button",
            action: { type: "postback", label: "泰語", data: "action=select&lang=th" },
            style: "secondary",
          },
          {
            type: "button",
            action: { type: "postback", label: "越語", data: "action=select&lang=vi" },
            style: "secondary",
          },
          {
            type: "button",
            action: { type: "postback", label: "印尼語", data: "action=select&lang=id" },
            style: "secondary",
          },
        ],
      },
    },
  };

  try {
    await client.pushMessage(groupId, message);
    console.log("語言選單發送成功");
  } catch (error) {
    if (error.statusCode === 429) {
      const waitTime = (retryCount + 1) * 5000; // 5s → 10s → 15s
      console.warn(`發送語言選單失敗: 429 Too Many Requests，等待 ${waitTime / 1000} 秒後重試...`);
      await delay(waitTime);
      await sendLanguageMenu(groupId, retryCount + 1);
    } else {
      console.error("發送語言選單失敗:", error);
    }
  }
}

// 處理訊息事件
async function handleMessage(event) {
  try {
    const userMessage = event.message.text;
    const replyToken = event.replyToken;

    await client.replyMessage(replyToken, {
      type: "text",
      text: `你說了: ${userMessage}`,
    });
  } catch (error) {
    console.error("訊息處理錯誤:", error);
  }
}

// 處理 postback 事件
async function handlePostback(event) {
  try {
    const replyToken = event.replyToken;
    const data = event.postback.data;

    await client.replyMessage(replyToken, {
      type: "text",
      text: `已選擇: ${data}`,
    });
  } catch (error) {
    console.error("Postback 處理錯誤:", error);
  }
}

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`🚀 伺服器運行中，端口：${PORT}`);
});
