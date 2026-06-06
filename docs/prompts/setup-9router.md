# Implementation Prompt — 9Router Setup (LLM Router for OpenHands)

## Context

You are setting up **9Router** as the LLM router for an AI Coding Agent system. 9Router is a free, open-source LLM router that:
1. Provides an **OpenAI-compatible API** at `http://localhost:20128/v1`
2. Routes requests to 40+ providers (Claude, GPT, Gemini, etc.) with **auto-fallback**
3. Saves 20-40% tokens with built-in **RTK Token Saver**
4. Supports **FREE providers** (Kiro AI, OpenCode Free) — no API key needed
5. Has a **web dashboard** for configuration at `http://localhost:20128`

The AI Coding Agent architecture:
```
Telegram → Gateway → Redis → Worker → OpenHands → 9Router → LLM Providers
```

9Router sits between OpenHands and the actual LLM providers, acting as a smart proxy.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| 9Router | `decolua/9router:latest` Docker image |
| API | OpenAI-compatible at `http://9router:20128/v1` |
| Dashboard | Web UI at `http://<host>:20128` |
| Data | Persistent volume at `~/.9router` |

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
- `DATA_DIR=/app/data` tells 9Router where to store its data
- No API keys required in docker-compose — configure via dashboard

---

### Step R2: Configure Worker to Pass LLM Settings to OpenHands

The worker spawns OpenHands containers. OpenHands needs to know:
1. The LLM API endpoint (9Router URL)
2. The API key (from 9Router dashboard)
3. The model name (a combo or direct model)

Update `workers/src/config.js` — add 9Router config:

```javascript
export const config = {
  // ... existing config ...

  // 9Router (LLM Router)
  ninerouterUrl: process.env.NINEROUTER_BASE_URL || 'http://9router:20128',
  ninerouterApiKey: process.env.NINEROUTER_API_KEY || '',
  ninerouterModel: process.env.NINEROUTER_MODEL || 'kr/claude-sonnet-4.5',
};
```

Update `workers/src/worker.js` — pass LLM config as env vars to OpenHands container:

```javascript
// In the docker.createContainer() call, add these Env vars:
Env: [
  `AGENT_SERVER_IMAGE_REPOSITORY=${config.agentServerRepo}`,
  `AGENT_SERVER_IMAGE_TAG=${config.agentServerTag}`,
  'LOG_ALL_EVENTS=true',
  `SANDBOX_RUNTIME_CONTAINER_IMAGE=${config.agentServerRepo}:${config.agentServerTag}`,
  // LLM configuration via 9Router
  `LLM_API_URL=${config.ninerouterUrl}/v1`,
  `LLM_API_KEY=${config.ninerouterApiKey}`,
  `LLM_MODEL=${config.ninerouterModel}`,
],
```

> **Note:** OpenHands reads `LLM_API_URL`, `LLM_API_KEY`, and `LLM_MODEL` to configure its LLM provider. When these point to 9Router, all LLM requests go through 9Router's routing and fallback logic.

---

### Step R3: Update .env.example

Add 9Router section:

```env
# --------------------------------------------
# 9Router — LLM Router (REQUIRED for OpenHands)
# --------------------------------------------
# 9Router provides OpenAI-compatible API with smart routing + fallback
# Dashboard: http://<server-ip>:20128
# API: http://9router:20128/v1 (from inside Docker)
NINEROUTER_PORT=20128
NINEROUTER_BASE_URL=http://9router:20128
# Get API key from 9Router Dashboard → Settings → API Keys
NINEROUTER_API_KEY=
# Model: use a combo name or provider/model format
# Examples: kr/claude-sonnet-4.5, glm/glm-4.7, if/kimi-k2-thinking
NINEROUTER_MODEL=kr/claude-sonnet-4.5
```

---

### Step R4: Initial 9Router Setup (Manual — via Dashboard)

After deploying, configure 9Router via the web dashboard:

1. **Open dashboard**: `http://<server-ip>:20128`

2. **Connect a FREE provider** (no API key needed):
   - Go to **Providers** → **Connect**
   - Choose **Kiro AI** (free Claude unlimited) or **OpenCode Free** (no auth)
   - Click **Connect** — this adds a free LLM source

3. **Create a combo** (optional — for fallback):
   - Go to **Combos** → **Create New**
   - Name: `coding-stack`
   - Add models in priority order:
     1. `kr/claude-sonnet-4.5` (Kiro free tier)
     2. `oc/gpt-4o` (OpenCode free tier)
     3. `if/kimi-k2-thinking` (iFlow free fallback)

4. **Get API key**:
   - Go to **Settings** → **API Keys**
   - Copy the key — this goes into `NINEROUTER_API_KEY` in `.env`

5. **Verify the API**:
   ```bash
   curl http://<server-ip>:20128/v1/models \
     -H "Authorization: Bearer <your-api-key>"
   ```

---

### Step R5: Network Architecture

All services communicate via Docker's internal network:

```
┌───────────────────────────────────────────────┐
│           Docker Compose Network              │
│                                               │
│  Gateway ──→ Redis (task_queue)               │
│     ↑                                         │
│     │                                         │
│  Worker ──→ Redis (BLPOP)                     │
│     │                                         │
│     ├──→ Docker API (spawn OpenHands)         │
│     │                                         │
│  OpenHands ──→ 9Router:20128/v1 (LLM API)    │
│     │              │                          │
│     │              ↓                          │
│     │         LLM Providers (internet)        │
│     │                                         │
│     └──→ Sandbox containers (via docker.sock) │
└───────────────────────────────────────────────┘
```

**Critical:** OpenHands container must be able to reach `9router:20128` via Docker DNS. Since both are in the same `docker-compose.yml`, this works automatically.

---

## Verification Checklist

```bash
# 1. Start all services
docker compose up --build -d

# 2. Check 9Router is running
docker compose ps
# Expected: 9router service UP

# 3. Open dashboard
# Browser: http://<server-ip>:20128

# 4. Test API from host
curl http://localhost:20128/v1/models \
  -H "Authorization: Bearer <api-key>"
# Expected: list of available models

# 5. Test API from inside Docker (worker container)
docker compose exec worker \
  wget -qO- http://9router:20128/v1/models \
  --header="Authorization: Bearer <api-key>"
# Expected: model list JSON

# 6. Connect a free provider via dashboard, then test:
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model": "kr/claude-sonnet-4.5", "messages": [{"role": "user", "content": "Say hello"}]}'
# Expected: LLM response

# 7. Send a Telegram task — full flow test
# Telegram → Gateway → Redis → Worker → OpenHands → 9Router → LLM
```

---

## Expected Output Structure

```text
/opt/ai-agent/
├── docker-compose.yml        # Updated with 9router service
├── .env                      # NINEROUTER_API_KEY, NINEROUTER_MODEL
├── 9router-data/             # Persistent 9Router config (auto-created)
│   ├── providers.json
│   ├── combos.json
│   └── usage.db
├── gateway/
├── workers/
│   └── src/
│       ├── config.js         # Updated with ninerouterUrl/Key/Model
│       └── worker.js         # Updated to pass LLM env vars to OpenHands
└── workspaces/
```

---

## Important Notes

- **FREE providers**: Kiro AI and OpenCode Free require NO API keys — just connect via dashboard
- **API key**: 9Router generates its own API key for clients (found in dashboard Settings)
- **Model format**: `provider/model` (e.g., `kr/claude-sonnet-4.5`, `glm/glm-4.7`)
- **Combo models**: Create named combos in dashboard for auto-fallback
- **OpenAI-compatible**: 9Router speaks OpenAI format — OpenHands uses this natively
- **RTK Token Saver**: Enabled by default in 9Router — automatically saves 20-40% tokens
- **Data persistence**: `./9router-data` volume keeps config across restarts
- **No API keys in docker-compose**: Provider keys are configured via dashboard, not env vars
