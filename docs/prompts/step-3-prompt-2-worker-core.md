# Implementation Prompt — Step 3.2: Core Worker (Redis Poll + Container Spawn)

## Context

You are implementing the **core worker loop** for an AI Coding Agent system. The project setup (Step 3.1) is already complete — you have `config.js`, `Dockerfile`, and `docker-compose.yml` with the worker service.

This prompt covers implementing:
1. **`worker.js`** — The task executor that spawns OpenHands Docker containers
2. **`index.js`** — The main entry point with the Redis BLPOP polling loop

---

## Prerequisites (from Step 3.1)

The following files already exist:

```text
workers/
├── Dockerfile
├── package.json            # has dockerode, ioredis, dotenv
└── src/
    ├── config.js           # ✅ implemented — exports `config` object
    ├── worker.js           # ← implement in this prompt
    ├── index.js            # ← implement in this prompt
    └── notifier.js         # ← will be implemented in Step 3.3
```

The `config` object exports:
- `redisUrl` — Redis connection string
- `telegramBotToken` — Bot token for Telegram API
- `openhandsImage` — Docker image name for OpenHands
- `workspaceBase` — Base path for workspaces (default: `/workspaces`)
- `taskTimeout` — Max seconds per task (default: 600)
- `memLimit` — RAM limit in bytes (default: 2GB)
- `cpuLimit` — Number of CPUs (default: 1)

---

## Redis Queue Protocol

The Gateway pushes tasks to the Redis list `task_queue` using `RPUSH`. Each task is a JSON string:

```json
{
  "session_id": "session_6302853216_42",
  "task": "Create a hello world HTML page",
  "chat_id": 6302853216,
  "source": "telegram"
}
```

- `session_id` — Unique identifier for this task (used for workspace folder name)
- `task` — The user's task description (plain text)
- `chat_id` — Telegram chat ID (used to send results back)
- `source` — Which adapter sent this (optional: `telegram` or `zalo`)

The Worker should use `BLPOP` (blocking pop) to consume tasks — this blocks until a task is available instead of busy-looping.

---

## Step-by-Step Instructions

### Step 3.2.1: Implement worker.js — Task Executor

Create `src/worker.js`:

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
 * @returns {{status: string, logs: string, exitCode: number}}
 */
export async function executeTask(taskData) {
  const { session_id, task, chat_id, source } = taskData;
  const workspacePath = path.join(config.workspaceBase, session_id);
  const containerName = `openhands-${session_id}`;

  console.log(`\n🚀 Starting task: ${session_id}`);
  console.log(`   Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`);

  // 1. Create workspace directory
  fs.mkdirSync(workspacePath, { recursive: true });

  try {
    // 2. Pull OpenHands image if not already available
    try {
      await docker.getImage(config.openhandsImage).inspect();
    } catch {
      console.log('📦 Pulling OpenHands image (first time)...');
      await new Promise((resolve, reject) => {
        docker.pull(config.openhandsImage, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
        });
      });
      console.log('✅ Image pulled');
    }

    // 3. Create and start OpenHands container
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

    // 4. Wait for container to finish (with timeout)
    const waitResult = await container.wait(config.taskTimeout);
    const statusCode = waitResult.StatusCode;

    // 5. Capture logs
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

    // Clean up container on error
    try {
      const container = docker.getContainer(containerName);
      await container.kill();
      await container.remove({ force: true });
    } catch { /* container may already be gone */ }

    return { status: 'error', logs: err.message, exitCode: -1 };
  }
}
```

**Key implementation details:**

| Aspect | Detail |
|--------|--------|
| Docker socket | Uses `/var/run/docker.sock` (mounted volume from docker-compose) |
| Image pull | Only pulls on first run; subsequent runs use cached image |
| `docker.pull()` | Uses callback pattern with `followProgress` to wait for completion |
| Workspace | Each task gets its own folder: `{workspaceBase}/{session_id}` |
| Container name | `openhands-{session_id}` — predictable for debugging |
| Resource limits | `Memory` (bytes) and `NanoCpus` (nano-CPUs) via `HostConfig` |
| Auto-remove | `AutoRemove: true` — container is removed after exit |
| Timeout | `container.wait(config.taskTimeout)` — throws if exceeded |
| Error handling | Kills and removes container on any error |

---

### Step 3.2.2: Implement index.js — Main Worker Loop

Create `src/index.js`:

```javascript
import Redis from 'ioredis';
import { config } from './config.js';
import { executeTask } from './worker.js';
import { sendTelegramMessage } from './notifier.js';

// Connect to the same Redis as Gateway
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
      // BLPOP blocks until a task is available (or timeout of POLL_TIMEOUT seconds)
      const result = await redis.blpop(TASK_QUEUE, POLL_TIMEOUT);
      if (!result) continue; // timeout, try again

      const [, raw] = result; // result is [queueName, value]
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

**Key implementation details:**

| Aspect | Detail |
|--------|--------|
| BLPOP | Blocking pop — waits up to `POLL_TIMEOUT` seconds, then retries |
| Single task at a time | Sequential processing — no parallelism in MVP |
| `formatResult()` | Creates Markdown-formatted message with log preview (max 2000 chars) |
| Error resilience | Catches all errors in the loop, waits 2s, retries |
| Graceful shutdown | Handles SIGINT/SIGTERM, disconnects Redis |
| `sendTelegramMessage()` | Imported from notifier.js (will be implemented in Step 3.3) |

---

### Step 3.2.3: Create Placeholder notifier.js

Since `index.js` imports from `notifier.js`, create a minimal placeholder so the app can start:

```javascript
// src/notifier.js — placeholder (full implementation in Step 3.3)
import { config } from './config.js';

export async function sendTelegramMessage(chatId, text) {
  console.log(`📤 [notifier stub] Would send to ${chatId}: ${text.slice(0, 50)}...`);
}
```

---

## Verification Checklist

```bash
# 1. Build and start all services
docker compose up --build -d

# 2. Check worker is running and waiting
docker compose logs worker
# Expected: "🔄 Worker started, waiting for tasks..."

# 3. Check Redis connection
docker compose logs worker | grep "Redis connected"
# Expected: "✅ Worker Redis connected"

# 4. Send a test task from Telegram
#    → Gateway enqueues to Redis
#    → Worker should pick it up
docker compose logs -f worker
# Expected: "📨 Dequeued: session_xxx"

# 5. Check if OpenHands container was spawned
docker ps | grep openhands
# Expected: a container named "openhands-session_xxx"

# 6. After task completes, check Telegram for results
# Expected: "✅ Task completed" or "❌ Task failed" with logs
```

---

## Expected Output Structure

```text
workers/src/
├── config.js       # ✅ from Step 3.1
├── worker.js       # ✅ implemented — executeTask() function
├── index.js        # ✅ implemented — runWorker() loop
└── notifier.js     # ⚠️ placeholder — implemented in Step 3.3
```

---

## Important Notes

- **BLPOP vs LPOP**: Use `BLPOP` (blocking) — it's more efficient than polling with `LPOP` + sleep
- **Single task processing**: MVP processes one task at a time. Parallel workers are a Phase 2 feature
- **OpenHands command**: `python -m openhands.core.main -t "<task>"` — this is how OpenHands accepts tasks
- **AutoRemove: true** means the container is automatically deleted after it exits — no cleanup needed
- **Image pull is expensive** (~2GB) — only happens on first task. Subsequent tasks start instantly
- **Workspace isolation**: Each `session_id` gets its own directory — tasks cannot interfere with each other
- **Error recovery**: If any error occurs, the worker catches it, cleans up, and continues the loop
