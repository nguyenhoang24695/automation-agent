# Step 3: OpenHands SDK Integration (Persistent SDK Service + 9Router)

## Mục tiêu

Tích hợp OpenHands SDK qua **Persistent SDK Service** — một Python FastAPI service chạy dài hạn, duy trì Conversation objects per session. Worker (Node.js) gọi SDK service qua HTTP, không cần tạo container mỗi lần chạy task.

---

## Kiến trúc

```text
Telegram → Gateway → Redis (task_queue)
                          ↓ BLPOP
                    Worker (Node.js)
                          ↓ HTTP POST /task
                    SDK Service (Python FastAPI — chạy dài hạn)
                          ↓ Conversation.send_message() + run()
                    OpenHands SDK → 9Router:20128/v1 (LLM via LiteLLM)
                          ↓ Tools: Terminal, FileEditor, TaskTracker
                    /workspaces/<session_id>/ (files persist to host)
                          ↓ Response
                    Worker captures logs → sends to Telegram
```

### Tại sao dùng Persistent SDK Service?

| Approach | Vấn đề | Kết luận |
|----------|--------|----------|
| REST API (agent-server) | Auth phức tạp, `AssertionError` trong `auth_user_context.py` | ❌ Không phù hợp |
| CLI headless mode | Cần `settings.json` pre-configured, format thay đổi | ❌ Khó automate |
| Docker-in-Docker (cũ) | Mỗi task tạo container mới, 30-60s overhead, không giữ context | ❌ Chậm, tốn token |
| **Persistent SDK Service** | SDK pre-installed, session reuse, context retention | ✅ **Working** |

### Lợi ích

| Metric | DinD (cũ) | Persistent SDK (mới) |
|--------|-----------|---------------------|
| Task #1 (cold start) | 60-90s | ~28s |
| Task #2+ (reused session) | 60-90s | **~10s** |
| Token usage | Không có context | Full conversation context |
| Docker socket | Required | **Not needed** |
| Complexity | Docker API + network.connect() | Simple HTTP POST |

---

## 1. Cấu trúc thư mục

```text
├── sdk-service/
│   ├── Dockerfile          # Python 3.12-slim + SDK pre-installed
│   ├── app.py              # FastAPI session manager (264 lines)
│   ├── requirements.txt    # Dependencies
│   └── .dockerignore
├── workers/
│   ├── Dockerfile          # Node.js 20-alpine (no Docker socket)
│   ├── package.json        # ioredis + dotenv (no dockerode)
│   └── src/
│       ├── index.js        # Main loop: poll Redis, dispatch tasks
│       ├── config.js       # Environment config
│       ├── worker.js       # HTTP client to SDK service
│       ├── log-collector.js
│       └── notifier.js     # Telegram notifications
```

---

## 2. SDK Service

### Dockerfile

```dockerfile
FROM python:3.12-slim

WORKDIR /app

# Install system deps (git for agent terminal, jq, curl)
RUN apt-get update -qq && \
    apt-get install -y -qq git curl jq > /dev/null 2>&1 && \
    rm -rf /var/lib/apt/lists/*

# Install uv (fast Python package manager)
RUN pip install uv -q

# Pre-install OpenHands SDK (baked into image — no install at runtime)
RUN uv pip install --system openhands openhands-tools fastapi uvicorn[standard]

# Copy app
COPY app.py ./app.py

EXPOSE 8080

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
```

### app.py — FastAPI Session Manager

Key components:

**Session storage:**
```python
sessions = {}  # session_id → {conversation, lock, log_buffer, created_at, ...}
sessions_lock = threading.Lock()
```

**Session creation (first task):**
```python
def get_or_create_session(session_id, workspace_path=None):
    from openhands.sdk import LLM, Agent, Conversation, Tool
    from openhands.tools.file_editor import FileEditorTool
    from openhands.tools.task_tracker import TaskTrackerTool
    from openhands.tools.terminal import TerminalTool

    llm = LLM(
        model=f"openai/{LLM_MODEL}",   # openai/kr/claude-sonnet-4.5
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,          # http://9router:20128/v1
    )

    agent = Agent(llm=llm, tools=[
        Tool(name=TerminalTool.name),
        Tool(name=FileEditorTool.name),
        Tool(name=TaskTrackerTool.name),
    ])

    conversation = Conversation(agent=agent, workspace=ws_dir)
    # Store in sessions dict...
```

**Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/task` | POST | Execute a task in a session (creates session if new) |
| `/session/{id}` | DELETE | Remove session from memory |
| `/sessions` | GET | List active sessions with stats |
| `/health` | GET | Health check (used by worker wait loop) |

**Task execution flow:**
1. `POST /task` with `{session_id, task, workspace}`
2. Get or create session (SDK init ~2-3s on first call)
3. Run `conversation.send_message()` + `conversation.run()` in thread
4. Return status, logs, duration, task_number

---

## 3. Worker

### config.js

```javascript
import 'dotenv/config';

export const config = {
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379/0',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  sdkServiceUrl: process.env.SDK_SERVICE_URL || 'http://sdk-service:8080',
  ninerouterUrl: process.env.NINEROUTER_URL || 'http://9router:20128',
  ninerouterApiKey: process.env.NINEROUTER_API_KEY || '',
  ninerouterModel: process.env.NINEROUTER_MODEL || 'kr/claude-sonnet-4.5',
  workspaceBase: process.env.WORKSPACE_BASE || '/workspaces',
  taskTimeout: parseInt(process.env.TASK_TIMEOUT || '600', 10),
};
```

### worker.js — HTTP Client

```javascript
export async function executeTask(taskData) {
  const { session_id, task } = taskData;
  const workspacePath = path.join(config.workspaceBase, session_id);

  fs.mkdirSync(workspacePath, { recursive: true });

  // Wait for SDK service health check
  await waitForSdkService(collector);

  // Send task via HTTP
  const response = await fetch(`${SDK_SERVICE_URL}/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id,
      task,
      workspace: workspacePath,
    }),
    signal: AbortSignal.timeout(config.taskTimeout * 1000),
  });

  const result = await response.json();
  // result: { status, new_session, task_number, duration, logs, error? }
}
```

**No more:**
- `dockerode` dependency
- Docker socket mount
- `network.connect()` calls
- Container lifecycle management
- Image pulling logic

---

## 4. Docker Compose

```yaml
services:
  gateway:
    build: ./gateway
    ports:
      - "${GATEWAY_PORT:-8000}:8000"
    env_file: .env
    environment:
      - REDIS_URL=redis://redis:6379/0
    depends_on:
      redis: { condition: service_healthy }
    volumes:
      - ./logs:/app/logs
      - ./secrets:/app/secrets

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

  redis:
    image: redis:7-alpine
    volumes:
      - ./redis/data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

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
      - ./workspaces:/workspaces    # Files persist to host
      - ./logs:/app/logs

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

**Key points:**
- `sdk-service` and `worker` share `./workspaces:/workspaces` volume
- No Docker socket mount anywhere
- All services on same docker-compose network (no `network.connect()` needed)
- `RUNTIME=local` tells SDK to run tools directly (no sandbox container)

---

## 5. Environment Variables

| Variable | Default | Used By | Description |
|----------|---------|---------|-------------|
| `REDIS_URL` | `redis://redis:6379/0` | Worker | Redis connection |
| `TELEGRAM_BOT_TOKEN` | (required) | Worker | Telegram Bot API token |
| `SDK_SERVICE_URL` | `http://sdk-service:8080` | Worker | SDK service URL |
| `NINEROUTER_URL` | `http://9router:20128` | Worker | 9Router base URL |
| `NINEROUTER_API_KEY` | (required) | SDK Service | 9Router API key |
| `NINEROUTER_MODEL` | `kr/claude-sonnet-4.5` | SDK Service | LLM model name |
| `LLM_BASE_URL` | `http://9router:20128/v1` | SDK Service | Full API URL |
| `WORKSPACE_BASE` | `/workspaces` | Both | Workspace base path |
| `TASK_TIMEOUT` | `600` | Both | Max seconds per task |

---

## 6. Network Architecture

```
┌──────────────────────────────────────────────────────────┐
│           Docker Compose Network                         │
│                                                          │
│  Gateway ──→ Redis (task_queue LPUSH)                    │
│                                                          │
│  Worker ──→ Redis (BLPOP)                                │
│     │                                                    │
│     ├──→ SDK Service (HTTP POST /task)                   │
│     │                                                    │
│  SDK Service ──→ 9Router:20128/v1 (LLM via LiteLLM)     │
│     │              │                                     │
│     │              ↓                                     │
│     │         LLM Providers (internet)                   │
│     │                                                    │
│     └──→ /workspaces/<session_id>/ (bind mount → host)   │
└──────────────────────────────────────────────────────────┘
```

All services communicate via Docker Compose's default network. No explicit network connect needed.

---

## 7. Build & Run

```bash
cd /home/ubuntu/automation-agent
docker compose up --build -d

# Check status
docker compose ps

# View logs
docker compose logs -f sdk-service worker

# Test (push task directly to Redis)
docker compose exec redis redis-cli LPUSH task_queue \
  '{"session_id":"test_001","task":"Create hello.txt with Hello World","chat_id":0}'
```

Or from local machine:
```bash
node scripts/deploy.js          # Full deploy
node scripts/deploy.js worker   # Worker only
node scripts/deploy.js sdk      # SDK service only
node scripts/test-worker.js     # Test with monitoring
```

---

## 8. Session Lifecycle

```
Task 1 (session_id=abc):
  → SDK service creates Conversation object (~2-3s)
  → send_message() + run() (~25s)
  → Total: ~28s
  → Session kept in memory

Task 2 (session_id=abc):
  → SDK service REUSES existing Conversation (~0s)
  → Agent has full context from Task 1
  → send_message() + run() (~10s)
  → Total: ~10s
  → Token savings from context reuse

Cleanup:
  → DELETE /session/abc removes from memory
  → Workspace files remain on host unless delete_workspace=true
```

---

## 9. Troubleshooting

| Vấn đề | Nguyên nhân | Cách xử lý |
|---------|-------------|------------|
| `SDK service not ready after 60s` | SDK service chưa khởi động xong | Check `docker compose logs sdk-service` |
| `BadRequestError: LLM Provider NOT provided` | Thiếu `openai/` prefix | SDK tự động thêm: `openai/{LLM_MODEL}` |
| `Connection refused` đến sdk-service | Service crash hoặc chưa start | `docker compose restart sdk-service` |
| Files not appearing on host | Workspace mount sai | Check `./workspaces:/workspaces` in docker-compose |
| Session busy (409) | Task trước chưa xong | Wait hoặc increase timeout |
| High memory usage | Nhiều sessions tích lũy | Periodically cleanup old sessions |
| Worker không dequeue | Redis connection error | Check `REDIS_URL` và Redis health |

---

## 10. Monitoring

```bash
# SDK service health
curl http://localhost:8080/health

# Active sessions
curl http://localhost:8080/sessions

# Worker logs
docker compose logs -f worker

# SDK service logs
docker compose logs -f sdk-service
```

---

## Kết quả Step 3

- [x] Persistent SDK Service (Python FastAPI) — always running
- [x] Worker calls SDK service via HTTP (no Docker-in-Docker)
- [x] Conversation context retention across tasks
- [x] LLM calls via 9Router (OpenAI-compatible API)
- [x] Agent tools: Terminal, FileEditor, TaskTracker
- [x] Workspace isolation per session_id
- [x] File persistence to host filesystem
- [x] Task timeout handling (threading)
- [x] No Docker socket required
- [x] ~10s response for reused sessions (vs 60-90s with DinD)

---

## Step tiếp theo

→ [Step 4: Stream Logs to Telegram](step-4-stream-logs.md)
