# Step 4: Stream Logs to Telegram (Node.js Worker)

## Mục tiêu

Đưa kết quả và logs từ OpenHands worker trở lại Telegram để user theo dõi real-time.

---

## Kiến trúc

```text
OpenHands Container
    ↓ (execute task)
Worker captures logs
    ↓ (format message)
Worker calls Telegram Bot API
    ↓ (chunked messages)
User receives update
```

---

## 1. Log Collector

Tạo file **workers/src/log-collector.js:**

```javascript
/**
 * Collects and formats logs from a container execution.
 */
export class LogCollector {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.logs = [];
    this.startTime = Date.now();
  }

  add(line) {
    const timestamp = new Date().toISOString().slice(11, 19); // HH:MM:SS
    this.logs.push(`[${timestamp}] ${line}`);
  }

  /**
   * Generate a Telegram-friendly summary message.
   * @param {string} status - 'done' or 'error'
   * @returns {string}
   */
  getSummary(status) {
    const duration = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const icon = status === 'done' ? '✅' : '❌';

    const header = [
      `${icon} *Task ${status.toUpperCase()}*`,
      `Session: \`${this.sessionId}\``,
      `Duration: ${duration}s`,
      '─'.repeat(30),
    ].join('\n');

    // Last 50 lines, max 3000 chars (Telegram limit = 4096)
    const recentLogs = this.logs.slice(-50).join('\n');
    let logText = recentLogs.length > 3000
      ? '...(truncated)...\n' + recentLogs.slice(-3000)
      : recentLogs;

    return `${header}\n\`\`\`\n${logText}\n\`\`\``;
  }
}
```

---

## 2. Telegram Notifier (already in Step 3)

The `notifier.js` from Step 3 handles sending messages to Telegram via Bot API.
It supports automatic message chunking for the 4096-char limit.

**workers/src/notifier.js** (from Step 3):

```javascript
import { config } from './config.js';

const API_BASE = `https://api.telegram.org/bot${config.telegramBotToken}`;

export async function sendTelegramMessage(chatId, text) { /* ... */ }
```

Additionally, add a convenience `sendStatus` function:

```javascript
/**
 * Send a short status update to Telegram.
 * @param {number|string} chatId
 * @param {string} sessionId
 * @param {string} status - 'queued', 'running', 'done', 'error'
 */
export async function sendStatus(chatId, sessionId, status) {
  const icons = { queued: '📋', running: '🔄', done: '✅', error: '❌' };
  const icon = icons[status] || '❓';
  const msg = `${icon} Session \`${sessionId}\`: ${status}`;

  try {
    await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }),
    });
  } catch (err) {
    console.error('❌ Failed to send status:', err.message);
  }
}
```

---

## 3. Updated Worker with Log Streaming

Update **workers/src/worker.js** — integrate LogCollector and real-time log streaming:

```javascript
import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { LogCollector } from './log-collector.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

/**
 * Execute a task with full log collection.
 */
export async function executeTask(taskData) {
  const { session_id, task, chat_id } = taskData;
  const workspacePath = path.join(config.workspaceBase, session_id);
  const containerName = `openhands-${session_id}`;

  const collector = new LogCollector(session_id);
  collector.add(`Task: ${task}`);

  console.log(`\n🚀 Starting task: ${session_id}`);
  fs.mkdirSync(workspacePath, { recursive: true });

  try {
    // Pull image if needed
    try {
      await docker.getImage(config.openhandsImage).inspect();
    } catch {
      collector.add('Pulling OpenHands image...');
      await new Promise((resolve, reject) => {
        docker.pull(config.openhandsImage, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
        });
      });
      collector.add('Image pulled');
    }

    // Create and start container
    const container = await docker.createContainer({
      Image: config.openhandsImage,
      name: containerName,
      Env: [`SANDBOX_RUNTIME_CONTAINER_IMAGE=${config.openhandsImage}`],
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
    collector.add(`Container started: ${containerName}`);

    // Stream logs in real-time
    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
    });

    logStream.on('data', (chunk) => {
      const lines = chunk.toString('utf-8').split('\n').filter(Boolean);
      lines.forEach((line) => collector.add(line));
    });

    // Wait for completion
    const waitResult = await container.wait(config.taskTimeout);
    const statusCode = waitResult.StatusCode;

    // Final log capture (in case stream missed anything)
    try {
      const finalLogs = await container.logs({ stdout: true, stderr: true });
      const finalText = finalLogs.toString('utf-8');
      if (finalText && !collector.logs.length) {
        finalText.split('\n').filter(Boolean).forEach(l => collector.add(l));
      }
    } catch { /* container auto-removed */ }

    const status = statusCode === 0 ? 'done' : 'error';

    // Save logs to file
    const logDir = path.join(config.workspaceBase, '..', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, `${session_id}.log`),
      collector.logs.join('\n')
    );

    console.log(`📋 Task ${session_id}: ${status} (exit ${statusCode})`);
    return { status, logs: collector.getSummary(status), exitCode: statusCode };

  } catch (err) {
    collector.add(`Error: ${err.message}`);
    console.error(`❌ Task ${session_id} failed:`, err.message);

    try {
      await docker.getContainer(containerName).kill();
    } catch { /* already gone */ }

    return { status: 'error', logs: collector.getSummary('error'), exitCode: -1 };
  }
}
```

---

## 4. Updated Main Worker Loop

Update **workers/src/index.js** — use sendStatus and log streaming:

```javascript
import Redis from 'ioredis';
import { config } from './config.js';
import { executeTask } from './worker.js';
import { sendTelegramMessage, sendStatus } from './notifier.js';

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) { return Math.min(times * 200, 5000); },
});

redis.on('connect', () => console.log('✅ Worker Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err.message));

const TASK_QUEUE = 'task_queue';
const POLL_TIMEOUT = 5;

async function runWorker() {
  console.log('🔄 Worker started, waiting for tasks...');

  while (true) {
    try {
      const result = await redis.blpop(TASK_QUEUE, POLL_TIMEOUT);
      if (!result) continue;

      const [, raw] = result;
      const taskData = JSON.parse(raw);

      console.log(`\n📨 Dequeued: ${taskData.session_id}`);

      // Notify: running
      if (taskData.chat_id) {
        await sendStatus(taskData.chat_id, taskData.session_id, 'running');
      }

      // Execute
      const execResult = await executeTask(taskData);

      // Notify: finished with logs
      if (taskData.chat_id) {
        await sendTelegramMessage(taskData.chat_id, execResult.logs);
      }

    } catch (err) {
      console.error('❌ Worker loop error:', err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

process.once('SIGINT', () => { redis.disconnect(); process.exit(0); });
process.once('SIGTERM', () => { redis.disconnect(); process.exit(0); });

runWorker();
```

---

## 5. Gateway — chat_id (already implemented)

The Gateway already passes `chat_id` in the Redis payload (from Step 2).
No changes needed — the worker reads `chat_id` from the task data.

> **Note**: Both Gateway and Worker use Node.js and communicate via Redis queue using JSON.

---

## 6. Log File Storage

Worker automatically saves logs to `/app/logs/{session_id}.log` (see worker.js above).
Logs are accessible via:

```bash
# On server
ls -la /opt/ai-agent/logs/

# Or via Docker
docker compose exec worker ls /app/logs/
```

---

## 7. Build & Run

```bash
cd /opt/ai-agent
docker compose up --build -d
```

---

## 8. Kiểm tra

```text
1. Gửi tin nhắn Telegram: "Create hello world HTML page"
2. Bot reply: 📋 Task queued!
3. Vài giây sau: 🔄 Session session_xxx: running
4. Khi hoàn thành: ✅ Task DONE + logs (50 dòng cuối)
5. Log file saved: /opt/ai-agent/logs/session_xxx.log
```

---

## Kết quả Step 4

- [x] Real-time log streaming from container
- [x] Summary message sent to Telegram
- [x] Auto-chunk messages over 4096 chars
- [x] Log files saved at `/opt/ai-agent/logs/`
- [x] chat_id passed from Gateway → Worker via Redis
- [x] All in Node.js (dockerode + ioredis + fetch)

---

## Step tiếp theo

→ [Step 5: Add Git Support](step-5-git-support.md)
