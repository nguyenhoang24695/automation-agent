# Implementation Prompt — Step 3.4: Log Collector + Real-Time Streaming + File Storage

## Context

You are enhancing the **Worker service** with structured log collection and real-time streaming. The core worker (Steps 3.1–3.3) is already functional — it polls Redis, spawns containers, captures logs after completion, and sends results to Telegram.

This prompt covers upgrading the worker with:
1. **`log-collector.js`** — Structured log collection class with timestamps
2. **Real-time log streaming** — Stream container logs as they happen (not just after completion)
3. **Log file storage** — Save full logs to disk for debugging
4. **Enhanced Telegram summary** — Formatted summary with duration and log preview

---

## Prerequisites (from Steps 3.1–3.3)

Already implemented:

```text
workers/src/
├── config.js       # ✅ config with workspaceBase
├── worker.js       # ✅ executeTask() — captures logs AFTER container exits
├── index.js        # ✅ main loop with sendStatus + formatResult
└── notifier.js     # ✅ sendTelegramMessage + sendStatus
```

**Current limitation:** `worker.js` captures logs only AFTER the container finishes using `container.logs()`. This means:
- No visibility during long-running tasks
- If the container crashes, logs might be lost
- No timestamp tracking per log line

---

## Step-by-Step Instructions

### Step 3.4.1: Create log-collector.js

Create `src/log-collector.js`:

```javascript
/**
 * Collects and formats logs from a container execution.
 * Each log line gets a timestamp for tracking.
 */
export class LogCollector {
  /**
   * @param {string} sessionId - Task session identifier
   */
  constructor(sessionId) {
    this.sessionId = sessionId;
    /** @type {string[]} */
    this.logs = [];
    this.startTime = Date.now();
  }

  /**
   * Add a log line with timestamp.
   * @param {string} line
   */
  add(line) {
    const timestamp = new Date().toISOString().slice(11, 19); // HH:MM:SS
    this.logs.push(`[${timestamp}] ${line}`);
  }

  /**
   * Generate a Telegram-friendly summary message.
   *
   * @param {string} status - 'done' or 'error'
   * @returns {string} Formatted Markdown message
   */
  getSummary(status) {
    const duration = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const icon = status === 'done' ? '✅' : '❌';

    // Build header
    const header = [
      `${icon} *Task ${status.toUpperCase()}*`,
      `Session: \`${this.sessionId}\``,
      `Duration: ${duration}s`,
      '─'.repeat(30),
    ].join('\n');

    // Last 50 lines, max 3000 chars (Telegram limit = 4096, leave room for header)
    const recentLogs = this.logs.slice(-50).join('\n');
    let logText = recentLogs.length > 3000
      ? '...(truncated)...\n' + recentLogs.slice(-3000)
      : recentLogs;

    return `${header}\n\`\`\`\n${logText}\n\`\`\``;
  }
}
```

**Design decisions:**

| Feature | Detail |
|---------|--------|
| Timestamps | `HH:MM:SS` format from ISO string — lightweight and readable |
| Max lines in summary | Last 50 lines — enough context without overwhelming |
| Max chars in summary | 3000 chars — leaves room for header within Telegram's 4096 limit |
| Truncation notice | `...(truncated)...` prefix when logs exceed 3000 chars |
| Duration | Calculated from `startTime` to `getSummary()` call time |

---

### Step 3.4.2: Update worker.js — Real-Time Log Streaming

Replace `src/worker.js` with the enhanced version that uses `LogCollector`:

```javascript
import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { LogCollector } from './log-collector.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

/**
 * Execute a task with real-time log collection.
 *
 * @param {{session_id: string, task: string, chat_id: number|string, source?: string}} taskData
 * @returns {{status: string, logs: string, exitCode: number}}
 */
export async function executeTask(taskData) {
  const { session_id, task, chat_id } = taskData;
  const workspacePath = path.join(config.workspaceBase, session_id);
  const containerName = `openhands-${session_id}`;

  // Initialize log collector
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
      if (finalText && collector.logs.length <= 2) {
        // Only use final logs if streaming captured very little
        finalText.split('\n').filter(Boolean).forEach(l => collector.add(l));
      }
    } catch { /* container auto-removed */ }

    const status = statusCode === 0 ? 'done' : 'error';

    // Save logs to file
    saveLogsToFile(session_id, collector);

    console.log(`📋 Task ${session_id}: ${status} (exit ${statusCode}, ${collector.logs.length} log lines)`);
    return { status, logs: collector.getSummary(status), exitCode: statusCode };

  } catch (err) {
    collector.add(`Error: ${err.message}`);
    console.error(`❌ Task ${session_id} failed:`, err.message);

    // Save logs even on error
    saveLogsToFile(session_id, collector);

    try {
      await docker.getContainer(containerName).kill();
    } catch { /* already gone */ }

    return { status: 'error', logs: collector.getSummary('error'), exitCode: -1 };
  }
}

/**
 * Save collected logs to a file for debugging.
 */
function saveLogsToFile(sessionId, collector) {
  try {
    const logDir = '/app/logs';
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, `${sessionId}.log`),
      collector.logs.join('\n'),
      'utf-8'
    );
  } catch (err) {
    console.error(`⚠️ Failed to save log file for ${sessionId}:`, err.message);
  }
}
```

**Changes from Step 3.2:**

| Before | After |
|--------|-------|
| `container.logs()` after exit | `container.logs({ follow: true })` for real-time streaming |
| Raw string logs | `LogCollector` with timestamps |
| No file output | Logs saved to `/app/logs/{session_id}.log` |
| Simple return | Returns `collector.getSummary(status)` (formatted Markdown) |

---

### Step 3.4.3: Update index.js — Use collector summary

The `index.js` `formatResult()` function is no longer needed since `worker.js` now returns pre-formatted summaries. Simplify:

```javascript
// In runWorker() loop, replace the notification section:

// BEFORE:
const execResult = await executeTask(taskData);
if (taskData.chat_id) {
  const message = formatResult(taskData, execResult);
  await sendTelegramMessage(taskData.chat_id, message);
}

// AFTER:
const execResult = await executeTask(taskData);
if (taskData.chat_id) {
  // execResult.logs already contains the formatted summary from LogCollector
  await sendTelegramMessage(taskData.chat_id, execResult.logs);
}
```

You can **remove** the `formatResult()` function from `index.js` since `worker.js` handles formatting via `LogCollector.getSummary()`.

---

## File Structure — Final

```text
workers/
├── Dockerfile
├── .dockerignore
├── package.json
└── src/
    ├── index.js             # Main loop (updated — simplified formatting)
    ├── config.js            # Environment config
    ├── worker.js            # Task executor (updated — real-time streaming)
    ├── log-collector.js     # ✅ NEW — structured log collection
    └── notifier.js          # Telegram Bot API
```

---

## Log File Storage

Logs are saved at `/app/logs/` inside the container, which maps to `./logs/` on the host:

```text
/opt/ai-agent/logs/
├── session_6302853216_42.log
├── session_6302853216_43.log
└── zalo_userABC_1717500000000.log
```

Each log file contains timestamped lines:

```text
[14:32:01] Task: Create a hello world HTML page
[14:32:01] Container started: openhands-session_6302853216_42
[14:32:02] Running OpenHands...
[14:32:03] Creating workspace...
[14:32:05] Writing index.html...
...
[14:35:22] Task completed successfully
```

Access logs via:

```bash
# On host
ls -la ./logs/
cat ./logs/session_6302853216_42.log

# Or via Docker
docker compose exec worker ls /app/logs/
```

---

## Verification Checklist

```bash
# 1. Rebuild and restart
docker compose up --build -d

# 2. Send a task from Telegram
#    → Worker picks it up

# 3. Watch real-time logs in worker output
docker compose logs -f worker
# Expected:
#   📨 Dequeued: session_xxx
#   🔄 Session `session_xxx`: running
#   🚀 Starting task: session_xxx
#   ✅ Container started: abc123
#   (real-time log lines as they happen)
#   📋 Task session_xxx: done (exit 0, 42 log lines)

# 4. Check Telegram receives formatted summary
# Expected:
#   ✅ *Task DONE*
#   Session: `session_xxx`
#   Duration: 12.3s
#   ──────────────────────────────
#   ```
#   [14:32:01] Task: Create hello world
#   [14:32:02] Container started...
#   ...
#   ```

# 5. Check log file was saved
ls -la ./logs/
# Expected: session_xxx.log exists

# 6. Verify log file content
cat ./logs/session_xxx.log
# Expected: full timestamped log lines
```

---

## Expected Telegram Output

```text
✅ *Task DONE*
Session: `session_6302853216_42`
Duration: 45.2s
──────────────────────────────
```
[14:32:01] Task: Create a hello world HTML page
[14:32:01] Container started: openhands-session_6302853216_42
[14:32:03] Creating workspace...
[14:32:05] Writing index.html...
[14:32:10] Starting server...
[14:32:11] Server running on port 3000
[14:32:45] Task completed successfully
```
```

---

## Important Notes

- **Real-time streaming** uses `container.logs({ follow: true })` — this returns a Node.js stream that emits `data` events as the container produces output
- **`AutoRemove: true`** means the container is gone after exit — the `final log capture` fallback handles edge cases where the stream might miss the last lines
- **Log files are always saved**, even on error — valuable for debugging failed tasks
- **Telegram summary shows last 50 lines** — full logs are always available in the log file
- **Duration tracking** helps identify slow tasks and set appropriate timeouts
- The `LogCollector` class is designed to be extended — in Step 4, it will support per-line streaming to Telegram (not just final summary)
