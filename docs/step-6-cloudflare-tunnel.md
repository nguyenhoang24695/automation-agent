# Step 6: Add Cloudflare Tunnel

## Mục tiêu

Expose local web apps (Next.js, React, etc.) ra internet qua Cloudflare Tunnel — không cần mở port VPS.

---

## Kiến trúc

```text
Web App (localhost:3000)
    ↓
cloudflared tunnel
    ↓
*.trycloudflare.com (public URL)
    ↓
Bot sends URL to Telegram
```

---

## 1. Cài đặt cloudflared

### Trên host Ubuntu:

```bash
# Cài cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
sudo mv cloudflared /usr/local/bin/
sudo chmod +x /usr/local/bin/cloudflared

# Verify
cloudflared --version
```

---

## 2. Tunnel Helper

Tạo file **workers/tunnel_helper.py:**

```python
import subprocess
import re
import asyncio


class TunnelHelper:
    """Quản lý Cloudflare Tunnel để expose local ports."""

    def __init__(self):
        self.processes: dict[str, subprocess.Popen] = {}

    async def start_tunnel(self, session_id: str, local_port: int) -> str | None:
        """Khởi tạo tunnel cho port, trả về public URL."""
        try:
            process = subprocess.Popen(
                [
                    "cloudflared", "tunnel",
                    "--url", f"http://localhost:{local_port}",
                    "--no-autoupdate",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            self.processes[session_id] = process

            # Đọc stderr để lấy URL (cloudflared ghi URL vào stderr)
            url = await self._extract_url(process)
            return url

        except Exception as e:
            print(f"❌ Tunnel error: {e}")
            return None

    async def _extract_url(self, process: subprocess.Popen, timeout: int = 30) -> str | None:
        """Đọc URL từ cloudflared output."""
        url_pattern = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

        for _ in range(timeout):
            line = process.stderr.readline()
            if not line:
                await asyncio.sleep(1)
                continue
            match = url_pattern.search(line)
            if match:
                return match.group(0)

        return None

    def stop_tunnel(self, session_id: str):
        """Dừng tunnel."""
        process = self.processes.pop(session_id, None)
        if process:
            process.terminate()
            process.wait(timeout=5)
            print(f"🛑 Tunnel stopped: {session_id}")

    def stop_all(self):
        """Dừng tất cả tunnels."""
        for sid in list(self.processes.keys()):
            self.stop_tunnel(sid)
```

---

## 3. Tích hợp vào Worker

Thêm vào **workers/worker.py** — auto-detect port và tạo tunnel:

```python
from tunnel_helper import TunnelHelper

tunnel_helper = TunnelHelper()

# Thêm vào config.py
TUNNEL_ENABLED = os.getenv("TUNNEL_ENABLED", "true").lower() == "true"
DEFAULT_APP_PORT = int(os.getenv("DEFAULT_APP_PORT", "3000"))


async def execute_task(session_id: str, task: str, chat_id: int):

    try:
        # Sau khi OpenHands chạy xong, kiểm tra xem có web app không
        if status == "done" and TUNNEL_ENABLED:
            port = await detect_web_app_port(workspace_path, DEFAULT_APP_PORT)
            if port:
                await send_status(chat_id, session_id, "🌐 Starting tunnel...")

                url = await tunnel_helper.start_tunnel(session_id, port)
                if url:
                    collector.add(f"🌐 Preview URL: {url}")
                    await send_message(chat_id, f"🌐 **Preview URL**: {url}")

                    # Auto-stop sau 30 phút
                    asyncio.create_task(auto_stop_tunnel(session_id, 1800))

    except Exception as e:
        collector.add(f"Tunnel error: {e}")


async def detect_web_app_port(workspace_path: str, default_port: int) -> int | None:
    """Kiểm tra workspace có web app đang chạy không."""
    import subprocess

    # Kiểm tra package.json → có thể là Node.js app
    import os
    pkg_json = os.path.join(workspace_path, "package.json")
    if os.path.exists(pkg_json):
        return default_port

    # Kiểm tra các port phổ biến
    for port in [3000, 8080, 5173, 4200]:
        try:
            result = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                 f"http://localhost:{port}"],
                capture_output=True, text=True, timeout=3,
            )
            if result.stdout.startswith(("2", "3")):
                return port
        except Exception:
            continue

    return None


async def auto_stop_tunnel(session_id: str, delay: int):
    """Tự động dừng tunnel sau N giây."""
    await asyncio.sleep(delay)
    tunnel_helper.stop_tunnel(session_id)
```

---

## 4. Bot Command — Tunnel Control (Node.js)

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

> **Lưu ý**: Gateway (Node.js) nhận command và đẩy task vào Redis.
> Worker (Python) xử lý tunnel lifecycle qua `tunnel_helper.py`.

---

## 5. Worker — Xử lý Tunnel Commands

Thêm vào **workers/worker.py:**

```python
# Trong execute_task(), thêm xử lý tunnel commands:

elif task.startswith("[TUNNEL_START]"):
    port_str = task.split("port=")[-1].strip()
    port = int(port_str)
    url = await tunnel_helper.start_tunnel(session_id, port)
    if url:
        collector.add(f"🌐 Tunnel URL: {url}")
        status = "done"
    else:
        collector.add("❌ Failed to start tunnel")
        status = "error"

elif task == "[TUNNEL_STOP]":
    tunnel_helper.stop_tunnel(session_id)
    collector.add("🛑 Tunnel stopped")
    status = "done"
```

---

## 6. Docker: Cài cloudflared trong Worker

Thêm vào **workers/Dockerfile:**

```dockerfile
# Install cloudflared
RUN curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared
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

- [x] cloudflared cài đặt trong worker container
- [x] Auto-detect web app port
- [x] Quick tunnel tạo URL public
- [x] URL gửi về Telegram tự động
- [x] Auto-stop sau 30 phút
- [x] Bot commands: `/tunnel start`, `/tunnel stop`

---

## Hoàn thành Phase 1 MVP!

```text
✅ Telegram commands
✅ Single user (whitelist)
✅ OpenHands worker
✅ Coding task execution
✅ Logs streamed to Telegram
✅ Docker sandbox isolation
✅ Git support
✅ Cloudflare Tunnel preview URLs
```

---

## Next: Phase 2

→ Zalo integration, Session persistence, Multi-user, GitHub PR automation
