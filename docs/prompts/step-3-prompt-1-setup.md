# Implementation Prompt — Step 3.1: Worker Project Setup

## Context

You are building the **Worker service** for an AI Coding Agent system. The Worker is a **Node.js** service that:
1. Polls Redis for tasks (enqueued by the Gateway from Step 2)
2. Spawns OpenHands Docker containers to execute coding tasks
3. Captures logs and sends results back to Telegram

The Gateway (Step 2) is already built and running. It pushes tasks to a Redis `task_queue` list. Each task is a JSON object:

```json
{
  "session_id": "session_123456_789",
  "task": "Create a hello world HTML page",
  "chat_id": 123456789,
  "source": "telegram"
}
```

This prompt covers **only the project initialization**: folder structure, `package.json`, config module, Dockerfile, and `docker-compose.yml` update.

---

## Tech Stack (MANDATORY — do not change)

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20+ |
| Docker Client | dockerode |
| Redis Client | ioredis |
| Module System | ES Modules (`"type": "module"`) |
| Containerization | Docker (`node:20-alpine`) |

---

## Existing Project Structure (from Step 2)

```text
/opt/ai-agent/
├── docker-compose.yml          ← needs worker service added
├── .env                        ← already has TELEGRAM_BOT_TOKEN, REDIS_URL
├── .gitignore
├── gateway/                    ← already built (Step 2)
│   ├── Dockerfile
│   ├── package.json
│   └── src/
├── redis/data/
├── workspaces/                 ← needs to be created
├── logs/
└── secrets/
```

---

## Step-by-Step Instructions

### Step 3.1.1: Create Worker Folder Structure

Create the following at `/opt/ai-agent/workers/`:

```text
workers/
├── Dockerfile
├── .dockerignore
├── package.json
└── src/
    ├── index.js          # Main entry point (implement in Step 3.2)
    ├── config.js          # Environment config
    ├── worker.js          # Task executor (implement in Step 3.2)
    └── notifier.js        # Telegram notifier (implement in Step 3.3)
```

---

### Step 3.1.2: Initialize package.json

```bash
cd workers
npm init -y
npm install dockerode ioredis dotenv
```

Set `"type": "module"` and add scripts:

```json
{
  "name": "ai-agent-worker",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node src/index.js"
  }
}
```

Dependencies should include:
- `dockerode` ^4.0.4
- `ioredis` ^5.4.2
- `dotenv` ^16.4.7

---

### Step 3.1.3: Config Module

Create `src/config.js`:

```javascript
import 'dotenv/config';

export const config = {
  // Redis connection (same Redis as Gateway)
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379/0',

  // Telegram Bot Token (same as Gateway — used to send results back)
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,

  // OpenHands Docker image
  openhandsImage: process.env.OPENHANDS_IMAGE || 'docker.all-hands.dev/all-hands-ai/openhands:latest',

  // Workspace base path (where task files are created)
  workspaceBase: process.env.WORKSPACE_BASE || '/workspaces',

  // Task timeout in seconds
  taskTimeout: parseInt(process.env.TASK_TIMEOUT || '600', 10),

  // Memory limit in bytes (default 2GB)
  memLimit: parseInt(process.env.MEM_LIMIT || '2147483648', 10),

  // CPU limit (number of CPUs)
  cpuLimit: parseInt(process.env.CPU_LIMIT || '1', 10),
};

// Validate required fields
if (!config.telegramBotToken) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

console.log(`✅ Worker config loaded — timeout: ${config.taskTimeout}s, mem: ${Math.round(config.memLimit / 1073741824)}GB`);
```

**Key points:**
- Uses `dotenv/config` for auto-loading `.env`
- `redisUrl` must match the Gateway's Redis (same network)
- `telegramBotToken` is the SAME token as the Gateway bot — needed to send messages back
- `workspaceBase` defaults to `/workspaces` (mounted volume in docker-compose)
- Resource limits are configurable via environment variables

---

### Step 3.1.4: Worker Dockerfile

Create `Dockerfile`:

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

Create `.dockerignore`:

```text
node_modules
npm-debug.log
```

> **Note:** The worker image does NOT need Docker CLI. It uses the Docker API via the mounted socket (`/var/run/docker.sock`).

---

### Step 3.1.5: Update Docker Compose

Add the `worker` service to the existing `docker-compose.yml`:

```yaml
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
      - /var/run/docker.sock:/var/run/docker.sock
      - ./workspaces:/workspaces
      - ./logs:/app/logs
```

**Critical volumes:**

| Volume | Purpose |
|--------|---------|
| `/var/run/docker.sock` | Allows worker to create/sibling containers via Docker API |
| `./workspaces:/workspaces` | Task workspace directories persist on host |
| `./logs:/app/logs` | Worker log files persist on host |

**Security note:** The Docker socket mount gives the worker full control over Docker. This is an acceptable trade-off for MVP. In production, use Docker-in-Docker (DinD) or a remote Docker host.

---

### Step 3.1.6: Update .env

Add these optional variables to `.env` (or `.env.example`):

```env
# Worker settings
WORKSPACE_BASE=/workspaces
TASK_TIMEOUT=600
MEM_LIMIT=2147483648
CPU_LIMIT=1
OPENHANDS_IMAGE=docker.all-hands.dev/all-hands-ai/openhands:latest
```

All of these have defaults in `config.js`, so they are optional.

---

## Verification Checklist

```bash
# 1. Build worker image only (test Dockerfile)
docker compose build worker

# 2. Verify image was created
docker images | grep worker

# 3. Start all services
docker compose up --build -d

# 4. Check worker is running (it will fail gracefully — index.js not yet implemented)
docker compose logs worker

# 5. Verify docker-compose structure
docker compose ps
# Expected: gateway, redis, worker all listed
```

---

## Expected Output

```text
workers/
├── Dockerfile              # node:20-alpine, minimal
├── .dockerignore           # node_modules, npm-debug.log
├── package.json            # dockerode + ioredis + dotenv
├── package-lock.json
├── node_modules/
└── src/
    ├── index.js            # placeholder — implemented in Step 3.2
    ├── config.js           # ✅ implemented
    ├── worker.js           # placeholder — implemented in Step 3.2
    └── notifier.js         # placeholder — implemented in Step 3.3
```

---

## Important Notes

- **ES Modules**: Use `import`/`export`, NOT `require()`
- **Worker is a separate service** from Gateway — they communicate ONLY via Redis queue
- **No Telegraf needed** in worker — it calls Telegram Bot API directly via `fetch`
- **Docker socket** is mounted as a volume, NOT installed in the image
- **`.env` is shared** between gateway and worker (same `env_file: - .env`)
- **`WORKSPACE_BASE`** inside the container is `/workspaces`, which maps to `./workspaces` on the host
