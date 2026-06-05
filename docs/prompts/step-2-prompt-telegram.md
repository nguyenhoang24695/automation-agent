# Implementation Prompt — Step 2: Gateway API (Telegram Integration)

## Context

You are building the **Gateway API** for an AI Coding Agent system. The Gateway is a **Node.js** application that:
1. Receives commands from Telegram users via a bot
2. Validates users against a whitelist
3. Pushes tasks into a Redis queue for workers to process

The project lives at `/opt/ai-agent/gateway/` (production) but you will develop locally first.

---

## Tech Stack (MANDATORY — do not change)

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20+ |
| HTTP Framework | Express |
| Telegram Bot | Telegraf v4 |
| Redis Client | ioredis |
| Module System | ES Modules (`"type": "module"`) |
| Containerization | Docker (`node:20-alpine`) |

---

## Task: Implement Telegram Bot Integration

### Objective

Build the **complete Gateway** with working Telegram bot that:
- Responds to `/start` command
- Receives text messages from whitelisted users
- Enqueues tasks to Redis
- Exposes health check and queue status APIs
- Runs inside Docker alongside Redis

### Prerequisites

The following environment variables will be provided via `.env` file:

```env
TELEGRAM_BOT_TOKEN=<your-bot-token-from-BotFather>
ALLOWED_USERS=<comma-separated-telegram-user-ids>
REDIS_URL=redis://redis:6379/0
GATEWAY_PORT=8000
```

---

## Step-by-Step Instructions

### Step 2.1: Project Initialization

Create the project structure:

```text
gateway/
├── Dockerfile
├── .dockerignore
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
└── .env (not committed — use .env.example as template)
```

Initialize with:

```bash
cd gateway
npm init -y
npm install express telegraf ioredis dotenv
```

Set `"type": "module"` in `package.json` and add scripts:

```json
{
  "type": "module",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js"
  }
}
```

---

### Step 2.2: Config Module

Create `src/config.js`:
- Load environment variables using `dotenv`
- Export a `config` object with:
  - `telegramBotToken` (string, required)
  - `allowedUsers` (array of integers, parsed from comma-separated string)
  - `redisUrl` (string, default: `redis://redis:6379/0`)
  - `gatewayPort` (integer, default: `8000`)
- Validate that `TELEGRAM_BOT_TOKEN` exists — throw error if missing

---

### Step 2.3: Whitelist Module

Create `src/bot/whitelist.js`:
- Import `config`
- Export `isAllowed(userId)` function that returns `true` if `userId` is in `config.allowedUsers`

---

### Step 2.4: Redis Queue Module

Create `src/queue/redis.js`:
- Connect to Redis using `ioredis` with `config.redisUrl`
- Export functions:
  - `enqueueTask(sessionId, task, chatId)` — push JSON payload to `task_queue` list (RPUSH)
  - `dequeueTask()` — pop from `task_queue` (LPOP), return parsed JSON or null
  - `getQueueSize()` — return length of `task_queue` (LLEN)
- Export the `redis` client instance
- Log connection success/failure events

---

### Step 2.5: Telegram Bot Module

Create `src/bot/telegram.js`:
- Initialize `Telegraf` with `config.telegramBotToken`
- Implement handlers:
  - **`/start`**: Check whitelist → reply with welcome message or access denied
  - **`/help`**: List available commands
  - **Text messages**: Check whitelist → generate `session_id` (format: `session_{userId}_{messageId}`) → call `enqueueTask()` → reply with confirmation including session ID
- Export `startBot()` — launches bot with long polling
- Export `stopBot()` — graceful shutdown
- Export `bot` instance (for use by other modules to send messages later)

---

### Step 2.6: API Routes

Create `src/api/routes.js`:
- `GET /api/health` → `{ status: "ok", uptime: <seconds> }`
- `GET /api/queue/size` → `{ queue_size: <number> }`

---

### Step 2.7: Main Entry Point

Create `src/index.js`:
- Initialize Express app
- Mount API routes under `/api`
- Start Express server on `config.gatewayPort`
- Start Telegram bot (long polling)
- Handle `SIGINT` and `SIGTERM` for graceful shutdown (stop bot + close server)

---

### Step 2.8: Docker Setup

Create `Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src/ ./src/
EXPOSE 8000
CMD ["node", "src/index.js"]
```

Create `.dockerignore`:

```text
node_modules
npm-debug.log
.env
```

Create `docker-compose.yml` at project root (`/opt/ai-agent/`):

```yaml
services:
  gateway:
    build: ./gateway
    ports:
      - "8000:8000"
    env_file:
      - .env
    environment:
      - REDIS_URL=redis://redis:6379/0
    depends_on:
      - redis
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes:
      - ./redis/data:/data
    restart: unless-stopped
```

---

### Step 2.9: Verification Checklist

Run these checks to confirm everything works:

```bash
# 1. Build and start
docker compose up --build -d

# 2. Check services are running
docker compose ps

# 3. Health check API
curl http://localhost:8000/api/health
# Expected: {"status":"ok","uptime":...}

# 4. Queue size API
curl http://localhost:8000/api/queue/size
# Expected: {"queue_size":0}

# 5. Telegram test: open your bot in Telegram
#    - Send /start → expect "🤖 AI Coding Agent ready..."
#    - Send any text → expect "📋 Task received! Session: session_..."
#    - Send from non-whitelisted account → expect "⛔ Access denied."

# 6. Check logs
docker compose logs -f gateway

# 7. Send a message from Telegram, then check queue:
curl http://localhost:8000/api/queue/size
# Expected: {"queue_size":1} (or more)
```

---

## Expected Output Structure

```text
gateway/
├── Dockerfile
├── .dockerignore
├── package.json
├── package-lock.json
└── src/
    ├── index.js          # Express + bot startup + graceful shutdown
    ├── config.js          # dotenv config with validation
    ├── bot/
    │   ├── telegram.js    # Telegraf bot: /start, /help, text handler
    │   └── whitelist.js   # isAllowed(userId) check
    ├── api/
    │   └── routes.js      # /api/health, /api/queue/size
    └── queue/
        └── redis.js       # enqueueTask, dequeueTask, getQueueSize
```

---

## Important Notes

- **ES Modules**: Use `import`/`export`, NOT `require()`
- **Session ID format**: `session_{telegram_user_id}_{message_id}` — this is used by workers to send logs back to the correct user
- **chat_id**: Must be included in the Redis payload so workers can send messages back via Telegram Bot API
- **Long polling**: Use Telegraf's `bot.launch()` (polling), NOT webhooks — simpler for MVP
- **Graceful shutdown**: Always stop bot and close server on SIGINT/SIGTERM
- **Security**: `.env` file must NEVER be committed to git (already in `.gitignore`)
