# Implementation Prompt — Step 3.3: Telegram Notifier + Result Formatting

## Context

You are implementing the **Telegram notification layer** for the Worker service. The core worker (Step 3.2) is already implemented — it polls Redis, spawns OpenHands containers, and returns results.

This prompt covers implementing:
1. **`notifier.js`** — Full Telegram Bot API integration (sendMessage + sendStatus)
2. **Result formatting** — Converting raw logs into Telegram-friendly Markdown messages

---

## Prerequisites (from Steps 3.1 + 3.2)

Already implemented:

```text
workers/src/
├── config.js       # ✅ exports `config` with `telegramBotToken`
├── worker.js       # ✅ exports `executeTask()` — returns {status, logs, exitCode}
├── index.js        # ✅ main loop — calls `sendTelegramMessage()` from notifier
└── notifier.js     # ⚠️ placeholder — implement now
```

The `index.js` already calls:
- `sendTelegramMessage(chatId, text)` — to notify task started/finished
- `formatResult(taskData, result)` — to format the final message (already in index.js)

---

## Telegram Bot API Reference

The worker uses the **same bot token** as the Gateway. It calls the Telegram Bot API directly via `fetch()` — no Telegraf library needed.

**API endpoint:** `https://api.telegram.org/bot<TOKEN>/sendMessage`

**Request body:**
```json
{
  "chat_id": 6302853216,
  "text": "✅ Task completed\n...",
  "parse_mode": "Markdown"
}
```

**Constraints:**
- Max message length: **4096 characters**
- Parse mode: `Markdown` (supports `*bold*`, `` `code` ``, ` ```code blocks``` `)
- Rate limit: ~30 messages/second (not an issue for MVP)

---

## Step-by-Step Instructions

### Step 3.3.1: Implement notifier.js — sendTelegramMessage

Replace the placeholder `src/notifier.js`:

```javascript
import { config } from './config.js';

const API_BASE = `https://api.telegram.org/bot${config.telegramBotToken}`;

/**
 * Send a message to a Telegram chat.
 * Splits long messages to stay within Telegram's 4096 char limit.
 *
 * @param {number|string} chatId - Telegram chat ID
 * @param {string} text - Message text (Markdown supported)
 */
export async function sendTelegramMessage(chatId, text) {
  const MAX_LEN = 4096;
  const chunks = [];

  // Split message into chunks of MAX_LEN
  for (let i = 0; i < text.length; i += MAX_LEN) {
    chunks.push(text.slice(i, i + MAX_LEN));
  }

  // Send each chunk sequentially
  for (const chunk of chunks) {
    try {
      const response = await fetch(`${API_BASE}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`❌ Telegram API error (${response.status}): ${error}`);
      }
    } catch (err) {
      console.error(`❌ Failed to send Telegram message to ${chatId}:`, err.message);
    }
  }
}
```

**Key design decisions:**

| Decision | Reason |
|----------|--------|
| Use `fetch()` (built-in) | No extra dependency needed — Node.js 20 has native fetch |
| Sequential chunk sending | Ensures messages arrive in order |
| Error handling per chunk | One failed chunk doesn't block the rest |
| 4096 char limit | Telegram's hard limit per message |

---

### Step 3.3.2: Implement sendStatus

Add a convenience function for short status updates:

```javascript
/**
 * Send a short status update to Telegram.
 *
 * @param {number|string} chatId - Telegram chat ID
 * @param {string} sessionId - Task session ID
 * @param {string} status - 'queued', 'running', 'done', 'error'
 */
export async function sendStatus(chatId, sessionId, status) {
  const icons = {
    queued: '📋',
    running: '🔄',
    done: '✅',
    error: '❌',
  };
  const icon = icons[status] || '❓';
  const msg = `${icon} Session \`${sessionId}\`: ${status}`;

  try {
    const response = await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: 'Markdown',
      }),
    });

    if (!response.ok) {
      console.error(`❌ sendStatus failed: ${response.status}`);
    }
  } catch (err) {
    console.error('❌ Failed to send status:', err.message);
  }
}
```

---

### Step 3.3.3: Update index.js — Use sendStatus

Update `src/index.js` to import `sendStatus` and use it for better notifications:

```javascript
// Update the import at the top:
import { sendTelegramMessage, sendStatus } from './notifier.js';

// In the runWorker() loop, update the notification section:

// BEFORE (from Step 3.2):
if (taskData.chat_id) {
  await sendTelegramMessage(
    taskData.chat_id,
    `⏳ *Processing task...*\nSession: \`${taskData.session_id}\``
  );
}

// AFTER (use sendStatus):
if (taskData.chat_id) {
  await sendStatus(taskData.chat_id, taskData.session_id, 'running');
}
```

---

### Step 3.3.4: Improve formatResult in index.js

The `formatResult()` function in `index.js` can be enhanced for better Telegram formatting:

```javascript
/**
 * Format task result into a Telegram-friendly message.
 */
function formatResult(taskData, result) {
  const { session_id } = taskData;
  const statusIcon = result.status === 'done' ? '✅' : '❌';

  // Truncate logs to fit in Telegram (max 4096, leave room for header)
  const logPreview = result.logs.slice(0, 2000);

  const lines = [
    `${statusIcon} *Task ${result.status === 'done' ? 'completed' : 'failed'}*`,
    '',
    `Session: \`${session_id}\``,
    `Exit code: ${result.exitCode}`,
    '',
    '*Logs:*',
    '```',
    logPreview,
    '```',
  ];

  // Add truncation notice if logs were cut
  if (result.logs.length > 2000) {
    lines.push('');
    lines.push('_(logs truncated — full logs saved in workspace)_');
  }

  return lines.join('\n');
}
```

**Formatting rules:**

| Element | Format | Example |
|---------|--------|---------|
| Status icon | Emoji + bold text | `✅ *Task completed*` |
| Session ID | Inline code | `` `session_123_456` `` |
| Exit code | Plain text | `Exit code: 0` |
| Logs | Code block | ` ``` ... ``` ` |
| Truncation notice | Italic | `_(logs truncated)_` |

---

## Full notifier.js — Final Version

Here's the complete file for reference:

```javascript
import { config } from './config.js';

const API_BASE = `https://api.telegram.org/bot${config.telegramBotToken}`;

/**
 * Send a message to a Telegram chat.
 * Splits long messages to stay within Telegram's 4096 char limit.
 */
export async function sendTelegramMessage(chatId, text) {
  const MAX_LEN = 4096;
  const chunks = [];

  for (let i = 0; i < text.length; i += MAX_LEN) {
    chunks.push(text.slice(i, i + MAX_LEN));
  }

  for (const chunk of chunks) {
    try {
      const response = await fetch(`${API_BASE}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`❌ Telegram API error (${response.status}): ${error}`);
      }
    } catch (err) {
      console.error(`❌ Failed to send Telegram message to ${chatId}:`, err.message);
    }
  }
}

/**
 * Send a short status update to Telegram.
 */
export async function sendStatus(chatId, sessionId, status) {
  const icons = {
    queued: '📋',
    running: '🔄',
    done: '✅',
    error: '❌',
  };
  const icon = icons[status] || '❓';
  const msg = `${icon} Session \`${sessionId}\`: ${status}`;

  try {
    await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: 'Markdown',
      }),
    });
  } catch (err) {
    console.error('❌ Failed to send status:', err.message);
  }
}
```

---

## Verification Checklist

```bash
# 1. Rebuild and restart
docker compose up --build -d

# 2. Send a task from Telegram
#    → Gateway queues to Redis
#    → Worker picks it up

# 3. Watch worker logs
docker compose logs -f worker
# Expected flow:
#   📨 Dequeued: session_xxx
#   (sendStatus: running)
#   🚀 Starting task: session_xxx
#   ✅ Container started: abc123
#   📋 Task session_xxx finished — status: done, exit: 0
#   (sendTelegramMessage: result)

# 4. Check Telegram
# Expected messages:
#   🔄 Session `session_xxx`: running
#   ✅ *Task completed*
#   Session: `session_xxx`
#   Exit code: 0
#   Logs: (code block with output)

# 5. Test long message splitting
# Send a task that produces lots of output
# → Telegram should receive multiple messages (auto-split at 4096 chars)
```

---

## Expected Output Structure

```text
workers/src/
├── config.js       # ✅ from Step 3.1
├── worker.js       # ✅ from Step 3.2
├── index.js        # ✅ updated — uses sendStatus + formatResult
└── notifier.js     # ✅ implemented — sendTelegramMessage + sendStatus
```

---

## Important Notes

- **Same bot token**: Worker and Gateway share the SAME `TELEGRAM_BOT_TOKEN` — this means the worker sends messages AS the same bot the user talks to
- **No Telegraf needed**: Worker only SENDS messages, never receives — direct Bot API calls are simpler
- **Markdown escaping**: Telegram Markdown is fragile. Avoid special chars (`_`, `*`, `[`, `]`) in user-provided task text. The logs are inside ` ``` ` code blocks so they're safe
- **`chat_id` comes from Gateway**: The worker never needs to know WHO the user is — it just sends to the `chat_id` from the Redis payload
- **Rate limiting**: Not an issue for MVP (single user, sequential tasks)
- **Message ordering**: Sequential `await` on `fetch()` ensures chunks arrive in order
