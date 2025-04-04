import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 10000;

// ================= 环境变量验证 =================
if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
  console.error("❌ 致命错误：缺少LINE频道凭证！");
  console.error("请检查以下环境变量是否设置：");
  console.error("1. LINE_CHANNEL_ACCESS_TOKEN");
  console.error("2. LINE_CHANNEL_SECRET");
  process.exit(1);
}

// ================= LINE客户端配置 =================
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);

// ================= 增强型中间件配置 =================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= 智能缓存系统 =================
const messageCache = new Map();

// ================= 优化后的Webhook处理器 =================
app.post("/webhook", 
  middleware(config), // 使用官方中间件自动验证签名
  async (req, res) => {
    try {
      console.log("📩 收到事件:", JSON.stringify(req.body, null, 2));
      
      // 异步并行处理所有事件
      await Promise.all(req.body.events.map(async (event) => {
        if (event.type === "join" && event.source.type === "group") {
          const groupId = event.source.groupId;
          console.log(`🤖 机器人加入群组: ${groupId}`);
          
          // 立即发送菜单（移除延迟）
          await sendLanguageMenu(groupId);
        }
      }));
      
      res.status(200).send("OK");
    } catch (error) {
      console.error("⚠️ Webhook处理错误:", error);
      res.status(500).send("Internal Server Error");
    }
  }
);

// ================= 增强型菜单发送器 =================
const sendLanguageMenu = async (groupId, retryCount = 0) => {
  try {
    // 检查缓存防止重复发送
    if (messageCache.has(groupId)) {
      console.log(`📦 使用缓存菜单 (群组: ${groupId})`);
      return;
    }

    const message = {
      type: "flex",
      altText: "多语言翻译设置",
      contents: {
        type: "bubble",
        header: {
          type: "box",
          layout: "vertical",
          contents: [{
            type: "text",
            text: "🌐 多语言翻译设置",
            weight: "bold",
            color: "#1DB446",
            size: "xl"
          }]
        },
        body: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            {
              type: "text",
              text: "请选择目标翻译语言：",
              wrap: true,
              color: "#666666"
            },
            { type: "separator" },
            createLanguageButton("英语", "en"),
            createLanguageButton("泰语", "th"),
            createLanguageButton("越南语", "vi"),
            createLanguageButton("印尼语", "id"),
            {
              type: "button",
              action: {
                type: "postback",
                label: "❌ 关闭翻译",
                data: "action=disable_translation",
                displayText: "已关闭翻译功能"
              },
              style: "primary",
              color: "#FF5551"
            }
          ]
        }
      }
    };

    console.log(`📤 正在发送菜单到群组: ${groupId}`);
    await client.pushMessage(groupId, message);
    messageCache.set(groupId, Date.now()); // 缓存有效期60秒
    console.log("✅ 菜单发送成功");
    
  } catch (error) {
    console.error(`❌ 发送失败 (群组: ${groupId}):`, error.originalError.response?.data || error.message);
    
    // 智能重试机制
    if (error.statusCode === 429 && retryCount < 3) {
      const backoffTime = Math.pow(2, retryCount) * 1000;
      console.log(`⏳ 429错误，等待 ${backoffTime}ms 后重试...`);
      await new Promise(resolve => setTimeout(resolve, backoffTime));
      return sendLanguageMenu(groupId, retryCount + 1);
    }
    
    // 记录失败状态
    messageCache.delete(groupId);
  }
};

// ================= 工具函数 =================
function createLanguageButton(label, langCode) {
  return {
    type: "button",
    action: {
      type: "postback",
      label: `${label} (${langCode.toUpperCase()})`,
      data: `action=set_lang&lang=${langCode}`,
      displayText: `已选择${label}翻译`
    },
    style: "primary",
    color: "#34B7F1"
  };
}

// ================= 服务器启动 =================
app.listen(PORT, () => {
  console.log(`🚀 服务器已启动，监听端口：${PORT}`);
  console.log("🔍 请确保已正确配置以下环境变量：");
  console.log(`   LINE_CHANNEL_ACCESS_TOKEN: ${process.env.LINE_CHANNEL_ACCESS_TOKEN ? '已设置' : '未设置'}`);
  console.log(`   LINE_CHANNEL_SECRET: ${process.env.LINE_CHANNEL_SECRET ? '已设置' : '未设置'}`);
});
