import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";

const app = express();
const PORT = process.env.PORT || 10000;

// ================= 强化验证 =================
const validateEnv = () => {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
    console.error("❌ 环境变量验证失败：");
    console.table({
      'LINE_CHANNEL_ACCESS_TOKEN': process.env.LINE_CHANNEL_ACCESS_TOKEN ? '已设置' : '未设置',
      'LINE_CHANNEL_SECRET': process.env.LINE_CHANNEL_SECRET ? '已设置' : '未设置'
    });
    process.exit(1);
  }
};
validateEnv();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);

// ================= 关键中间件顺序 =================
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }), // 必须保留原始请求体
  middleware(config), // LINE签名验证中间件
  async (req, res) => {
    try {
      const body = JSON.parse(req.body.toString());
      console.log("📩 收到事件:", body.events);

      await Promise.all(body.events.map(async (event) => {
        if (event.type === "join" && event.source.type === "group") {
          const groupId = event.source.groupId;
          console.log(`🤖 加入群组: ${groupId}`);
          await sendLanguageMenu(groupId);
        }
      }));

      res.status(200).end();
    } catch (error) {
      console.error("⚠️ 处理错误:", error);
      res.status(500).json({ error: error.message });
    }
  }
);

// ================= 增强型菜单发送 =================
const sendLanguageMenu = async (groupId) => {
  try {
    const message = {
      type: "flex",
      altText: "语言设置",
      contents: {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: "请选择翻译语言", weight: "bold" },
            { type: "separator", margin: "md" },
            createLangButton("英语", "en"),
            createLangButton("泰语", "th"),
            createLangButton("越南语", "vi"),
            createLangButton("印尼语", "id")
          ]
        }
      }
    };

    await client.pushMessage(groupId, message);
    console.log(`✅ 成功发送菜单到群组 ${groupId}`);
  } catch (error) {
    console.error(`❌ 发送失败 (${groupId}):`, error.originalError?.response?.data || error.message);
  }
};

// ================= 工具函数 =================
const createLangButton = (label, lang) => ({
  type: "button",
  action: {
    type: "postback",
    label: label,
    data: `action=set_lang&lang=${lang}`,
    displayText: `已选择${label}`
  },
  style: "primary"
});

// ================= 服务器启动 =================
app.listen(PORT, () => {
  console.log(`🚀 服务运行中：http://localhost:${PORT}`);
  console.log("🔐 当前安全配置：");
  console.table({
    '签名验证': '已启用',
    'HTTPS': Render默认提供,
    '请求体验证': '原始模式'
  });
});
