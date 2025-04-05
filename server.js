import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";

const app = express();
const PORT = process.env.PORT || 10000;

// ================= 环境变量验证 =================
const validateEnvironment = () => {
  const requiredVars = [
    'LINE_CHANNEL_ACCESS_TOKEN',
    'LINE_CHANNEL_SECRET'
  ];

  const missingVars = requiredVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    console.error("❌ 缺少必要环境变量:");
    missingVars.forEach(v => console.error(`   - ${v}`));
    process.exit(1);
  }
};
validateEnvironment();

// ================= LINE 客户端配置 =================
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new Client(lineConfig);

// ================= 中间件配置 =================
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }), // 保持原始请求体
  middleware(lineConfig), // LINE签名验证
  async (req, res) => {
    try {
      const rawBody = req.body.toString();
      const webhookEvents = JSON.parse(rawBody).events;
      console.log("📥 收到事件数量:", webhookEvents.length);

      await Promise.all(webhookEvents.map(async (event) => {
        if (event.type === "join" && event.source.type === "group") {
          const groupId = event.source.groupId;
          console.log(`🤖 新群组加入事件: ${groupId}`);
          await sendLanguageMenu(groupId);
        }
      }));

      res.status(200).end();
    } catch (error) {
      console.error("⚠️ 请求处理异常:", error);
      res.status(500).json({ 
        status: "error",
        message: error.message 
      });
    }
  }
);

// ================= 语言菜单发送功能 =================
const sendLanguageMenu = async (groupId, retryCount = 0) => {
  const languageOptions = [
    { label: "英语", code: "en" },
    { label: "泰语", code: "th" },
    { label: "越南语", code: "vi" },
    { label: "印尼语", code: "id" }
  ];

  try {
    const message = {
      type: "flex",
      altText: "多语言设置菜单",
      contents: {
        type: "bubble",
        header: {
          type: "box",
          layout: "vertical",
          contents: [{
            type: "text",
            text: "🌍 请选择目标语言",
            weight: "bold",
            size: "xl",
            color: "#1DB446"
          }]
        },
        body: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            ...languageOptions.map(createLanguageButton),
            {
              type: "button",
              action: {
                type: "postback",
                label: "❌ 关闭翻译功能",
                data: "action=disable_translation"
              },
              style: "primary",
              color: "#FF5551"
            }
          ]
        }
      }
    };

    console.log(`📤 正在向群组 ${groupId} 发送菜单...`);
    await client.pushMessage(groupId, message);
    console.log("✅ 菜单发送成功");
  } catch (error) {
    console.error(`❌ 发送失败 (${groupId}):`, error.originalError?.response?.data || error.message);
    
    if (error.statusCode === 429 && retryCount < 3) {
      const backoffTime = Math.pow(2, retryCount) * 1000;
      console.log(`⏳ 触发速率限制，等待 ${backoffTime}ms 后重试...`);
      await new Promise(resolve => setTimeout(resolve, backoffTime));
      return sendLanguageMenu(groupId, retryCount + 1);
    }
  }
};

// ================= 工具函数 =================
const createLanguageButton = ({ label, code }) => ({
  type: "button",
  action: {
    type: "postback",
    label: `${label} (${code.toUpperCase()})`,
    data: `action=set_lang&lang=${code}`,
    displayText: `已选择${label}`
  },
  style: "primary",
  color: "#34B7F1"
});

// ================= 服务器启动 =================
app.listen(PORT, () => {
  console.log(`🚀 服务已成功启动，运行端口：${PORT}`);
  console.log("🔒 安全配置状态：");
  console.table({
    '签名验证': '已启用 ✅',
    'HTTPS支持': process.env.NODE_ENV === 'production' ? '由Render托管' : '本地开发',
    '请求体验证': '原始模式',
    '运行环境': process.env.NODE_ENV || 'development'
  });
});
