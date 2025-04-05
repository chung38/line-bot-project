import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";

const app = express();
const PORT = process.env.PORT || 10000;

// ================= 强化环境验证 =================
const validateEnv = () => {
  const requiredEnvVars = [
    'LINE_CHANNEL_ACCESS_TOKEN',
    'LINE_CHANNEL_SECRET'
  ];

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    console.error("❌ 缺少必要环境变量:");
    missingVars.forEach(v => console.error(`   - ${v}`));
    process.exit(1);
  }
};
validateEnv();

// ================= LINE客户端配置 =================
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new Client(lineConfig);

// ================= 关键中间件配置 =================
app.post(
  "/webhook",
  // 中间件顺序非常重要！
  bodyParser.raw({ type: "application/json" }), // 第1步：获取原始请求体
  middleware(lineConfig),                       // 第2步：LINE签名验证
  async (req, res) => {
    try {
      // 第3步：安全解析请求体
      let rawBody;
      if (Buffer.isBuffer(req.body)) {
        rawBody = req.body.toString("utf8");
      } else {
        throw new Error("无效的请求体格式");
      }

      console.log("📥 原始请求体:", rawBody); // 调试日志

      const body = JSON.parse(rawBody);
      console.log("📦 解析后事件数据:", body);

      await Promise.all(body.events.map(async (event) => {
        if (event.type === "join" && event.source.type === "group") {
          const groupId = event.source.groupId;
          console.log(`🤖 新群组加入: ${groupId}`);
          await sendLanguageMenu(groupId);
        }
      }));

      res.status(200).end();
    } catch (error) {
      console.error("⚠️ 请求处理失败:", error);
      res.status(500).json({
        status: "error",
        message: error.message,
        errorType: error.constructor.name
      });
    }
  }
);

// ================= 菜单发送功能（保持不变） =================
const sendLanguageMenu = async (groupId) => {
  // ... 保持原有实现不变 ...
};

// ================= 服务器启动 =================
app.listen(PORT, () => {
  console.log(`🚀 服务运行中：http://localhost:${PORT}`);
  console.log("🔒 安全配置状态：");
  console.table({
    '请求体处理': '原始模式',
    '签名验证': '已启用 ✅',
    'HTTPS支持': process.env.NODE_ENV === 'production' ? '由Render托管' : '本地开发',
    '运行环境': process.env.NODE_ENV || 'development'
  });
});
