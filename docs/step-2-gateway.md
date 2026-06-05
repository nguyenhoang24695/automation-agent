# Step 2: Build Minimal Gateway API (Node.js)

## Mục tiêu

Xây dựng Gateway API bằng Node.js — lớp orchestration nhận lệnh từ Telegram, đẩy task vào hàng đợi, và quản lý worker.

---

## Kiến trúc

```text
Telegram User
     ↓ (message)
Telegraf Bot Handler
     ↓ (validate user)
Express API
     ↓ (enqueue task)
Redis Queue (ioredis)
     ↓ (notify)
Worker Manager (Python)
```

---

## 1. Cấu trúc thư mục Gateway

```text
/opt/ai-agent/gateway/
├── Dockerfile
├── package.json
├── src/
│   ├── index.js
│   ├── config.js
│   ├── bot/
│   │   ├── telegram.js
│   │   └── whitelist.js
│   ├── api/
│   │   └── routes.js
│   └── queue/
│       └── redis.js
└── .dockerignore
```

---

## 2. Dependencies

**package.json:**

```json
{
  "name": "ai-agent-gateway",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js"
  },
  "dependencies": {
    "express": "^4.21.0",
    "telegraf": "^4.16.0",
    "ioredis": "^5.4.0",
    "dotenv": "^16.4.0"
  }
}
```

---

## 3. Config

**src/config.js:**

```javascript
import 'dotenv/config';

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  allowedUsers: (process.env.ALLOWED_USERS || '')
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(Boolean),
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379/0',
  gatewayPort: parseInt(process.env.GATEWAY_PORT || '8000'),
};
```

---

## 4. Telegram Whitelist

**src/bot/whitelist.js:**

```javascript
import { config } from '../config.js';

/**
 * Kiểm tra user có trong whitelist không.
 */
export function isAllowed(userId) {
  return config.allowedUsers.includes(userId);
}
```

---

## 5. Redis Queue

**src/queue/redis.js:**

```javascript
import Redis from 'ioredis';
import { config } from '../config.js';

const redis = new Redis(config.redisUrl);
const TASK_QUEUE = 'task_queue';

/**
 * Đẩy task vào Redis queue.
 */
export async function enqueueTask(sessionId, task, chatId) {
  const payload = JSON.stringify({ session_id: sessionId, task, chat_id: chatId });
  await redis.rpush(TASK_QUEUE, payload);
}

/**
 * Lấy task từ Redis queue.
 */
export async function dequeueTask() {
  const result = await redis.lpop(TASK_QUEUE);
  return result ? JSON.parse(result) : null;
}

/**
 * Lấy số lượng task trong queue.
 */
export async function getQueueSize() {
  return await redis.llen(TASK_QUEUE);
}

export { redis };
```

---

## 6. Bot Handlers

**src/bot/telegram.js:**

```javascript
import { Telegraf } from 'telegraf';
import { config } from '../config.js';
import { isAllowed } from './whitelist.js';
import { enqueueTask } from '../queue/redis.js';

const bot = new Telegraf(config.telegramBotToken);

// /start command
bot.start((ctx) => {
  if (!isAllowed(ctx.from.id)) {
    return ctx.reply('⛔ Access denied.');
  }
  return ctx.reply('🤖 AI Coding Agent ready. Send a task to begin.');
});

// Handle all messages
bot.on('text', async (ctx) => {
  if (!isAllowed(ctx.from.id)) {
    return ctx.reply('⛔ Access denied.');
  }

  const taskText = ctx.message.text;
  const sessionId = `session_${ctx.from.id}_${ctx.message.message_id}`;

  await enqueueTask(sessionId, taskText, ctx.chat.id);
  await ctx.reply(`📋 Task received!\nSession: \`${sessionId}\`\nStatus: Queued`, {
    parse_mode: 'Markdown',
  });
});

/**
 * Khởi động bot (long polling).
 */
export async function startBot() {
  console.log('🤖 Telegram bot started (polling)');
  await bot.launch();
}

/**
 * Dừng bot gracefully.
 */
export async function stopBot() {
  await bot.stop();
  console.log('🤖 Telegram bot stopped');
}

export { bot };
```

---

## 7. API Routes

**src/api/routes.js:**

```javascript
import { Router } from 'express';
import { getQueueSize } from '../queue/redis.js';

const router = Router();

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Queue size
router.get('/queue/size', async (req, res) => {
  const size = await getQueueSize();
  res.json({ queue_size: size });
});

export default router;
```

---

## 8. Main Entry Point

**src/index.js:**

```javascript
import express from 'express';
import { config } from './config.js';
import { startBot, stopBot } from './bot/telegram.js';
import apiRoutes from './api/routes.js';

const app = express();

// API routes
app.use('/api', apiRoutes);

// Start Express server
const server = app.listen(config.gatewayPort, () => {
  console.log(`🚀 Gateway API listening on port ${config.gatewayPort}`);
});

// Start Telegram bot (long polling)
startBot();

// Graceful shutdown
process.once('SIGINT', async () => {
  console.log('Shutting down...');
  await stopBot();
  server.close();
  process.exit(0);
});

process.once('SIGTERM', async () => {
  console.log('Shutting down...');
  await stopBot();
  server.close();
  process.exit(0);
});
```

---

## 9. Dockerfile

**Dockerfile:**

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

EXPOSE 8000

CMD ["node", "src/index.js"]
```

**.dockerignore:**

```text
node_modules
npm-debug.log
```

---

## 10. Docker Compose (Gateway + Redis)

**docker-compose.yml:**

```yaml
services:
  gateway:
    build: ./gateway
    ports:
      - "8000:8000"
    env_file:
      - ./secrets/telegram.env
    environment:
      - REDIS_URL=redis://redis:6379/0
      - NODE_ENV=production
    depends_on:
      - redis
    restart: unless-stopped
    volumes:
      - ./logs:/app/logs

  redis:
    image: redis:7-alpine
    volumes:
      - ./redis/data:/data
    restart: unless-stopped
```

---

## 11. Build & Run

```bash
cd /opt/ai-agent
docker compose up --build -d
```

---

## 12. Kiểm tra

```bash
# Health check
curl http://localhost:8000/api/health
# → {"status":"ok","uptime":12.345}

# Queue size
curl http://localhost:8000/api/queue/size
# → {"queue_size":0}

# Gửi tin nhắn Telegram cho bot → bot reply "📋 Task received!"

# Xem logs
docker compose logs -f gateway
```

---

## 13. Troubleshooting

| Vấn đề | Nguyên nhân | Cách xử lý |
|---------|-------------|------------|
| Bot không phản hồi | Token sai | Kiểm tra `TELEGRAM_BOT_TOKEN` |
| Access denied | User ID sai | Kiểm tra `ALLOWED_USERS` |
| Redis connection refused | Redis chưa sẵn sàng | Kiểm tra `depends_on: redis` |
| Port 8000 bị chiếm | Process khác đang dùng | Đổi `GATEWAY_PORT` hoặc stop process |

---

## Kết quả Step 2

- [x] Gateway API chạy trên port 8000 (Node.js + Express)
- [x] Telegram bot nhận và phản hồi tin nhắn (Telegraf)
- [x] Whitelist chặn user không hợp lệ
- [x] Task được đẩy vào Redis queue (ioredis)
- [x] Health check + queue size endpoints
- [x] Graceful shutdown (SIGINT/SIGTERM)

---

## Step tiếp theo

→ [Step 3: Run OpenHands from Docker](step-3-openhands.md)
