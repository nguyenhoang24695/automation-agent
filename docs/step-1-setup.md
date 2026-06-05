# Step 1: Setup (Ubuntu, Docker, Telegram Bot)

## Mục tiêu

Chuẩn bị môi trường nền tảng — tự động hóa hoàn toàn bởi OpenHands qua script `setup.sh`.

---

## Kiến trúc

```text
User fills .env
    ↓
OpenHands runs setup.sh
    ↓
├── Validate credentials
├── Install system packages (curl, git, ufw...)
├── Install Docker
├── Create /opt/ai-agent/ structure
├── Write secrets (telegram.env)
└── Configure firewall
    ↓
Host ready — all runtimes handled by Docker
```

### Host vs Docker: Ranh giới rõ ràng

```
┌─────────────────────────┐     ┌──────────────────────────────────┐
│     HOST (Ubuntu)       │     │        DOCKER CONTAINERS          │
│                         │     │                                  │
│  ✅ Docker              │     │  Gateway (node:20-alpine)        │
│  ✅ Docker Compose      │     │    → Node.js 20 + Express        │
│  ✅ Git                 │     │    → Telegraf + ioredis          │
│  ✅ curl / wget / ufw   │     │                                  │
│                         │     │  Worker (python:3.11-slim)       │
│  ❌ Node.js (KHÔNG)     │     │    → Python 3.11 + Docker SDK   │
│  ❌ Python  (KHÔNG)     │     │    → Redis client                │
│  ❌ pip/npm (KHÔNG)     │     │                                  │
│                         │     │  Redis (redis:7-alpine)          │
└─────────────────────────┘     └──────────────────────────────────┘
```

> **Nguyên tắc**: Host chỉ cần Docker. Tất cả runtimes (Node.js, Python) chạy bên trong container.
> Không cần `apt install nodejs` hay `apt install python3` trên host.

---

## Quy trình

### Phase A: User chuẩn bị (manual — 5 phút)

User chỉ cần làm 2 việc:

#### 1. Tạo Telegram Bot

1. Mở Telegram → tìm `@BotFather`
2. Gửi `/newbot` → đặt tên bot
3. Copy **Bot Token** (dạng `123456:ABC-DEF...`)

#### 2. Lấy User ID

1. Mở `@userinfobot` trên Telegram
2. Gửi `/start` → copy **User ID**

#### 3. Điền vào file `.env`

Copy `.env.example` thành `.env` và điền thông tin:

```bash
cp .env.example .env
```

Sửa `.env`:

```env
# REQUIRED - điền giá trị thực
TELEGRAM_BOT_TOKEN=123456:ABC-DEF_your_token_here
ALLOWED_USERS=123456789

# Defaults - giữ nguyên
REDIS_URL=redis://redis:6379/0
GATEWAY_PORT=8000
WORKSPACE_BASE=/opt/ai-agent/workspaces
TUNNEL_ENABLED=true
DEFAULT_APP_PORT=3000
```

> ⚠️ File `.env` đã được thêm vào `.gitignore` — **KHÔNG** commit secrets lên Git.

---

### Phase B: OpenHands tự động (fully automated)

OpenHands thực thi script để hoàn thành toàn bộ setup:

```bash
bash scripts/setup.sh
```

Script sẽ tự động:

| Step | Action |
|------|--------|
| 1 | Validate `.env` — kiểm tra token và user ID tồn tại |
| 2 | `apt update && apt upgrade` + cài tools (curl, git, vim, ufw) |
| 3 | Cài Docker (skip nếu đã có) + add user vào docker group |
| 4 | Tạo `/opt/ai-agent/{gateway,workers,workspaces,redis,secrets,logs}` |
| 5 | Ghi secrets từ `.env` → `/opt/ai-agent/secrets/telegram.env` |
| 6 | Cấu hình UFW firewall (chỉ mở SSH + port 8000) |
| 7 | Verify toàn bộ và in kết quả |

> **Lưu ý**: Script **KHÔNG** cài Node.js hay Python trên host.
> Các runtimes này được đóng gói sẵn trong Docker image ở Step 2 và Step 3.

---

## Chi tiết script: `scripts/setup.sh`

### Validation

```bash
# Kiểm tra .env tồn tại
# Kiểm tra TELEGRAM_BOT_TOKEN không rỗng
# Kiểm tra ALLOWED_USERS không rỗng
# Exit nếu thiếu → user phải điền trước
```

### System packages

```bash
sudo apt update -y && sudo apt upgrade -y
sudo apt install -y curl wget git vim ufw ca-certificates gnupg lsb-release
```

### Docker

```bash
# Nếu chưa có Docker → cài tự động
curl -fsSL https://get.docker.com | sudo sh

# Add user vào docker group
sudo usermod -aG docker $USER
```

### Project structure

```bash
sudo mkdir -p /opt/ai-agent/{gateway,workers,workspaces,redis,secrets,logs}
sudo chown -R $USER:$USER /opt/ai-agent
```

### Secrets

```bash
# Ghi telegram.env từ .env
cat > /opt/ai-agent/secrets/telegram.env <<EOF
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
ALLOWED_USERS=${ALLOWED_USERS}
EOF
chmod 600 /opt/ai-agent/secrets/telegram.env
```

### Firewall

```bash
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 8000/tcp   # Gateway API only
sudo ufw --force enable
```

---

## File cấu trúc sau Step 1

```text
/opt/ai-agent/
├── .env                    ← copy từ project
├── docker-compose.yml      ← tạo ở Step 2
├── gateway/                ← tạo ở Step 2
├── workers/                ← tạo ở Step 3
├── workspaces/             ← empty (mỗi task tạo subdir)
├── redis/
│   └── data/               ← Redis persistent data
├── secrets/
│   ├── telegram.env        ← auto-generated từ .env
│   └── .env                ← copy từ project
└── logs/                   ← worker logs
```

Project repo:

```text
automation-agent/
├── .env.example            ← template (committed)
├── .env                    ← your secrets (gitignored)
├── .gitignore
├── readme.md
├── scripts/
│   └── setup.sh            ← Step 1 automation script
└── docs/
    ├── step-1-setup.md
    ├── step-2-gateway.md
    └── ...
```

---

## Security Rules

```text
✅ DO:
- Lưu secrets trong .env (gitignored)
- chmod 600 cho tất cả secret files
- Chỉ mở port 22 (SSH) và 8000 (Gateway)
- Validate credentials trước khi setup

❌ DON'T:
- KHÔNG commit .env lên Git
- KHÔNG mount /, /home, /root, /var/run/docker.sock
- KHÔNG expose OpenHands port ra public
- KHÔNG chạy agent as root
```

---

## Troubleshooting

| Vấn đề | Nguyên nhân | Cách xử lý |
|---------|-------------|------------|
| `.env file not found` | Chưa tạo .env | `cp .env.example .env` |
| `TELEGRAM_BOT_TOKEN is empty` | Chưa điền token | Lấy token từ @BotFather |
| `ALLOWED_USERS is empty` | Chưa điền user ID | Lấy ID từ @userinfobot |
| Docker permission denied | User chưa trong docker group | Logout và login lại |
| UFW blocks SSH | Firewall rule sai | `sudo ufw allow 22/tcp` |

---

## Kiểm tra

```bash
# Chạy setup
bash scripts/setup.sh

# Verify Docker
docker run hello-world

# Verify structure
ls -la /opt/ai-agent/

# Verify secrets
cat /opt/ai-agent/secrets/telegram.env
```

---

## Kết quả Step 1

- [x] `.env` file tạo từ template, điền Telegram credentials
- [x] `scripts/setup.sh` — OpenHands chạy tự động
- [x] Ubuntu packages + Docker cài đặt
- [x] `/opt/ai-agent/` structure tạo xong
- [x] Secrets ghi vào `/opt/ai-agent/secrets/telegram.env`
- [x] Firewall cấu hình (SSH + Gateway only)
- [x] Tất cả secrets chmod 600
- [x] Host **KHÔNG** cài Node.js/Python — tất cả chạy trong Docker

---

## Step tiếp theo

→ [Step 2: Build Minimal Gateway](step-2-gateway.md)
