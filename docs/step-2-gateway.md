# Step 2: Build Minimal Gateway API

## Mục tiêu

Xây dựng Gateway API — lớp orchestration nhận lệnh từ Telegram, đẩy task vào hàng đợi, và quản lý worker.

---

## Kiến trúc

```text
Telegram User
     ↓ (message)
aiogram Bot Handler
     ↓ (validate user)
FastAPI Gateway
     ↓ (enqueue task)
Redis Queue
     ↓ (notify)
Worker Manager
```

---

## 1. Cấu trúc thư mục Gateway

```text
/opt/ai-agent/gateway/
├── Dockerfile
├── requirements.txt
├── main.py
├── bot/
│   ├── __init__.py
│   ├── handlers.py
│   └── whitelist.py
├── api/
│   ├── __init__.py
│   └── routes.py
├── queue/
│   ├── __init__.py
│   └── redis_queue.py
└── config.py
```

---

## 2. Dependencies

**requirements.txt:**

```text
fastapi==0.115.*
uvicorn==0.32.*
aiogram==3.*
redis==5.*
python-dotenv==1.*
httpx==0.27.*
```

---

## 3. Config

**config.py:**

```python
import os
from dotenv import load_dotenv

load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
ALLOWED_USERS = [int(uid) for uid in os.getenv("ALLOWED_USERS", "").split(",") if uid]
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
GATEWAY_PORT = int(os.getenv("GATEWAY_PORT", "8000"))
```

---

## 4. Telegram Whitelist

**bot/whitelist.py:**

```python
from config import ALLOWED_USERS

def is_allowed(user_id: int) -> bool:
    """Kiểm tra user có trong whitelist không."""
    return user_id in ALLOWED_USERS
```

---

## 5. Bot Handlers

**bot/handlers.py:**

```python
from aiogram import Router, types
from aiogram.filters import Command
from bot.whitelist import is_allowed
from queue.redis_queue import enqueue_task

router = Router()

@router.message(Command("start"))
async def cmd_start(message: types.Message):
    if not is_allowed(message.from_user.id):
        await message.answer("⛔ Access denied.")
        return
    await message.answer("🤖 AI Coding Agent ready. Send a task to begin.")

@router.message()
async def handle_task(message: types.Message):
    if not is_allowed(message.from_user.id):
        await message.answer("⛔ Access denied.")
        return

    task_text = message.text
    session_id = f"session_{message.from_user.id}_{message.message_id}"

    await enqueue_task(session_id, task_text)
    await message.answer(f"📋 Task received!\nSession: `{session_id}`\nStatus: Queued")
```

---

## 6. Redis Queue

**queue/redis_queue.py:**

```python
import json
import redis.asyncio as redis
from config import REDIS_URL

redis_client = redis.from_url(REDIS_URL)
TASK_QUEUE = "task_queue"

async def enqueue_task(session_id: str, task: str):
    """Đẩy task vào Redis queue."""
    payload = json.dumps({"session_id": session_id, "task": task})
    await redis_client.rpush(TASK_QUEUE, payload)

async def dequeue_task():
    """Lấy task từ Redis queue."""
    result = await redis_client.lpop(TASK_QUEUE)
    if result:
        return json.loads(result)
    return None
```

---

## 7. API Routes

**api/routes.py:**

```python
from fastapi import APIRouter
from queue.redis_queue import redis_client

router = APIRouter(prefix="/api", tags=["health"])

@router.get("/health")
async def health_check():
    return {"status": "ok"}

@router.get("/queue/size")
async def queue_size():
    size = await redis_client.llen("task_queue")
    return {"queue_size": size}
```

---

## 8. Main Entry Point

**main.py:**

```python
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from aiogram import Bot, Dispatcher
from bot.handlers import router as bot_router
from api.routes import router as api_router
from config import TELEGRAM_BOT_TOKEN, GATEWAY_PORT
import uvicorn

bot = Bot(token=TELEGRAM_BOT_TOKEN)
dp = Dispatcher()
dp.include_router(bot_router)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: bắt đầu polling Telegram
    asyncio.create_task(dp.start_polling(bot))
    yield
    # Shutdown
    await bot.session.close()

app = FastAPI(title="AI Agent Gateway", lifespan=lifespan)
app.include_router(api_router)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=GATEWAY_PORT)
```

---

## 9. Dockerfile

**Dockerfile:**

```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["python", "main.py"]
```

---

## 10. Docker Compose (Gateway + Redis)

**docker-compose.yml:**

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
```

---

## 11. Build & Run

```bash
cd /opt/ai-agent
docker compose up --build -d
```

---

## 12. Kiểm tra

```bash
# Health check
curl http://localhost:8000/api/health

# Queue size
curl http://localhost:8000/api/queue/size

# Gửi tin nhắn Telegram cho bot → bot reply "Task received!"
```

---

## Kết quả Step 2

- [x] Gateway API chạy trên port 8000
- [x] Telegram bot nhận và phản hồi tin nhắn
- [x] Whitelist chặn user không hợp lệ
- [x] Task được đẩy vào Redis queue
- [x] Health check endpoint hoạt động

---

## Step tiếp theo

→ [Step 3: Run OpenHands from Docker](step-3-openhands.md)
