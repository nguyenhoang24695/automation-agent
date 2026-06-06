# Implementation Prompt — 9Router Setup (LLM Router for Persistent SDK Service)

## Context

You are setting up **9Router** as the LLM router for an AI Coding Agent system. The system uses a **Persistent SDK Service** — a Python FastAPI service that maintains OpenHands Conversation objects across requests, enabling context retention and fast response times.

9Router is a free, open-source LLM router that:
1. Provides an **OpenAI-compatible API** at `http://localhost:20128/v1`
2. Routes requests to 40+ providers (Claude, GPT, Gemini, etc.) with **auto-fallback**
3. Saves 20-40% tokens with built-in **RTK Token Saver**
4. Supports **FREE providers** (Kiro AI, OpenCode Free) — no API key needed
5. Has a **web dashboard** for configuration at `http://localhost:20128`

The AI Coding Agent architecture:
```
Telegram → Gateway → Redis → Worker (Node.js)
    → SDK Service (Python FastAPI — persistent)
        → 9Router:20128/v1 (LLM API via LiteLLM)
        → /workspaces/<session_id>/ (files persist to host)
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| 9Router | `decolua/9router:latest` Docker image |
| API | OpenAI-compatible at `http://9router:20128/v1` |
| Dashboard | Web UI at `http://<host>:20128` |
| SDK Service | Python FastAPI + OpenHands SDK |
| Worker | Node.js (ioredis + fetch) |

---

## Step-by-Step Instructions

### Step R1: Add 9Router to Docker Compose

Add the `9router` service to `docker-compose.yml`:

```yaml
  9router:
    image: decolua/9router:latest
    ports:
      - "${NINEROUTER_PORT:-20128}:20128"
    volumes:
      - ./9router-data:/app/data
    environment:
      - DATA_DIR=/app/data
      - PORT=20128
      - HOSTNAME=0.0.0.0
    restart: unless-stopped
```

**Key details:**
- Port `20128` serves both the dashboard and the API
- Volume `./9router-data` persists provider configs, combos, and usage data
- No API keys required in docker-compose — configure via dashboard

---

### Step R2: Configure SDK Service to Use 9Router

The **SDK Service** (not the worker) connects to 9Router. The worker only calls the SDK service via HTTP.

Add `sdk-service` to `docker-compose.yml`:

```yaml
  sdk-service:
    build: ./sdk-service
    env_file: .env
    environment:
      - LLM_MODEL=${NINEROUTER_MODEL:-kr/claude-sonnet-4.5}
      - LLM_API_KEY=${NINEROUTER_API_KEY}
      - LLM_BASE_URL=http://9router:20128/v1
      - WORKSPACE_BASE=/workspaces
      - TASK_TIMEOUT=${TASK_TIMEOUT:-600}
      - RUNTIME=local
    depends_on:
      9router: { condition: service_started }
    volumes:
      - ./workspaces:/workspaces
      - ./logs:/app/logs
```

**Critical env vars:**
- `LLM_BASE_URL=http://9router:20128/v1` — 9Router API (same Docker network, direct hostname)
- `LLM_API_KEY` — from 9Router dashboard
- `LLM_MODEL` — e.g. `kr/claude-sonnet-4.5`
- `RUNTIME=local` — tools run directly in SDK container (no sandbox)

The SDK service prepends `openai/` to the model for LiteLLM:
```python
llm = LLM(model=f"openai/{LLM_MODEL}")  # → openai/kr/claude-sonnet-4.5
```

---

### Step R3: Configure Worker

The worker only needs to know the SDK service URL:

```yaml
  worker:
    build: ./workers
    env_file: .env
    environment:
      - REDIS_URL=redis://redis:6379/0
      - WORKSPACE_BASE=/workspaces
      - SDK_SERVICE_URL=http://sdk-service:8080
      - NINEROUTER_URL=http://9router:20128
    depends_on:
      redis: { condition: service_healthy }
      sdk-service: { condition: service_started }
    volumes:
      - ./workspaces:/workspaces
      - ./logs:/app/logs
```

Worker sends tasks via HTTP:
```javascript
const response = await fetch(`${SDK_SERVICE_URL}/task`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ session_id, task, workspace: workspacePath }),
  signal: AbortSignal.timeout(config.taskTimeout * 1000),
});
```

---

### Step R4: Update .env

```env
# --------------------------------------------
# 9Router — LLM Router (REQUIRED for SDK Service)
# --------------------------------------------
NINEROUTER_PORT=20128
NINEROUTER_API_KEY=sk-xxxxx          # From 9Router Dashboard → Settings → API Keys
NINEROUTER_MODEL=kr/claude-sonnet-4.5 # Model name or combo name
```

---

### Step R5: Initial 9Router Setup (via Dashboard)

1. **Open dashboard**: `http://<server-ip>:20128`

2. **Connect a FREE provider** (no API key needed):
   - Go to **Providers** → **Connect**
   - Choose **Kiro AI** (free Claude unlimited) or **OpenCode Free**
   - Click **Connect**

3. **Create a combo** (optional — for fallback):
   - Go to **Combos** → **Create New**
   - Name: `coding-stack`
   - Add models: `kr/claude-sonnet-4.5`, `oc/gpt-4o`, `if/kimi-k2-thinking`

4. **Get API key**:
   - Go to **Settings** → **API Keys**
   - Copy the key → `NINEROUTER_API_KEY` in `.env`

5. **Verify the API**:
   ```bash
   curl http://<server-ip>:20128/v1/models \
     -H "Authorization: Bearer <api-key>"
   ```

---

### Step R6: Network Architecture

All services on the same Docker Compose network — simple hostname resolution:

```
┌──────────────────────────────────────────────────────────┐
│           Docker Compose Network                         │
│                                                          │
│  Gateway ──→ Redis (task_queue LPUSH)                    │
│                                                          │
│  Worker ──→ Redis (BLPOP)                                │
│     │                                                    │
│     └──→ SDK Service:8080 (HTTP POST /task)              │
│              │                                           │
│              ├──→ 9Router:20128/v1 (LLM via LiteLLM)    │
│              │         │                                 │
│              │         ↓                                 │
│              │    LLM Providers (internet)               │
│              │                                           │
│              └──→ /workspaces/<sid>/ (bind mount → host) │
└──────────────────────────────────────────────────────────┘
```

No Docker socket, no `network.connect()`, no sandbox containers.

---

## Verification Checklist

```bash
# 1. Start all services
docker compose up --build -d

# 2. Check all services running
docker compose ps
# Expected: 9router, redis, gateway, sdk-service, worker all UP

# 3. Test SDK service health
curl http://localhost:8080/health
# Expected: {"status":"ok","active_sessions":0,...}

# 4. Test 9Router API from host
curl http://localhost:20128/v1/models \
  -H "Authorization: Bearer <api-key>"

# 5. Test 9Router API from inside Docker (SDK service)
docker compose exec sdk-service \
  curl -s http://9router:20128/v1/models \
  -H "Authorization: Bearer <api-key>"

# 6. Test LLM call
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"kr/claude-sonnet-4.5","messages":[{"role":"user","content":"Say hello"}]}'

# 7. Test worker (push task to Redis)
docker compose exec redis redis-cli LPUSH task_queue \
  '{"session_id":"test_9router","task":"Create hello.txt with Hello from 9Router","chat_id":0}'
# Then: docker compose logs -f worker sdk-service

# 8. Verify file created on host
ls -la workspaces/test_9router/
cat workspaces/test_9router/hello.txt

# 9. Test context retention (same session_id, different task)
docker compose exec redis redis-cli LPUSH task_queue \
  '{"session_id":"test_9router","task":"Now add a second line to hello.txt","chat_id":0}'
# Should complete faster (session reused)

# 10. Full flow: Telegram → Gateway → Redis → Worker → SDK Service → 9Router → LLM
```

---

## Expected Output Structure

```text
/home/ubuntu/automation-agent/
├── docker-compose.yml
├── .env                              # NINEROUTER_API_KEY, NINEROUTER_MODEL, TELEGRAM_BOT_TOKEN
├── 9router-data/                     # 9Router persistent config
├── sdk-service/
│   ├── Dockerfile                    # Python 3.12-slim + SDK pre-installed
│   ├── app.py                        # FastAPI session manager
│   └── requirements.txt
├── workers/
│   ├── Dockerfile                    # Node.js 20-alpine (no Docker socket)
│   ├── package.json                  # ioredis + dotenv only
│   └── src/
│       ├── config.js                 # SDK_SERVICE_URL, NINEROUTER_URL
│       ├── worker.js                 # HTTP client to SDK service
│       ├── index.js                  # Redis BLPOP loop
│       ├── log-collector.js
│       └── notifier.js
├── workspaces/
│   └── <session_id>/                 # Files created by agent persist here
└── logs/
```

---

## Important Notes

- **FREE providers**: Kiro AI and OpenCode Free require NO API keys
- **`openai/` prefix**: SDK service auto-prepends for LiteLLM: `openai/kr/claude-sonnet-4.5`
- **`uv` over `pip`**: SDK Dockerfile uses `uv pip install --system` for better dependency resolution
- **Persistent sessions**: SDK service keeps Conversation objects in memory across requests
- **Context retention**: Agent remembers previous tasks in the same session
- **No Docker socket**: Worker and SDK service don't need Docker access
- **RUNTIME=local**: Tools run directly in SDK container (no sandbox isolation)
- **RTK Token Saver**: 9Router saves 20-40% tokens automatically
- **Response times**: ~28s cold start, ~10s for reused sessions
- **Cleanup sessions**: `DELETE /session/{id}` to free memory (files remain on host)
