# Step 6: Add Cloudflare Tunnel (Node.js Worker)

## Mục tiêu

Expose local web apps (Next.js, React, etc.) ra internet qua Cloudflare Tunnel — không cần mở port VPS.

---

## Kiến trúc

```text
Web App (localhost:3000)
    ↓
cloudflared tunnel (spawned by Worker)
    ↓
*.trycloudflare.com (public URL)
    ↓
Worker sends URL to Telegram
```

---

## 1. Cài đặt cloudflared

cloudflared is installed inside the Worker container (see Dockerfile in Section 7).

---

## 2. Tunnel Helper

Tạo file **workers/src/tunnel-helper.js:**

```javascript
import { spawn } from 'node:child_process';

/**
 * Manages Cloudflare Tunnels to expose local ports.
 */
export class TunnelHelper {
  constructor() {
    /** @type {Map<string, import('child_process').ChildProcess>} */
    this.processes = new Map();
  }

  /**
   * Start a tunnel for the given port.
   * @param {string} sessionId
   * @param {number} localPort
   * @returns {Promise<string|null>} - Public URL or null
   */
  async startTunnel(sessionId, localPort) {
    try {
      const proc = spawn('cloudflared', [
        'tunnel',
        '--url', `http://localhost:${localPort}`,
        '--no-autoupdate',
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.processes.set(sessionId, proc);

      // Extract URL from stderr (cloudflared writes URL to stderr)
      const url = await this.extractUrl(proc, 30);
      return url;

    } catch (err) {
      console.error(`❌ Tunnel error: ${err.message}`);
      return null;
    }
  }

  /**
   * Read cloudflared stderr to extract the tunnel URL.
   * @param {import('child_process').ChildProcess} proc
   * @param {number} timeoutSec
   * @returns {Promise<string|null>}
   */
  extractUrl(proc, timeoutSec = 30) {
    const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) { resolved = true; resolve(null); }
      }, timeoutSec * 1000);

      proc.stderr.on('data', (chunk) => {
        const line = chunk.toString();
        const match = urlPattern.exec(line);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(match[0]);
        }
      });

      proc.on('exit', () => {
        if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); }
      });
    });
  }

  /**
   * Stop a tunnel by session ID.
   */
  stopTunnel(sessionId) {
    const proc = this.processes.get(sessionId);
    if (proc) {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
      this.processes.delete(sessionId);
      console.log(`🛑 Tunnel stopped: ${sessionId}`);
    }
  }

  /**
   * Stop all active tunnels.
   */
  stopAll() {
    for (const [sid] of this.processes) {
      this.stopTunnel(sid);
    }
  }
}
```

---

## 3. Tích hợp vào Worker

Update **workers/src/worker.js** — auto-detect web app port and create tunnel:

```javascript
import { TunnelHelper } from './tunnel-helper.js';
import fs from 'node:fs';
import path from 'node:path';

const tunnelHelper = new TunnelHelper();

// Add to config.js:
// tunnelEnabled: process.env.TUNNEL_ENABLED === 'true',
// defaultAppPort: parseInt(process.env.DEFAULT_APP_PORT || '3000', 10),

/**
 * Detect if a web app exists in the workspace.
 * @param {string} workspacePath
 * @param {number} defaultPort
 * @returns {number|null}
 */
function detectWebAppPort(workspacePath, defaultPort) {
  // Check for package.json (likely a Node.js app)
  if (fs.existsSync(path.join(workspacePath, 'package.json'))) {
    return defaultPort;
  }

  // Check common framework config files
  const portFiles = [
    { file: 'vite.config.*', port: 5173 },
    { file: 'next.config.*', port: 3000 },
    { file: 'angular.json', port: 4200 },
  ];

  for (const { file, port } of portFiles) {
    if (fs.existsSync(path.join(workspacePath, file))) {
      return port;
    }
  }

  return null;
}

/**
 * Auto-stop a tunnel after a delay.
 */
function autoStopTunnel(sessionId, delayMs = 1800000) { // 30 minutes
  setTimeout(() => tunnelHelper.stopTunnel(sessionId), delayMs);
}

// After OpenHands task completes, check for web app:
// if (execResult.status === 'done' && config.tunnelEnabled) {
//   const port = detectWebAppPort(workspacePath, config.defaultAppPort);
//   if (port && chat_id) {
//     await sendStatus(chat_id, session_id, '🌐 Starting tunnel...');
//     const url = await tunnelHelper.startTunnel(session_id, port);
//     if (url) {
//       await sendTelegramMessage(chat_id, `🌐 *Preview URL*: ${url}`);
//       autoStopTunnel(session_id);
//     }
//   }
// }
```

---

## 4. Bot Command — Tunnel Control (Gateway — Node.js)

Thêm vào **gateway/src/bot/telegram.js:**

```javascript
// /tunnel start <session_id> <port>
// /tunnel stop <session_id>
bot.command('tunnel', async (ctx) => {
  if (!isAllowed(ctx.from.id)) {
    return ctx.reply('⛔ Access denied.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  const action = args[0];

  if (action === 'start' && args.length >= 2) {
    const sessionId = args[1];
    const port = parseInt(args[2]) || 3000;
    await enqueueTask(sessionId, `[TUNNEL_START] port=${port}`, ctx.chat.id);
    return ctx.reply(`🌐 Starting tunnel on port ${port}...`);
  }

  if (action === 'stop' && args.length >= 2) {
    const sessionId = args[1];
    await enqueueTask(sessionId, '[TUNNEL_STOP]', ctx.chat.id);
    return ctx.reply('🛑 Stopping tunnel...');
  }

  return ctx.reply(
    'Usage:\n/tunnel start <session_id> <port>\n/tunnel stop <session_id>'
  );
});
```

---

## 5. Worker — Xử lý Tunnel Commands (Node.js)

Add to **workers/src/worker.js** — handle `[TUNNEL_*]` tasks:

```javascript
// In executeTask(), add tunnel handling:

if (task.startsWith('[TUNNEL_START]')) {
  const portStr = task.split('port=')[1]?.trim();
  const port = parseInt(portStr) || config.defaultAppPort;
  const url = await tunnelHelper.startTunnel(session_id, port);
  if (url) {
    return { status: 'done', logs: `🌐 Tunnel URL: ${url}`, exitCode: 0 };
  }
  return { status: 'error', logs: '❌ Failed to start tunnel', exitCode: 1 };
}

if (task === '[TUNNEL_STOP]') {
  tunnelHelper.stopTunnel(session_id);
  return { status: 'done', logs: '🛑 Tunnel stopped', exitCode: 0 };
}
```

---

## 6. Docker: Install cloudflared in Worker

Update **workers/Dockerfile:**

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Install git and cloudflared
RUN apk add --no-cache git openssh-client curl

# Install cloudflared (ARM64 compatible)
ARG TARGETARCH
RUN curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${TARGETARCH:-arm64} \
    -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

CMD ["node", "src/index.js"]
```

---

## 7. Environment Variables

Thêm vào **docker-compose.yml** — worker section:

```yaml
  worker:
    build: ./workers
    environment:
      - REDIS_URL=redis://redis:6379/0
      - WORKSPACE_BASE=/workspaces
      - TUNNEL_ENABLED=true
      - DEFAULT_APP_PORT=3000
    # ... existing volumes ...
```

---

## 8. Security Rules

```text
✅ DO:
- Sử dụng quick tunnel (trycloudflare.com) cho MVP
- Auto-stop tunnel sau 30 phút
- Mỗi session chỉ 1 tunnel

❌ DON'T:
- KHÔNG dùng Cloudflare named tunnel (cần auth)
- KHÔNG expose port > 10 phút không dùng
- KHÔNG expose services nội bộ (Redis, Gateway)
```

---

## 9. Build & Run

```bash
cd /opt/ai-agent
docker compose up --build -d
```

---

## 10. Kiểm tra

```text
1. Gửi task: "Create Next.js landing page and run it on port 3000"
2. OpenHands tạo code và chạy app
3. Worker auto-detect port 3000
4. Tunnel created → URL gửi về Telegram:
   🌐 Preview URL: https://random-name.trycloudflare.com
5. Truy cập URL từ browser → thấy landing page
6. /tunnel stop session_xxx → tunnel đóng
```

---

## Kết quả Step 6

- [x] cloudflared installed in Node.js worker container
- [x] Auto-detect web app port
- [x] Quick tunnel creates public URL (trycloudflare.com)
- [x] URL sent to Telegram automatically
- [x] Auto-stop after 30 minutes
- [x] Bot commands: `/tunnel start`, `/tunnel stop`

---

## Hoàn thành Phase 1 MVP!

```text
✅ Telegram commands (Node.js Gateway)
✅ Single user (whitelist)
✅ OpenHands worker (Node.js + dockerode)
✅ Coding task execution
✅ Logs streamed to Telegram
✅ Docker sandbox isolation
✅ Git support
✅ Cloudflare Tunnel preview URLs
```

---

## Next: Phase 2

→ Zalo integration, Session persistence, Multi-user, GitHub PR automation
