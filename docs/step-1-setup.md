# Step 1: Setup (Ubuntu, Docker, Telegram Bot)

## Mục tiêu

Chuẩn bị môi trường nền tảng để chạy toàn bộ hệ thống AI Coding Agent.

---

## 1. Cài đặt Ubuntu 24.04

Sử dụng VPS hoặc máy local chạy Ubuntu 24.04 LTS.

```bash
# Cập nhật hệ thống
sudo apt update && sudo apt upgrade -y

# Cài các tools cơ bản
sudo apt install -y curl wget git vim ufw
```

---

## 2. Cài đặt Docker & Docker Compose

```bash
# Cài Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Thêm user vào docker group (tránh chạy sudo)
sudo usermod -aG docker $USER

# Verify
docker --version
docker compose version
```

---

## 3. Tạo thư mục dự án

```bash
sudo mkdir -p /opt/ai-agent/{gateway,workers,workspaces,redis,secrets,logs}
sudo chown -R $USER:$USER /opt/ai-agent
```

Cấu trúc:

```text
/opt/ai-agent/
├── docker-compose.yml
├── gateway/
├── workers/
├── workspaces/
├── redis/
├── secrets/
└── logs/
```

---

## 4. Tạo Telegram Bot

### 4.1 Tạo bot với BotFather

1. Mở Telegram, tìm `@BotFather`
2. Gửi `/newbot`
3. Đặt tên và username cho bot
4. Lưu **Bot Token** (dạng `123456:ABC-DEF...`)

### 4.2 Lấy User ID

1. Mở `@userinfobot` trên Telegram
2. Gửi `/start`
3. Lưu **User ID** (dạng `123456789`)

### 4.3 Lưu secrets

```bash
# Lưu bot token
echo "TELEGRAM_BOT_TOKEN=your_bot_token_here" > /opt/ai-agent/secrets/telegram.env

# Lưu allowed user IDs
echo "ALLOWED_USERS=123456789" >> /opt/ai-agent/secrets/telegram.env
```

---

## 5. Cấu hình Firewall

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 8000/tcp  # Gateway API
sudo ufw enable
```

> **Lưu ý**: KHÔNG mở port cho OpenHands. Chỉ Gateway API được expose.

---

## 6. Kiểm tra

```bash
# Docker chạy được
docker run hello-world

# Thư mục tồn tại
ls -la /opt/ai-agent/

# Secrets đã lưu
cat /opt/ai-agent/secrets/telegram.env
```

---

## Kết quả Step 1

- [x] Ubuntu 24.04 sẵn sàng
- [x] Docker & Docker Compose cài đặt thành công
- [x] Thư mục `/opt/ai-agent/` đã tạo
- [x] Telegram Bot tạo xong, token đã lưu
- [x] User ID whitelist đã cấu hình

---

## Step tiếp theo

→ [Step 2: Build Minimal Gateway](step-2-gateway.md)
