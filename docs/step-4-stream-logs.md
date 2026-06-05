# Step 4: Stream Logs to Telegram

## Mục tiêu

Đưa kết quả và logs từ OpenHands worker trở lại Telegram để user theo dõi real-time.

---

## Kiến trúc

```text
OpenHands Container
    ↓ (execute task)
Worker captures logs
    ↓ (format message)
Bot sends to Telegram
    ↓ (chunked messages)
User receives update
```

---

## 1. Log Collector

Tạo file **workers/log_collector.py:**

```python
import asyncio
from datetime import datetime


class LogCollector:
    """Thu thập và format logs từ container."""

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.logs: list[str] = []
        self.start_time = datetime.utcnow()

    def add(self, line: str):
        timestamp = datetime.utcnow().strftime("%H:%M:%S")
        entry = f"[{timestamp}] {line}"
        self.logs.append(entry)

    def get_summary(self, status: str) -> str:
        """Tạo summary message gửi về Telegram."""
        duration = (datetime.utcnow() - self.start_time).total_seconds()

        header = (
            f"{'✅' if status == 'done' else '❌'} **Task {status.upper()}**\n"
            f"Session: `{self.session_id}`\n"
            f"Duration: {duration:.1f}s\n"
            f"{'─' * 30}\n"
        )

        # Giới hạn 3000 ký tự (Telegram limit = 4096)
        log_text = "\n".join(self.logs[-50:])  # 50 dòng cuối
        if len(log_text) > 3000:
            log_text = "...(truncated)...\n" + log_text[-3000:]

        return header + f"```\n{log_text}\n```"
```

---

## 2. Telegram Notifier

Tạo file **workers/notifier.py:**

```python
import httpx
from config import TELEGRAM_BOT_TOKEN

BOT_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"
MAX_MSG_LENGTH = 4000


async def send_message(chat_id: int, text: str):
    """Gửi tin nhắn Telegram, tự động chia nhỏ nếu quá dài."""
    chunks = [text[i:i + MAX_MSG_LENGTH] for i in range(0, len(text), MAX_MSG_LENGTH)]

    async with httpx.AsyncClient() as client:
        for chunk in chunks:
            await client.post(
                f"{BOT_API}/sendMessage",
                json={
                    "chat_id": chat_id,
                    "text": chunk,
                    "parse_mode": "Markdown",
                },
                timeout=10,
            )


async def send_status(chat_id: int, session_id: str, status: str):
    """Gửi status update ngắn."""
    icons = {"queued": "📋", "running": "🔄", "done": "✅", "error": "❌"}
    icon = icons.get(status, "❓")
    msg = f"{icon} Session `{session_id}`: {status}"

    async with httpx.AsyncClient() as client:
        await client.post(
            f"{BOT_API}/sendMessage",
            json={
                "chat_id": chat_id,
                "text": msg,
                "parse_mode": "Markdown",
            },
            timeout=10,
        )
```

---

## 3. Cập nhật Worker Config

Thêm vào **workers/config.py:**

```python
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
```

---

## 4. Cập nhật Worker

Sửa **workers/worker.py** — tích hợp log collector và notifier:

```python
import asyncio
import json
import docker
import redis.asyncio as aioredis
from config import REDIS_URL
from log_collector import LogCollector
from notifier import send_message, send_status

redis_client = aioredis.from_url(REDIS_URL)
docker_client = docker.from_env()

TASK_QUEUE = "task_queue"
OPENHANDS_IMAGE = "docker.all-hands.dev/all-hands-ai/openhands:latest"
WORKSPACE_BASE = "/opt/ai-agent/workspaces"


async def run_worker():
    """Vòng lặp chính: lấy task và thực thi."""
    print("🔄 Worker started, waiting for tasks...")

    while True:
        result = await redis_client.blpop(TASK_QUEUE, timeout=5)
        if not result:
            continue

        _, raw = result
        task_data = json.loads(raw)
        session_id = task_data["session_id"]
        task_text = task_data["task"]
        chat_id = task_data["chat_id"]  # ← thêm từ gateway

        await execute_task(session_id, task_text, chat_id)


async def execute_task(session_id: str, task: str, chat_id: int):
    """Thực thi task và stream logs về Telegram."""
    import os
    workspace_path = f"{WORKSPACE_BASE}/{session_id}"
    os.makedirs(workspace_path, exist_ok=True)

    collector = LogCollector(session_id)

    # Notify: started
    await send_status(chat_id, session_id, "running")
    collector.add(f"Task: {task}")

    try:
        container = docker_client.containers.run(
            image=OPENHANDS_IMAGE,
            name=f"openhands-{session_id}",
            detach=True,
            environment={"SANDBOX_RUNTIME_CONTAINER_IMAGE": OPENHANDS_IMAGE},
            volumes={workspace_path: {"bind": "/workspace", "mode": "rw"}},
            network_mode="bridge",
            mem_limit="2g",
            cpu_quota=100000,
        )

        collector.add(f"Container: {container.short_id}")

        # Stream logs real-time
        for line in container.logs(stream=True, follow=True):
            decoded = line.decode("utf-8", errors="replace").strip()
            if decoded:
                collector.add(decoded)

        # Wait for completion
        result = container.wait(timeout=600)
        status = "done" if result.get("StatusCode") == 0 else "error"

    except Exception as e:
        collector.add(f"Error: {e}")
        status = "error"

    # Notify: completed with logs
    summary = collector.get_summary(status)
    await send_message(chat_id, summary)
    print(f"{'✅' if status == 'done' else '❌'} Task {session_id}: {status}")


if __name__ == "__main__":
    asyncio.run(run_worker())
```

---

## 5. Cập nhật Gateway (Node.js) — Truyền chat_id

Sửa **gateway/src/bot/telegram.js** — thêm `chat_id` vào task payload:

```javascript
// Handle all messages
bot.on('text', async (ctx) => {
  if (!isAllowed(ctx.from.id)) {
    return ctx.reply('⛔ Access denied.');
  }

  const taskText = ctx.message.text;
  const sessionId = `session_${ctx.from.id}_${ctx.message.message_id}`;

  await enqueueTask(sessionId, taskText, ctx.chat.id); // ← chat_id truyền cho worker
  await ctx.reply(`📋 Task queued!\nSession: \`${sessionId}\``, {
    parse_mode: 'Markdown',
  });
});
```

Sửa **gateway/src/queue/redis.js** — đảm bảo `enqueueTask` nhận `chatId`:

```javascript
export async function enqueueTask(sessionId, task, chatId) {
  const payload = JSON.stringify({
    session_id: sessionId,
    task,
    chat_id: chatId, // ← truyền chat_id cho worker
  });
  await redis.rpush(TASK_QUEUE, payload);
}
```

> **Lưu ý**: Gateway (Node.js) và Worker (Python) giao tiếp qua Redis queue bằng JSON.
> Worker đọc `chat_id` từ payload để biết gửi log về đúng Telegram user.

---

## 6. Log File Storage

Lưu logs vào file để debug:

```python
# Thêm vào workers/config.py
import os
LOG_DIR = os.getenv("LOG_DIR", "/opt/ai-agent/logs")
```

Worker tự động ghi log file:

```python
# Trong execute_task(), sau khi hoàn thành:
log_file = f"{LOG_DIR}/{session_id}.log"
with open(log_file, "w") as f:
    f.write("\n".join(collector.logs))
```

---

## 7. Build & Run

```bash
cd /opt/ai-agent
docker compose up --build -d
```

---

## 8. Kiểm tra

```text
1. Gửi tin nhắn Telegram: "Create hello world HTML page"
2. Bot reply: 📋 Task queued!
3. Vài giây sau: 🔄 Session session_xxx: running
4. Khi hoàn thành: ✅ Task DONE + logs (50 dòng cuối)
```

---

## Kết quả Step 4

- [x] Logs stream real-time từ container
- [x] Summary message gửi về Telegram
- [x] Tin nhắn tự động chia nhỏ nếu quá dài
- [x] Log files lưu tại `/opt/ai-agent/logs/`
- [x] chat_id truyền từ gateway → worker

---

## Step tiếp theo

→ [Step 5: Add Git Support](step-5-git-support.md)
