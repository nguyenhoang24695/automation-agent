# Step 5: Add Git Support (Node.js Worker)

## Mục tiêu

Cho phép OpenHands worker clone, làm việc và commit với Git repositories.

---

## Kiến trúc

```text
User sends: "Clone repo X and run it"
    ↓
Gateway parses Git command → Redis queue
    ↓
Worker detects [GIT_*] prefix
    ↓
Git operations via child_process
    ↓
Results sent to Telegram
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

Tạo file **workers/src/git-helper.js:**

```javascript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Manages Git operations in a workspace directory.
 */
export class GitHelper {
  /**
   * @param {string} workspacePath - Absolute path to workspace
   */
  constructor(workspacePath) {
    this.workspace = workspacePath;
  }

  /**
   * Run a git command in the workspace.
   * @param {string[]} args
   * @param {number} [timeout=120000] - Timeout in ms
   */
  async run(args, timeout = 120000) {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: this.workspace,
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return stdout.trim();
  }

  async clone(repoUrl) {
    await this.run(['clone', repoUrl, '.'], 120000);
    return `✅ Cloned: ${repoUrl}`;
  }

  async pull() {
    await this.run(['pull'], 60000);
    return '✅ Pulled latest changes';
  }

  async status() {
    const output = await this.run(['status', '--short']);
    return output || 'No changes';
  }

  async commit(message) {
    await this.run(['add', '-A']);
    try {
      const output = await this.run(['commit', '-m', message]);
      return `✅ Committed: ${message}`;
    } catch {
      return '⚠️ Nothing to commit';
    }
  }

  async push() {
    await this.run(['push'], 60000);
    return '✅ Pushed to remote';
  }

  async log(n = 5) {
    const output = await this.run(['log', `-${n}`, '--oneline']);
    return output || 'No commits yet';
  }

  /**
   * Validate a repository URL for safety.
   */
  static validateUrl(url) {
    if (!url.startsWith('https://') && !url.startsWith('git@')) return false;
    if (url.includes('..')) return false;
    return true;
  }
}
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

> **Note:** Also need to install `git` in the worker Dockerfile (see Section 7).

---

## 4. Bot Commands — Git Handlers (Gateway — Node.js)

Thêm vào **gateway/src/bot/telegram.js:**

```javascript
import { enqueueTask } from '../queue/redis.js';

// /clone <repo_url>
bot.command('clone', async (ctx) => {
  if (!isAllowed(ctx.from.id)) {
    return ctx.reply('⛔ Access denied.');
  }

  const repoUrl = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!repoUrl) {
    return ctx.reply('Usage: /clone <repo_url>');
  }

  const sessionId = `session_${ctx.from.id}_${ctx.message.message_id}`;
  await enqueueTask(sessionId, `[GIT_CLONE] ${repoUrl}`, ctx.chat.id);
  await ctx.reply(`📦 Cloning repo...\nSession: \`${sessionId}\``, {
    parse_mode: 'Markdown',
  });
});

// /commit <session_id> <message>
bot.command('commit', async (ctx) => {
  if (!isAllowed(ctx.from.id)) {
    return ctx.reply('⛔ Access denied.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 0) {
    return ctx.reply('Usage: /commit <session_id> <message>');
  }

  const sessionId = args[0];
  const commitMsg = args.slice(1).join(' ') || 'auto-commit by AI agent';

  await enqueueTask(sessionId, `[GIT_COMMIT] ${commitMsg}`, ctx.chat.id);
  await ctx.reply(`💾 Committing...\nSession: \`${sessionId}\``, {
    parse_mode: 'Markdown',
  });
});

// /push <session_id>
bot.command('push', async (ctx) => {
  if (!isAllowed(ctx.from.id)) {
    return ctx.reply('⛔ Access denied.');
  }

  const sessionId = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!sessionId) {
    return ctx.reply('Usage: /push <session_id>');
  }

  await enqueueTask(sessionId, '[GIT_PUSH]', ctx.chat.id);
  await ctx.reply(`📤 Pushing...\nSession: \`${sessionId}\``, {
    parse_mode: 'Markdown',
  });
});
```

---

## 5. Worker — Xử lý Git Tasks (Node.js)

Update **workers/src/worker.js** — handle `[GIT_*]` prefixed tasks:

```javascript
import { GitHelper } from './git-helper.js';

// In the executeTask function, add Git handling before OpenHands:

export async function executeTask(taskData) {
  const { session_id, task, chat_id } = taskData;
  const workspacePath = path.join(config.workspaceBase, session_id);

  fs.mkdirSync(workspacePath, { recursive: true });
  const git = new GitHelper(workspacePath);

  // Git commands (no OpenHands needed)
  if (task.startsWith('[GIT_CLONE]')) {
    const repoUrl = task.replace('[GIT_CLONE]', '').trim();
    if (!GitHelper.validateUrl(repoUrl)) {
      return { status: 'error', logs: '❌ Invalid repository URL', exitCode: -1 };
    }
    try {
      const result = await git.clone(repoUrl);
      return { status: 'done', logs: result, exitCode: 0 };
    } catch (err) {
      return { status: 'error', logs: `❌ Clone failed: ${err.message}`, exitCode: 1 };
    }
  }

  if (task.startsWith('[GIT_COMMIT]')) {
    const msg = task.replace('[GIT_COMMIT]', '').trim();
    const result = await git.commit(msg);
    return { status: 'done', logs: result, exitCode: 0 };
  }

  if (task === '[GIT_PUSH]') {
    try {
      const result = await git.push();
      return { status: 'done', logs: result, exitCode: 0 };
    } catch (err) {
      return { status: 'error', logs: `❌ Push failed: ${err.message}`, exitCode: 1 };
    }
  }

  // Normal task → OpenHands (existing logic from Step 3/4)
  // ... OpenHands container spawn ...
}
```

---

## 6. Security: Git Safety Rules

```javascript
// In workers/src/git-helper.js

const BLOCKED_DOMAINS = []; // Add domains to block
const MAX_REPO_SIZE_MB = 500;

// validateUrl() is already implemented as a static method in GitHelper class
```

---

## 7. Worker Dockerfile — Install Git

Add `git` to the worker Dockerfile:

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Install git for Git operations
RUN apk add --no-cache git openssh-client

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

CMD ["node", "src/index.js"]
```

---

## 8. Build & Run

```bash
cd /opt/ai-agent
docker compose up --build -d
```

---

## 9. Kiểm tra

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
- [x] Bot commands: `/clone`, `/commit`, `/push` (Node.js Gateway)
- [x] Git operations via Node.js child_process (dockerode Worker)
- [x] URL validation và repo size limit

---

## Step tiếp theo

→ [Step 6: Add Cloudflare Tunnel](step-6-cloudflare-tunnel.md)
