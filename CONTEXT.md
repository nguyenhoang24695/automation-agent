# Project Context — AI Automation Agent

> **Last updated**: Step 3 completed (OpenHands SDK integration)
> **Status**: Working MVP — Telegram → Gateway → Redis → Worker → SDK Service → 9Router → LLM

---

## 1. Project Overview

A self-hosted AI coding agent system that receives commands via **Telegram** (and **Zalo**), executes coding tasks autonomously using **OpenHands SDK**, and returns results back to the chat.

### Key Achievements (Step 1–3)

| Step | Description | Status |
|------|-------------|--------|
| Step 1 | Ubuntu server setup, Docker, 9Router | ✅ Done |
| Step 2 | Gateway API (Telegram + Zalo bot), Redis queue | ✅ Done |
| Step 3 | OpenHands SDK integration via Persistent SDK Service | ✅ Done |
| Step 4 | Log streaming (real-time) | ⏳ Planned |
| Step 5 | Git support | ⏳ Planned |
| Step 6 | Cloudflare Tunnel (public preview URLs) | ⏳ Planned |

---

## 2. Current Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Telegram   │     │    Zalo     │     │  HTTP API   │
│   Bot       │     │   Bot       │     │  (future)   │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────┬───────┘───────────────────┘
                   ▼
          ┌─────────────────┐
          │    Gateway       │  Node.js + Express + Telegraf
          │    (port 8000)   │  Whitelist, session_id generation
          └────────┬────────┘
                   │ LPUSH task_queue
                   ▼
          ┌─────────────────┐
          │     Redis        │  FIFO task queue
          │   (port 6379)    │  Key: task_queue
          └────────┬────────┘
                   │ BLPOP
                   ▼
          ┌─────────────────┐
          │    Worker        │  Node.js, HTTP client
          │                  │  Sends POST /task to SDK service
          └────────┬────────┘
                   │ HTTP POST /task
                   ▼
          ┌─────────────────┐
          │  SDK Service     │  Python FastAPI (port 8080)
          │  (OpenHands)     │  Maintains Conversation objects per session
          └────────┬────────┘
                   │ LLM calls (OpenAI-compatible)
                   ▼
          ┌─────────────────┐
          │    9Router       │  LLM routing + fallback
          │   (port 20128)   │  Model: kr/minimax-m2.5 (default)
          └─────────────────┘
```

---

## 3. Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Gateway | Node.js + Express + Telegraf | Node 20-alpine |
| Worker | Node.js + ioredis | Node 20-alpine |
| SDK Service | Python + FastAPI + OpenHands SDK | Python 3.12-slim |
| Queue | Redis | 7-alpine |
| LLM Router | 9Router (decolua/9router) | latest |
| LLM Model | kr/minimax-m2.5 | via Kiro provider |
| Server | Ubuntu 24.04 | — |
| Containerization | Docker + Docker Compose | — |

---

## 4. Directory Structure

```
d:\Project\AUtomation_Agent\        # Local workspace (Windows)
│
├── docker-compose.yml              # All services definition
├── .env                            # Secrets (not in repo)
│
├── gateway/                        # Gateway API service
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js                # Express server + bot startup
│       ├── config.js               # Environment config
│       ├── api/routes.js           # /health, /queue/size, /zalo/status
│       ├── bot/
│       │   ├── telegram.js         # Telegram bot handler
│       │   ├── whitelist.js        # Telegram user whitelist
│       │   ├── zalo.js             # Zalo bot handler
│       │   └── zalo-whitelist.js   # Zalo user whitelist
│       └── queue/redis.js          # Redis queue (enqueueTask)
│
├── workers/                        # Worker service
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js                # BLPOP loop + task dispatch
│       ├── config.js               # Environment config
│       ├── worker.js               # HTTP client to SDK service
│       ├── log-collector.js        # Log formatting
│       └── notifier.js             # Telegram message sender
│
├── sdk-service/                    # OpenHands SDK service (Python)
│   ├── Dockerfile
│   ├── requirements.txt
│   └── app.py                      # FastAPI app, Conversation manager
│
├── scripts/                        # Deployment & testing scripts
│   ├── deploy.js                   # Main deploy script (SSH + SFTP)
│   ├── deploy-9router.js           # 9Router deployment
│   └── test-worker.js              # Push test task to Redis
│
└── docs/                           # Documentation
    ├── step-1-setup.md             # Server setup guide
    ├── step-2-gateway.md           # Gateway implementation
    ├── step-3-openhands.md         # OpenHands SDK integration
    ├── step-4-stream-logs.md       # Log streaming (planned)
    ├── step-5-git-support.md       # Git support (planned)
    ├── step-6-cloudflare-tunnel.md # Cloudflare Tunnel (planned)
    └── prompts/                    # Implementation prompts
```

**Server deployment path**: `/home/ubuntu/automation-agent/` (192.168.5.123)

---

## 5. Data Flow — End-to-End

### 5.1 User sends "Xin chào" on Telegram

1. **Gateway** (`telegram.js:53`) receives message
   - Whitelist check: `isAllowed(ctx.from.id)`
   - Generate session_id: `session_${ctx.chat.id}` (chat-based, NOT message-based)
   - Enqueue: `enqueueTask(sessionId, taskText, ctx.chat.id)`

2. **Redis** stores task as JSON in `task_queue` (FIFO via RPUSH)
   ```json
   { "session_id": "session_123456", "task": "Xin chào", "chat_id": 123456 }
   ```

3. **Worker** (`index.js:31`) BLPOP from Redis
   - Send "running" status to Telegram
   - Call `executeTask(taskData)`

4. **Worker** (`worker.js:39`) sends HTTP POST to SDK service
   ```json
   POST http://sdk-service:8080/task
   { "session_id": "session_123456", "task": "Xin chào", "workspace": "/workspaces/session_123456" }
   ```

5. **SDK Service** (`app.py:186`) processes task
   - Get or create Conversation for `session_123456`
   - If new session: create LLM, Agent, Conversation with tools
   - Run `conversation.send_message(task_text)` + `conversation.run()`
   - Capture agent's text reply via `event_callback` (MessageEvent with source='agent')
   - Return response with `agent_reply` field

6. **Worker** receives response
   - If `result.response` exists → send ONLY agent reply to Telegram
   - Otherwise → send full technical logs

7. **Telegram** receives agent's conversational reply

### 5.2 Context Retention

- Same `session_id` (based on `chat.id`) → reuses same Conversation object
- Second message sees previous conversation history
- Performance: cold start ~10s, reused session ~3-5s

---

## 6. Key Design Decisions

### 6.1 Persistent SDK Service (not per-task containers)

**Problem**: Original approach spawned a new Docker container per task → 30+ seconds cold start, no context retention.

**Solution**: Long-running Python FastAPI service that holds `Conversation` objects in memory.

**Benefits**:
- Instant execution (no container creation)
- Context retention across tasks (same session)
- Token savings (conversation history preserved)

**File**: `sdk-service/app.py`

### 6.2 Chat-based Session ID

**Problem**: Using `session_${userId}_${messageId}` created a new session for every message.

**Solution**: Use `session_${chat.id}` so the same Telegram chat reuses the same session.

**File**: `gateway/src/bot/telegram.js:53`

### 6.3 Agent Reply Separation

**Problem**: User only wanted the agent's conversational reply, not technical logs.

**Solution**:
- SDK Service captures `MessageEvent` via callback, extracts text from `llm_message.content`
- API response includes separate `response` field
- Worker sends `agentReply || logs` to Telegram (agent reply preferred)

**Files**: `sdk-service/app.py:78-92`, `workers/src/worker.js:64-83`, `workers/src/index.js:47-51`

### 6.4 System Prompt for Tool Suppression

**Problem**: OpenHands used tools (Terminal, FileEditor) even for simple greetings → multiple LLM calls, slow response.

**Solution**: Added system prompt instructing agent to respond directly for non-technical queries.

**File**: `sdk-service/app.py:131-147`

### 6.5 LiteLLM openai/ prefix

**Important**: 9Router provides OpenAI-compatible API. LiteLLM requires `openai/` prefix for model names.

```python
LLM(model="openai/kr/minimax-m2.5", ...)  # Correct
LLM(model="kr/minimax-m2.5", ...)         # Wrong — LiteLLM won't route correctly
```

**File**: `sdk-service/app.py:118`

---

## 7. Configuration

### 7.1 Environment Variables (.env)

| Variable | Purpose | Default |
|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token | Required |
| `ALLOWED_USERS` | Comma-separated Telegram user IDs | — |
| `NINEROUTER_API_KEY` | 9Router API key | Required |
| `NINEROUTER_MODEL` | LLM model name | `kr/minimax-m2.5` |
| `TASK_TIMEOUT` | Task execution timeout (seconds) | `600` |
| `GATEWAY_PORT` | Gateway HTTP port | `8000` |
| `ZALO_ENABLED` | Enable Zalo adapter | `false` |
| `ZALO_ALLOWED_USERS` | Comma-separated Zalo user IDs | — |

### 7.2 9Router Available Models

```
kr/auto, kr/auto-thinking
kr/claude-haiku-4.5, kr/claude-sonnet-4, kr/claude-sonnet-4.5
kr/deepseek-3.2, kr/glm-5
kr/minimax-m2.1, kr/minimax-m2.5  ← current default
kr/qwen3-coder-next
```

Each model has `-agentic` and `-thinking` variants.

---

## 8. Deployment

### 8.1 Server Info

| Property | Value |
|----------|-------|
| IP | 192.168.5.123 |
| OS | Ubuntu 24.04 |
| User | ubuntu |
| Project path | /home/ubuntu/automation-agent |

### 8.2 Deploy Script

```bash
# Full deploy (all services)
node scripts/deploy.js

# Single service
node scripts/deploy.js worker
node scripts/deploy.js sdk
node scripts/deploy.js gateway

# 9Router (separate script)
node scripts/deploy-9router.js
```

**Deploy process**: SFTP upload → docker compose build → docker compose up -d

### 8.3 Testing

```bash
# Push test task to Redis
node scripts/test-worker.js

# Push custom task
node scripts/test-worker.js "Create a Python hello world"
```

---

## 9. Docker Compose Services

| Service | Image/Build | Port | Depends On |
|---------|-------------|------|------------|
| `gateway` | build: ./gateway | 8000 | redis |
| `9router` | decolua/9router:latest | 20128 | — |
| `redis` | redis:7-alpine | 6379 | — |
| `sdk-service` | build: ./sdk-service | 8080 (internal) | 9router |
| `worker` | build: ./workers | — | redis, sdk-service |

**Network**: All services on `automation-agent_default` Docker network. Services communicate via Docker DNS (e.g., `http://sdk-service:8080`).

---

## 10. Key Code Patterns

### 10.1 SDK Service — Conversation Lifecycle

```python
# Create session (first message)
llm = LLM(model="openai/kr/minimax-m2.5", api_key=..., base_url=...)
agent = Agent(llm=llm, tools=[Terminal, FileEditor, TaskTracker], system_prompt=...)
conversation = Conversation(agent=agent, workspace=ws_dir, callbacks=[event_callback])

# Reuse session (subsequent messages)
session_data = sessions[session_id]  # Same conversation object
conversation.send_message(task_text)
conversation.run()
```

### 10.2 Callback for Agent Reply Extraction

```python
def event_callback(event):
    if isinstance(event, MessageEvent) and event.source == 'agent':
        for content in event.llm_message.content:
            if hasattr(content, 'text'):
                agent_responses.append(content.text)
```

### 10.3 Worker — Task Execution

```javascript
const response = await fetch(`${SDK_SERVICE_URL}/task`, {
  method: 'POST',
  body: JSON.stringify({ session_id, task, workspace }),
});
const result = await response.json();
return { status, logs, exitCode, agentReply: result.response };
```

---

## 11. Known Issues & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| New session per message | `session_${userId}_${messageId}` | Changed to `session_${chat.id}` |
| Slow response (130s+) | Agent using tools for simple queries | Added system prompt for tool suppression |
| Only technical logs shown | No agent reply extraction | Added callback-based MessageEvent capture |
| tmux warning in logs | tmux not installed in SDK container | Added `tmux` to Dockerfile apt-get |
| Gateway not deployed | deploy.js didn't upload gateway files | Added gateway upload support to deploy.js |
| LiteLLM routing error | Missing `openai/` prefix | Use `model="openai/${LLM_MODEL}"` |

---

## 12. Next Steps (Step 4+)

### Step 4: Log Streaming
- Stream real-time logs from SDK service to Telegram
- Currently only final result is sent

### Step 5: Git Support
- Clone repositories
- Commit/push changes
- PR creation

### Step 6: Cloudflare Tunnel
- Expose local web apps via tunnel
- Return public preview URL to Telegram

---

## 13. Quick Reference for Agents

### To understand the current system:
1. Read this file first
2. Check `docker-compose.yml` for service definitions
3. Check `sdk-service/app.py` for SDK integration details
4. Check `gateway/src/bot/telegram.js` for message handling
5. Check `workers/src/worker.js` for task execution

### To deploy changes:
```bash
node scripts/deploy.js         # All services
node scripts/deploy.js worker  # Worker only
node scripts/deploy.js sdk     # SDK service only
node scripts/deploy.js gateway # Gateway only
```

### To test:
```bash
node scripts/test-worker.js "Your test task here"
```

### Key ports on server (192.168.5.123):
- Gateway API: `8000`
- 9Router Dashboard: `20128`
- 9Router API: `http://localhost:20128/v1`

---

*This file is maintained as the single source of truth for project context. Update after each step completion.*
