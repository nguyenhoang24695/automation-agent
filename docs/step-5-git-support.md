# Step 5: Add Git Support

## Mục tiêu

Cho phép OpenHands worker clone, làm việc và commit với Git repositories.

---

## Kiến trúc

```text
User sends: "Clone repo X and run it"
    ↓
Gateway parses Git command
    ↓
Worker clones repo vào workspace
    ↓
OpenHands works on code
    ↓
Auto-commit & push (optional)
```

---

## 1. Git Commands hỗ trợ

| Command | Mô tả |
|---------|--------|
| `/clone <repo_url>` | Clone repo vào workspace |
| `/pull <session_id>` | Pull latest changes |
| `/commit <session_id> <message>` | Commit changes |
| `/push <session_id>` | Push lên remote |

---

## 2. Git Helper

Tạo file **workers/git_helper.py:**

```python
import subprocess
import os
from pathlib import Path


class GitHelper:
    """Quản lý Git operations trong workspace."""

    def __init__(self, workspace_path: str):
        self.workspace = Path(workspace_path)

    def clone(self, repo_url: str) -> str:
        """Clone repo vào workspace."""
        result = subprocess.run(
            ["git", "clone", repo_url, "."],
            cwd=self.workspace,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Clone failed: {result.stderr}")
        return f"✅ Cloned: {repo_url}"

    def pull(self) -> str:
        """Pull latest changes."""
        result = subprocess.run(
            ["git", "pull"],
            cwd=self.workspace,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Pull failed: {result.stderr}")
        return f"✅ Pulled latest changes"

    def status(self) -> str:
        """Hiển thị git status."""
        result = subprocess.run(
            ["git", "status", "--short"],
            cwd=self.workspace,
            capture_output=True,
            text=True,
        )
        return result.stdout or "No changes"

    def commit(self, message: str) -> str:
        """Commit all changes."""
        subprocess.run(["git", "add", "-A"], cwd=self.workspace, check=True)
        result = subprocess.run(
            ["git", "commit", "-m", message],
            cwd=self.workspace,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return "⚠️ Nothing to commit"
        return f"✅ Committed: {message}"

    def push(self) -> str:
        """Push lên remote."""
        result = subprocess.run(
            ["git", "push"],
            cwd=self.workspace,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Push failed: {result.stderr}")
        return "✅ Pushed to remote"

    def log(self, n: int = 5) -> str:
        """Hiển thị n commits gần nhất."""
        result = subprocess.run(
            ["git", "log", f"-{n}", "--oneline"],
            cwd=self.workspace,
            capture_output=True,
            text=True,
        )
        return result.stdout or "No commits yet"
```

---

## 3. Git SSH Key (Private Repos)

### 3.1 Tạo SSH key

```bash
# Trên host
ssh-keygen -t ed25519 -C "ai-agent" -f /opt/ai-agent/secrets/git_ssh_key -N ""
```

### 3.2 Thêm public key vào GitHub/GitLab

```bash
cat /opt/ai-agent/secrets/git_ssh_key.pub
# Copy và thêm vào GitHub → Settings → SSH Keys
```

### 3.3 Mount SSH key vào Worker

Cập nhật **docker-compose.yml** — thêm volume cho worker:

```yaml
  worker:
    build: ./workers
    # ... existing config ...
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./workspaces:/workspaces
      - ./logs:/app/logs
      - ./secrets/git_ssh_key:/root/.ssh/id_ed25519:ro  # ← Git SSH key
```

---

## 4. Bot Commands — Git Handlers

Thêm vào **gateway/bot/handlers.py:**

```python
from aiogram.filters import Command, CommandObject
from queue.redis_queue import enqueue_task

@router.message(Command("clone"))
async def cmd_clone(message: types.Message, command: CommandObject):
    if not is_allowed(message.from_user.id):
        await message.answer("⛔ Access denied.")
        return

    if not command.args:
        await message.answer("Usage: /clone <repo_url>")
        return

    repo_url = command.args.strip()
    session_id = f"session_{message.from_user.id}_{message.message_id}"

    await enqueue_task(
        session_id=session_id,
        task=f"[GIT_CLONE] {repo_url}",
        chat_id=message.chat.id,
    )
    await message.answer(f"📦 Cloning repo...\nSession: `{session_id}`")


@router.message(Command("commit"))
async def cmd_commit(message: types.Message, command: CommandObject):
    if not is_allowed(message.from_user.id):
        await message.answer("⛔ Access denied.")
        return

    if not command.args:
        await message.answer("Usage: /commit <session_id> <message>")
        return

    parts = command.args.split(maxsplit=1)
    session_id = parts[0]
    commit_msg = parts[1] if len(parts) > 1 else "auto-commit by AI agent"

    await enqueue_task(
        session_id=session_id,
        task=f"[GIT_COMMIT] {commit_msg}",
        chat_id=message.chat.id,
    )
    await message.answer(f"💾 Committing...\nSession: `{session_id}`")


@router.message(Command("push"))
async def cmd_push(message: types.Message, command: CommandObject):
    if not is_allowed(message.from_user.id):
        await message.answer("⛔ Access denied.")
        return

    if not command.args:
        await message.answer("Usage: /push <session_id>")
        return

    session_id = command.args.strip()
    await enqueue_task(
        session_id=session_id,
        task="[GIT_PUSH]",
        chat_id=message.chat.id,
    )
    await message.answer(f"📤 Pushing...\nSession: `{session_id}`")
```

---

## 5. Worker — Xử lý Git Tasks

Thêm vào **workers/worker.py** — xử lý prefix `[GIT_*]`:

```python
from git_helper import GitHelper

async def execute_task(session_id: str, task: str, chat_id: int):
    """Thực thi task, hỗ trợ cả Git commands."""
    import os
    workspace_path = f"{WORKSPACE_BASE}/{session_id}"
    os.makedirs(workspace_path, exist_ok=True)

    collector = LogCollector(session_id)
    git = GitHelper(workspace_path)

    await send_status(chat_id, session_id, "running")

    try:
        # Git commands
        if task.startswith("[GIT_CLONE]"):
            repo_url = task.replace("[GIT_CLONE]", "").strip()
            result = git.clone(repo_url)
            collector.add(result)
            status = "done"

        elif task.startswith("[GIT_COMMIT]"):
            msg = task.replace("[GIT_COMMIT]", "").strip()
            result = git.commit(msg)
            collector.add(result)
            status = "done"

        elif task == "[GIT_PUSH]":
            result = git.push()
            collector.add(result)
            status = "done"

        # Normal task → OpenHands
        else:
            collector.add(f"Task: {task}")
            # ... existing OpenHands container logic ...
            status = "done"

    except Exception as e:
        collector.add(f"Error: {e}")
        status = "error"

    summary = collector.get_summary(status)
    await send_message(chat_id, summary)
```

---

## 6. Security: Git Safety Rules

```python
# Thêm vào workers/git_helper.py

BLOCKED_DOMAINS = []  # Có thể thêm domain bị chặn
MAX_REPO_SIZE_MB = 500  # Giới hạn repo size

def validate_repo_url(url: str) -> bool:
    """Kiểm tra URL hợp lệ."""
    if not url.startswith(("https://", "git@")):
        return False
    if ".." in url:
        return False
    return True
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
1. /clone https://github.com/user/repo → Bot: 📦 Cloning...
2. Gửi task bình thường → OpenHands làm việc trên code đã clone
3. /commit session_xxx "fix: update styles" → Bot: 💾 Committing...
4. /push session_xxx → Bot: 📤 Pushing...
```

---

## Kết quả Step 5

- [x] Clone repo từ GitHub/GitLab
- [x] Commit và push changes
- [x] SSH key cho private repos
- [x] Bot commands: `/clone`, `/commit`, `/push`
- [x] URL validation và repo size limit

---

## Step tiếp theo

→ [Step 6: Add Cloudflare Tunnel](step-6-cloudflare-tunnel.md)
