# Step 3: Run OpenHands from Docker

## Mục tiêu

Tích hợp OpenHands — AI coding agent tự động thực thi task trong Docker sandbox.

---

## Kiến trúc

```text
Redis Queue
    ↓ (dequeue)
Worker Manager
    ↓ (spawn container)
OpenHands Container
    ↓ (workspace isolated)
/workspaces/{session_id}
```

---

## 1. OpenHands Docker Image

```bash
# Pull image trước
docker pull docker.all-hands.dev/all-hands-ai/openhands:latest
```

---

## 2. Worker Manager

Tạo file **workers/worker.py:**

```python
import asyncio
import json
import docker
import redis.asyncio as aioredis
from config import REDIS_URL

redis_client = aioredis.from_url(REDIS_URL)
docker_client = docker.from_env()

TASK_QUEUE = "task_queue"
OPENHANDS_IMAGE = "docker.all-hands.dev/all-hands-ai/openhands:latest"
WORKSPACE_BASE = "/opt/ai-agent/workspaces"


async def run_worker():
    """Vòng lặp chính: lấy task từ queue và spawn OpenHands container."""
    print("🔄 Worker started, waiting for tasks...")

    while True:
        result = await redis_client.blpop(TASK_QUEUE, timeout=5)
        if not result:
            continue

        _, raw = result
        task_data = json.loads(raw)
        session_id = task_data["session_id"]
        task_text = task_data["task"]

        await execute_task(session_id, task_text)


async def execute_task(session_id: str, task: str):
    """Spawn OpenHands container để thực thi task."""
    workspace_path = f"{WORKSPACE_BASE}/{session_id}"

    # Tạo workspace directory
    import os
    os.makedirs(workspace_path, exist_ok=True)

    print(f"🚀 Starting task: {session_id}")

    try:
        container = docker_client.containers.run(
            image=OPENHANDS_IMAGE,
            name=f"openhands-{session_id}",
            detach=True,
            remove=True,
            environment={
                "SANDBOX_RUNTIME_CONTAINER_IMAGE": OPENHANDS_IMAGE,
            },
            volumes={
                workspace_path: {"bind": "/workspace", "mode": "rw"},
            },
            network_mode="bridge",
            mem_limit="2g",
            cpu_quota=100000,  # 1 CPU
        )

        print(f"✅ Container started: {container.short_id}")

        # Chờ container hoàn thành
        result = container.wait(timeout=600)  # max 10 phút
        logs = container.logs().decode("utf-8", errors="replace")

        print(f"📋 Task {session_id} completed")
        return {"status": "done", "logs": logs}

    except docker.errors.ContainerError as e:
        print(f"❌ Container error: {e}")
        return {"status": "error", "logs": str(e)}

    except Exception as e:
        print(f"❌ Error: {e}")
        return {"status": "error", "logs": str(e)}


if __name__ == "__main__":
    asyncio.run(run_worker())
```

---

## 3. Worker Config

Tạo file **workers/config.py:**

```python
import os
from dotenv import load_dotenv

load_dotenv()

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
WORKSPACE_BASE = os.getenv("WORKSPACE_BASE", "/opt/ai-agent/workspaces")
```

---

## 4. Worker Dockerfile

Tạo file **workers/Dockerfile:**

```dockerfile
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "worker.py"]
```

---

## 5. Worker Dependencies

Tạo file **workers/requirements.txt:**

```text
docker==7.*
redis==5.*
python-dotenv==1.*
```

---

## 6. Cập nhật Docker Compose

Thêm worker vào **docker-compose.yml:**

```yaml
services:
  gateway:
    build: ./gateway
    ports:
      - "8000:8000"
    env_file:
      - ./secrets/telegram.env
    environment:
      - REDIS_URL=redis://redis:6379/0
    depends_on:
      - redis
    volumes:
      - ./logs:/app/logs

  redis:
    image: redis:7-alpine
    volumes:
      - ./redis/data:/data

  worker:
    build: ./workers
    env_file:
      - ./secrets/telegram.env
    environment:
      - REDIS_URL=redis://redis:6379/0
      - WORKSPACE_BASE=/workspaces
    depends_on:
      - redis
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./workspaces:/workspaces
      - ./logs:/app/logs
```

> ⚠️ **Lưu ý bảo mật**: Worker cần Docker socket để spawn container con. Đây là trade-off cần thiết. Trong production, nên dùng Docker-in-Docker (DinD) hoặc remote Docker host.

---

## 7. Security: Workspace Isolation

Mỗi task chạy trong workspace riêng:

```text
/opt/ai-agent/workspaces/
├── session_123456789_100/
├── session_123456789_101/
└── session_123456789_102/
```

Rules:
- **KHÔNG** mount `/`, `/home`, `/root`
- **KHÔNG** mount `/var/run/docker.sock` vào OpenHands container
- Mỗi container bị giới hạn **2GB RAM**, **1 CPU**
- Timeout **10 phút** mỗi task

---

## 8. Build & Run

```bash
cd /opt/ai-agent
docker compose up --build -d
```

---

## 9. Kiểm tra

```bash
# Xem logs worker
docker compose logs -f worker

# Gửi task qua Telegram: "Create hello world HTML page"
# → Worker spawn OpenHands container
# → Container thực thi task trong workspace riêng
```

---

## 10. Troubleshooting

| Vấn đề | Nguyên nhân | Cách xử lý |
|---------|-------------|------------|
| Worker không spawn container | Docker socket permission | Kiểm tra volume mount |
| Container timeout | Task quá phức tạp | Tăng timeout hoặc chia nhỏ task |
| Out of memory | Container vượt 2GB | Tăng `mem_limit` hoặc optimize |
| Workspace không tạo | Permission denied | Kiểm tra `chown` thư mục |

---

## Kết quả Step 3

- [x] Worker lắng nghe task từ Redis queue
- [x] OpenHands container spawn tự động
- [x] Workspace isolation theo session_id
- [x] Resource limits (RAM, CPU, timeout)
- [x] Logs hiển thị qua `docker compose logs`

---

## Step tiếp theo

→ [Step 4: Stream Logs to Telegram](step-4-stream-logs.md)
