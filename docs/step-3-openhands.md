# Step 3: Run OpenHands from Docker (Node.js Worker)

## Mục tiêu

Tích hợp OpenHands — AI coding agent tự động thực thi task trong Docker sandbox. Worker viết bằng Node.js, dùng `dockerode` để quản lý container.

---

## Kiến trúc

```text
Redis Queue (task_queue)
    ↓ BLPOP
Worker (Node.js + dockerode)
    ↓ createContainer + start
OpenHands Container
    ↓ executes task
/workspace (isolated)
    ↓ complete
Worker sends logs → Telegram Bot API
```

---

## 1. Cấu trúc thư mục Worker

```text
workers/
├── Dockerfile
├── .dockerignore
├── package.json
└── src/
    ├── index.js          # Main loop: poll Redis, dispatch tasks
    ├── config.js          # Environment config
    ├── worker.js          # Task executor: spawn container, wait, capture logs
    └── notifier.js        # Send results back to Telegram
```

---

## 2. Dependencies

**package.json:**

```json
{
  "name": "ai-agent-worker",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node src/index.js"
  },
  "dependencies": {
    "dockerode": "^4.0.4",
    "ioredis": "^5.4.2",
    "dotenv": "^16.4.7"
  }
}
```

---

## 3. Config

**src/config.js:**

```javascript
import 'dotenv/config';

export const config = {
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379/0',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  openhandsImage: process.env.OPENHANDS_IMAGE || 'docker.all-hands.dev/all-hands-ai/openhands:latest',
  workspaceBase: process.env.WORKSPACE_BASE || '/workspaces',
  taskTimeout: parseInt(process.env.TASK_TIMEOUT || '600', 10), // seconds
  memLimit: parseInt(process.env.MEM_LIMIT || '2147483648', 10), // 2GB in bytes
  cpuLimit: parseInt(process.env.CPU_LIMIT || '1', 10), // number of CPUs
};

if (!config.telegramBotToken) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

console.log(`✅ Worker config loaded — timeout: ${config.taskTimeout}s, mem: ${Math.round(config.memLimit / 1073741824)}GB`);
```

---

## 4. Telegram Notifier

**src/notifier.js:**

Sends results back to Telegram using the Bot API directly (no Telegraf needed):

```javascript
import { config } from './config.js';

const API_BASE = `https://api.telegram.org/bot${config.telegramBotToken}`;

/**
 * Send a message to a Telegram chat.
 * Splits long messages to stay within Telegram's 4096 char limit.
 *
 * @param {number|string} chatId
 * @param {string} text
 */
export async function sendTelegramMessage(chatId, text) {
  const MAX_LEN = 4096;
  const chunks = [];

  for (let i = 0; i < text.length; i += MAX_LEN) {
    chunks.push(text.slice(i, i + MAX_LEN));
  }

  for (const chunk of chunks) {
    try {
      await fetch(`${API_BASE}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
        }),
      });
    } catch (err) {
      console.error(`❌ Failed to send Telegram message to ${chatId}:`, err.message);
    }
  }
}
```

---

## 5. Worker — Task Executor

**src/worker.js:**

```javascript
import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

/**
 * Execute a task by spawning an OpenHands container.
 *
 * @param {{session_id: string, task: string, chat_id: number|string, source?: string}} taskData
 * @returns {{status: string, logs: string}}
 */
export async function executeTask(taskData) {
  const { session_id, task, chat_id, source } = taskData;
  const workspacePath = path.join(config.workspaceBase, session_id);
  const containerName = `openhands-${session_id}`;

  console.log(`\n🚀 Starting task: ${session_id}`);
  console.log(`   Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`);

  // Create workspace directory
  fs.mkdirSync(workspacePath, { recursive: true });

  try {
    // Pull image if not available
    try {
      await docker.getImage(config.openhandsImage).inspect();
    } catch {
      console.log(`📦 Pulling OpenHands image (first time)...`);
      await new Promise((resolve, reject) => {
        docker.pull(config.openhandsImage, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
        });
      });
      console.log('✅ Image pulled');
    }

    // Spawn OpenHands container
    const container = await docker.createContainer({
      Image: config.openhandsImage,
      name: containerName,
      Env: [
        `SANDBOX_RUNTIME_CONTAINER_IMAGE=${config.openhandsImage}`,
      ],
      HostConfig: {
        Binds: [`${workspacePath}:/workspace:rw`],
        NetworkMode: 'bridge',
        Memory: config.memLimit,
        NanoCpus: config.cpuLimit * 1e9,
        AutoRemove: true,
      },
      Cmd: ['python', '-m', 'openhands.core.main', '-t', task],
    });

    await container.start();
    const info = await container.inspect();
    console.log(`✅ Container started: ${info.Id.slice(0, 12)}`);

    // Wait for container to finish (with timeout)
    const waitResult = await container.wait(config.taskTimeout);
    const statusCode = waitResult.StatusCode;

    // Capture logs
    let logs = '';
    try {
      const logBuffer = await container.logs({ stdout: true, stderr: true });
      logs = logBuffer.toString('utf-8');
    } catch {
      logs = '(unable to capture logs)';
    }

    const status = statusCode === 0 ? 'done' : 'error';
    console.log(`📋 Task ${session_id} finished — status: ${status}, exit: ${statusCode}`);

    return { status, logs, exitCode: statusCode };

  } catch (err) {
    console.error(`❌ Task ${session_id} failed:`, err.message);

    // Try to clean up container on error
    try {
      const container = docker.getContainer(containerName);
      await container.kill();
      await container.remove({ force: true });
    } catch { /* container may already be gone */ }

    return { status: 'error', logs: err.message, exitCode: -1 };
  }
}
```

---

## 6. Main Entry Point

**src/index.js:**

```javascript
import Redis from 'ioredis';
import { config } from './config.js';
import { executeTask } from './worker.js';
import { sendTelegramMessage } from './notifier.js';

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    return Math.min(times * 200, 5000);
  },
});

redis.on('connect', () => console.log('✅ Worker Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err.message));

const TASK_QUEUE = 'task_queue';
const POLL_TIMEOUT = 5; // seconds for BLPOP

/**
 * Format task result into a Telegram-friendly message.
 */
function formatResult(taskData, result) {
  const { session_id } = taskData;
  const statusIcon = result.status === 'done' ? '✅' : '❌';
  const logPreview = result.logs.slice(0, 2000);

  return [
    `${statusIcon} *Task ${result.status === 'done' ? 'completed' : 'failed'}*`,
    '',
    `Session: \`${session_id}\``,
    `Exit code: ${result.exitCode}`,
    '',
    '*Logs:*',
    '```',
    logPreview,
    '```',
    result.logs.length > 2000 ? '\n_(logs truncated — full logs in workspace)_' : '',
  ].join('\n');
}

/**
 * Main worker loop: BLPOP from Redis, execute, notify.
 */
async function runWorker() {
  console.log('🔄 Worker started, waiting for tasks...');

  while (true) {
    try {
      // BLPOP blocks until a task is available (or timeout)
      const result = await redis.blpop(TASK_QUEUE, POLL_TIMEOUT);
      if (!result) continue; // timeout, try again

      const [, raw] = result;
      const taskData = JSON.parse(raw);

      console.log(`\n📨 Dequeued: ${taskData.session_id}`);

      // Notify user: task started
      if (taskData.chat_id) {
        await sendTelegramMessage(
          taskData.chat_id,
          `⏳ *Processing task...*\nSession: \`${taskData.session_id}\``
        );
      }

      // Execute the task
      const execResult = await executeTask(taskData);

      // Notify user: task finished
      if (taskData.chat_id) {
        const message = formatResult(taskData, execResult);
        await sendTelegramMessage(taskData.chat_id, message);
      }

    } catch (err) {
      console.error('❌ Worker loop error:', err.message);
      // Brief pause before retry on error
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('\n⏹ Worker shutting down...');
  redis.disconnect();
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('\n⏹ Worker shutting down...');
  redis.disconnect();
  process.exit(0);
});

runWorker();
```

---

## 7. Worker Dockerfile

**Dockerfile:**

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

CMD ["node", "src/index.js"]
```

**.dockerignore:**

```text
node_modules
npm-debug.log
```

> **Note:** The worker image is lightweight — no Docker CLI needed. It uses the Docker API via the mounted socket.

---

## 8. Cập nhật Docker Compose

Thêm worker vào **docker-compose.yml:**

```yaml
services:
  gateway:
    build: ./gateway
    ports:
      - "${GATEWAY_PORT:-8000}:8000"
    env_file:
      - .env
    environment:
      - REDIS_URL=redis://redis:6379/0
      - NODE_ENV=production
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
    volumes:
      - ./logs:/app/logs
      - ./secrets:/app/secrets

  redis:
    image: redis:7-alpine
    volumes:
      - ./redis/data:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  worker:
    build: ./workers
    env_file:
      - .env
    environment:
      - REDIS_URL=redis://redis:6379/0
      - WORKSPACE_BASE=/workspaces
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock   # Docker API access
      - ./workspaces:/workspaces                     # Task workspaces
      - ./logs:/app/logs
```

> ⚠️ **Lưu ý bảo mật**: Worker cần Docker socket (`/var/run/docker.sock`) để spawn container con. Đây là trade-off cần thiết cho MVP. Trong production, nên dùng Docker-in-Docker (DinD) hoặc remote Docker host.

---

## 9. Security: Workspace Isolation

Mỗi task chạy trong workspace riêng:

```text
/opt/ai-agent/workspaces/
├── session_123456789_100/
├── session_123456789_101/
└── zalo_userABC_1717500000000/
```

Rules:
- **KHÔNG** mount `/`, `/home`, `/root`
- **KHÔNG** mount Docker socket vào OpenHands container
- Mỗi container bị giới hạn **2GB RAM**, **1 CPU**
- Timeout **10 phút** mỗi task (configurable via `TASK_TIMEOUT`)
- Container auto-remove sau khi hoàn thành

---

## 10. Environment Variables (Worker-specific)

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKSPACE_BASE` | `/workspaces` | Base path for task workspaces |
| `TASK_TIMEOUT` | `600` | Max seconds per task |
| `MEM_LIMIT` | `2147483648` | RAM limit in bytes (2GB) |
| `CPU_LIMIT` | `1` | Number of CPUs |
| `OPENHANDS_IMAGE` | `docker.all-hands.dev/.../openhands:latest` | OpenHands Docker image |

---

## 11. Build & Run

```bash
cd /opt/ai-agent
docker compose up --build -d
```

---

## 12. Kiểm tra

```bash
# Xem logs worker
docker compose logs -f worker

# Xem logs gateway + worker cùng lúc
docker compose logs -f gateway worker

# Gửi task qua Telegram: "Create a hello world HTML page"
# → Worker dequeue từ Redis
# → Spawn OpenHands container
# → Container thực thi task
# → Worker gửi kết quả về Telegram

# Kiểm tra workspace
ls -la ./workspaces/

# Kiểm tra tất cả containers
docker compose ps
```

---

## 13. Troubleshooting

| Vấn đề | Nguyên nhân | Cách xử lý |
|---------|-------------|------------|
| Worker không spawn container | Docker socket permission | Kiểm tra volume mount `/var/run/docker.sock` |
| Container timeout | Task quá phức tạp | Tăng `TASK_TIMEOUT` hoặc chia nhỏ task |
| Out of memory | Container vượt 2GB | Tăng `MEM_LIMIT` trong .env |
| Image pull failed | Network issue | `docker pull docker.all-hands.dev/all-hands-ai/openhands:latest` thủ công |
| Workspace không tạo | Permission denied | `chown -R ubuntu:ubuntu ./workspaces` |
| Logs không gửi về Telegram | Bot token sai | Kiểm tra `TELEGRAM_BOT_TOKEN` trong .env |

---

## Kết quả Step 3

- [x] Worker (Node.js) lắng nghe task từ Redis queue (BLPOP)
- [x] OpenHands container spawn tự động qua Docker API (dockerode)
- [x] Workspace isolation theo session_id
- [x] Resource limits (RAM, CPU, timeout)
- [x] Kết quả gửi về Telegram qua Bot API
- [x] Graceful shutdown (SIGINT/SIGTERM)

---

## Step tiếp theo

→ [Step 4: Stream Logs to Telegram](step-4-stream-logs.md)
