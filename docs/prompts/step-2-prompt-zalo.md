# Implementation Prompt — Step 2: Gateway API (Zalo Integration)

## Context

You are adding a **Zalo adapter** to the existing Gateway API (Node.js). The Gateway already has a working Telegram adapter. Zalo will be the **second input channel** — both adapters share the same Redis queue and worker pipeline.

> **Warning**: `zca-js` is an unofficial Zalo API that simulates browser behavior. Use at your own risk — accounts may be banned.

### Current architecture (before Zalo):

```text
Telegram User → Telegraf Bot → whitelist → enqueueTask() → Redis Queue → Worker
```

### Target architecture (after Zalo):

```text
Telegram User → Telegraf Bot    ─┐
                                  ├→ whitelist → enqueueTask() → Redis Queue → Worker
Zalo User     → Zalo Listener   ─┘
```

---

## Tech Stack (ADDITIONAL dependencies)

| Component | Technology |
|-----------|-----------|
| Zalo API | `zca-js` v2+ |
| Image metadata | `sharp` (required by zca-js v2 for local images) |
| Existing stack | Node.js 20, Express, ioredis, Telegraf |

---

## Task: Add Zalo as a Second Adapter

### Objective

Add a Zalo channel to the Gateway that:
- Logs in via saved credentials (Cookie + IMEI) or QR code
- Listens for incoming messages via WebSocket
- Validates senders against a Zalo whitelist
- Enqueues tasks to the **same** Redis queue as Telegram
- Can receive logs/responses back from workers and send them to Zalo users

### Prerequisites

Add these to `.env`:

```env
# Zalo (optional — leave empty to disable)
ZALO_ENABLED=true
ZALO_CREDENTIALS_PATH=./secrets/zalo_credentials.json
ZALO_ALLOWED_USERS=<comma-separated-zalo-user-ids>
```

---

## Step-by-Step Instructions

### Step Z.1: Install Dependencies

```bash
cd gateway
npm install zca-js sharp
```

---

### Step Z.2: Update Config Module

Add Zalo config to `src/config.js`:

```javascript
// Add to the existing config object:
zalo: {
  enabled: process.env.ZALO_ENABLED === 'true',
  credentialsPath: process.env.ZALO_CREDENTIALS_PATH || './secrets/zalo_credentials.json',
  allowedUsers: (process.env.ZALO_ALLOWED_USERS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean),
},
```

---

### Step Z.3: Create Zalo Whitelist

Create `src/bot/zalo-whitelist.js`:

```javascript
import { config } from '../config.js';

/**
 * Check if a Zalo user ID is in the whitelist.
 * @param {string} userId - Zalo user ID
 * @returns {boolean}
 */
export function isZaloAllowed(userId) {
  return config.zalo.allowedUsers.includes(userId);
}
```

---

### Step Z.4: Create Zalo Adapter Module

Create `src/bot/zalo.js` — the core Zalo adapter:

```javascript
import { Zalo, ThreadType } from 'zca-js';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { isZaloAllowed } from './zalo-whitelist.js';
import { enqueueTask } from '../queue/redis.js';

let zaloApi = null;

// Image metadata getter required by zca-js v2
async function imageMetadataGetter(filePath) {
  const data = await fs.promises.readFile(filePath);
  const metadata = await sharp(data).metadata();
  return {
    height: metadata.height || 0,
    width: metadata.width || 0,
    size: metadata.size || data.length,
  };
}

/**
 * Load saved credentials from disk.
 */
function loadCredentials() {
  const credPath = path.resolve(config.zalo.credentialsPath);
  if (!fs.existsSync(credPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  } catch {
    console.error('❌ Failed to parse Zalo credentials');
    return null;
  }
}

/**
 * Save credentials after QR login for reuse.
 */
function saveCredentials(data) {
  const credPath = path.resolve(config.zalo.credentialsPath);
  const dir = path.dirname(credPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(credPath, JSON.stringify(data, null, 2));
  console.log('✅ Zalo credentials saved to', credPath);
}

/**
 * Start the Zalo adapter.
 * Tries saved credentials first, falls back to QR login.
 */
export async function startZalo() {
  if (!config.zalo.enabled) {
    console.log('⏭  Zalo adapter disabled');
    return;
  }

  const zalo = new Zalo({ imageMetadataGetter });

  // Try saved credentials
  const credentials = loadCredentials();
  if (credentials) {
    try {
      zaloApi = await zalo.login(credentials);
      console.log('✅ Zalo logged in (saved credentials), UID:', zaloApi.getContext().uid);
    } catch (err) {
      console.warn('⚠️  Saved credentials expired, falling back to QR login...');
      zaloApi = await loginWithQR(zalo);
    }
  } else {
    console.log('📱 No saved Zalo credentials — starting QR login...');
    zaloApi = await loginWithQR(zalo);
  }

  // Start listening for messages
  setupListener();
}

/**
 * QR code login flow.
 */
async function loginWithQR(zalo) {
  const qrPath = path.resolve('./secrets/zalo_qr.png');
  const dir = path.dirname(qrPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const api = await zalo.loginQR(
    { qrPath },
    (event) => {
      if (event.type === 'GotLoginInfo') {
        saveCredentials(event.data);
      }
    }
  );

  console.log('✅ Zalo logged in via QR code');
  console.log(`📱 Scan QR at: ${qrPath}`);
  return api;
}

/**
 * Set up WebSocket listener for incoming messages.
 */
function setupListener() {
  const { listener } = zaloApi;

  listener.on('message', async (message) => {
    // Skip self-sent messages
    if (message.isSelf) return;

    // Only handle text messages for now
    const content = message.data?.content;
    if (typeof content !== 'string') return;

    const senderId = message.threadId;
    const isGroup = message.type === ThreadType.Group;

    // Whitelist check (skip for group messages for now — only DM)
    if (!isGroup && !isZaloAllowed(senderId)) {
      await zaloApi.sendMessage(
        { msg: '⛔ Access denied.' },
        message.threadId,
        message.type
      );
      return;
    }

    // Generate session ID: zalo_{userId}_{timestamp}
    const sessionId = `zalo_${senderId}_${Date.now()}`;

    // Enqueue task — source field identifies the adapter
    await enqueueTask(sessionId, content, senderId, {
      source: 'zalo',
      threadId: message.threadId,
      threadType: message.type,
    });

    // Confirm receipt
    await zaloApi.sendMessage(
      {
        msg: `📋 Task received!\nSession: ${sessionId}\nStatus: Queued`,
        quote: message.data,
      },
      message.threadId,
      message.type
    );
  });

  listener.onConnected(() => console.log('✅ Zalo WebSocket connected'));
  listener.onClosed(() => console.log('⚠️  Zalo WebSocket disconnected'));
  listener.onError((err) => console.error('❌ Zalo WebSocket error:', err));

  listener.start();
  console.log('🤖 Zalo adapter started (listening)');
}

/**
 * Send a message back to a Zalo user (used by worker log callback).
 */
export async function sendZaloMessage(threadId, threadType, text) {
  if (!zaloApi) {
    console.warn('⚠️  Zalo API not initialized — cannot send message');
    return;
  }
  try {
    await zaloApi.sendMessage({ msg: text }, threadId, threadType);
  } catch (err) {
    console.error('❌ Failed to send Zalo message:', err.message);
  }
}

/**
 * Stop the Zalo adapter gracefully.
 */
export async function stopZalo() {
  if (zaloApi?.listener) {
    try {
      zaloApi.listener.stop();
      console.log('🤖 Zalo adapter stopped');
    } catch (err) {
      console.error('Error stopping Zalo:', err.message);
    }
  }
}

export { zaloApi };
```

---

### Step Z.5: Update Redis Queue to Support Adapter Metadata

Modify `src/queue/redis.js` — the `enqueueTask` function needs an optional `meta` parameter:

```javascript
/**
 * Push a task to the Redis queue (FIFO).
 * @param {string} sessionId
 * @param {string} task
 * @param {string|number} chatId
 * @param {object} [meta] - Optional adapter metadata (source, threadId, threadType)
 */
export async function enqueueTask(sessionId, task, chatId, meta = {}) {
  const payload = JSON.stringify({
    session_id: sessionId,
    task,
    chat_id: chatId,
    ...meta,
  });
  await redis.rpush(TASK_QUEUE, payload);
}
```

This is **backward-compatible** — the existing Telegram handler doesn't pass `meta`, so it still works.

---

### Step Z.6: Update Main Entry Point

Modify `src/index.js` to start and stop the Zalo adapter:

```javascript
import express from 'express';
import { config } from './config.js';
import { startBot, stopBot } from './bot/telegram.js';
import { startZalo, stopZalo } from './bot/zalo.js';
import apiRoutes from './api/routes.js';

const app = express();
app.use('/api', apiRoutes);

const server = app.listen(config.gatewayPort, () => {
  console.log(`🚀 Gateway API listening on port ${config.gatewayPort}`);
});

// Start adapters
startBot();
startZalo();

// Graceful shutdown
async function shutdown(signal) {
  console.log(`\n⏹  Received ${signal} — shutting down...`);
  try { await stopBot(); } catch (err) { console.error('Error stopping Telegram:', err.message); }
  try { await stopZalo(); } catch (err) { console.error('Error stopping Zalo:', err.message); }
  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('⚠️  Forced shutdown after timeout');
    process.exit(1);
  }, 5000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
```

---

### Step Z.7: Add API Route for Zalo Status

Add to `src/api/routes.js`:

```javascript
// GET /api/zalo/status
router.get('/zalo/status', async (req, res) => {
  const { zaloApi } = await import('../bot/zalo.js');
  res.json({
    zalo_enabled: config.zalo.enabled,
    zalo_connected: !!zaloApi,
    zalo_uid: zaloApi?.getContext()?.uid || null,
  });
});
```

---

### Step Z.8: Update Dockerfile

The `sharp` package requires native build tools. Update the Dockerfile:

```dockerfile
FROM node:20-alpine

# sharp needs python3 + build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src/ ./src/

# Create secrets directory for Zalo credentials
RUN mkdir -p secrets

EXPOSE 8000

CMD ["node", "src/index.js"]
```

---

### Step Z.9: Update docker-compose.yml

Mount the secrets volume so Zalo credentials persist:

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
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
    volumes:
      - ./logs:/app/logs
      - ./secrets:/app/secrets   # ← Zalo credentials persist here
```

---

## Expected Output Structure

```text
gateway/
├── Dockerfile                    # Updated: sharp build deps
├── package.json                  # + zca-js, sharp
├── src/
│   ├── index.js                  # Updated: start/stop Zalo adapter
│   ├── config.js                 # Updated: zalo config section
│   ├── bot/
│   │   ├── telegram.js           # Unchanged
│   │   ├── whitelist.js          # Unchanged
│   │   ├── zalo.js               # NEW: Zalo adapter (login, listener, sendMessage)
│   │   └── zalo-whitelist.js     # NEW: isZaloAllowed()
│   ├── api/
│   │   └── routes.js             # Updated: /api/zalo/status
│   └── queue/
│       └── redis.js              # Updated: optional meta parameter
└── secrets/
    └── zalo_credentials.json     # Auto-generated after QR login
```

---

## Verification Checklist

```bash
# 1. Build and start (ZALO_ENABLED=false for first test)
ZALO_ENABLED=false docker compose up --build -d

# 2. Health check
curl http://localhost:8000/api/health

# 3. Zalo status (should show disabled)
curl http://localhost:8000/api/zalo/status
# Expected: {"zalo_enabled":false,"zalo_connected":false}

# 4. Enable Zalo and restart (first time: QR login required)
ZALO_ENABLED=true docker compose up --build -d

# 5. Check logs for QR code path
docker compose logs -f gateway
# Expected: "📱 Scan QR at: ./secrets/zalo_qr.png"

# 6. Copy QR image out and scan with Zalo app
docker compose cp gateway:/app/secrets/zalo_qr.png ./zalo_qr.png

# 7. After QR scan, check credentials saved
docker compose logs gateway | grep "credentials saved"

# 8. Send a message to your Zalo account from another account
# Expected: Bot replies "📋 Task received! Session: zalo_..."

# 9. Check queue
curl http://localhost:8000/api/queue/size
# Expected: {"queue_size":1}
```

---

## Important Notes

- **ES Modules**: Use `import`/`export`, NOT `require()`
- **Session ID format**: `zalo_{userId}_{timestamp}` — different prefix from Telegram to identify source
- **Adapter metadata**: The `meta` object in Redis payload (`source: 'zalo'`, `threadId`, `threadType`) lets workers know which adapter to reply through
- **QR login**: First-time setup requires scanning a QR code — credentials are saved for subsequent runs
- **Single listener**: Zalo WebSocket allows only **one active listener** per account — do NOT run Zalo Web/PC app simultaneously
- **Credentials security**: `secrets/` directory must be in `.gitignore` — never commit Zalo credentials
- **Backward compatibility**: All changes are additive — Telegram continues to work without any modifications
- **Docker native deps**: `sharp` needs `python3`, `make`, `g++` in the Alpine build image

---

## Redis Payload Format Comparison

### Telegram task:
```json
{
  "session_id": "session_123456_789",
  "task": "Build a React todo app",
  "chat_id": 123456
}
```

### Zalo task:
```json
{
  "session_id": "zalo_userABC_1717500000000",
  "task": "Build a React todo app",
  "chat_id": "userABC",
  "source": "zalo",
  "threadId": "userABC",
  "threadType": "User"
}
```

Workers can check `source` field to determine which adapter to send logs back through.
