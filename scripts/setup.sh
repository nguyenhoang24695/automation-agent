#!/bin/bash
# ============================================
# AI Coding Agent - Step 1: Full Setup Script
# ============================================
# This script can be executed by OpenHands or manually.
# It sets up the entire host environment for the AI Agent.
#
# Usage:
#   1. Fill in .env file with your Telegram credentials
#   2. Run: bash scripts/setup.sh
#
# Prerequisites:
#   - Ubuntu 24.04
#   - Root/sudo access
#   - .env file with TELEGRAM_BOT_TOKEN and ALLOWED_USERS
# ============================================

set -euo pipefail

# -------------------------------------------
# Config
# -------------------------------------------
PROJECT_DIR="/opt/ai-agent"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${PROJECT_ROOT}/.env"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }

# -------------------------------------------
# 1. Validate .env file
# -------------------------------------------
echo ""
echo "=============================="
echo "  Step 1: Environment Setup"
echo "=============================="
echo ""

if [ ! -f "$ENV_FILE" ]; then
    err ".env file not found at $ENV_FILE"
    echo "  → Copy .env.example to .env and fill in your values:"
    echo "    cp .env.example .env"
    exit 1
fi

source "$ENV_FILE"

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    err "TELEGRAM_BOT_TOKEN is empty in .env"
    echo "  → Get a token from @BotFather on Telegram"
    exit 1
fi

if [ -z "${ALLOWED_USERS:-}" ]; then
    err "ALLOWED_USERS is empty in .env"
    echo "  → Get your ID from @userinfobot on Telegram"
    exit 1
fi

log "Environment file validated"

# -------------------------------------------
# 2. System update & basic tools
# -------------------------------------------
echo ""
echo "--- Installing system packages ---"

sudo apt update -y
sudo apt upgrade -y
sudo apt install -y curl wget git vim ufw ca-certificates gnupg lsb-release

log "System packages installed"

# -------------------------------------------
# 3. Docker installation
# -------------------------------------------
echo ""
echo "--- Installing Docker ---"

if command -v docker &> /dev/null; then
    log "Docker already installed: $(docker --version)"
else
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sudo sh /tmp/get-docker.sh
    rm /tmp/get-docker.sh
    log "Docker installed: $(docker --version)"
fi

# Add current user to docker group
if ! groups | grep -q docker; then
    sudo usermod -aG docker "$USER"
    warn "Added $USER to docker group (logout/login to apply)"
fi

log "Docker Compose: $(docker compose version 2>/dev/null || echo 'bundled with Docker')"

# -------------------------------------------
# 4. Create project directory structure
# -------------------------------------------
echo ""
echo "--- Creating project directories ---"

sudo mkdir -p "${PROJECT_DIR}"/{gateway,workers,workspaces,redis,secrets,logs}
sudo chown -R "$USER:$USER" "${PROJECT_DIR}"

log "Project structure created at ${PROJECT_DIR}"

# -------------------------------------------
# 5. Write secrets from .env
# -------------------------------------------
echo ""
echo "--- Configuring secrets ---"

# Write telegram.env (used by docker-compose)
cat > "${PROJECT_DIR}/secrets/telegram.env" <<EOF
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
ALLOWED_USERS=${ALLOWED_USERS}
EOF

chmod 600 "${PROJECT_DIR}/secrets/telegram.env"

# Copy .env to project dir (for docker-compose)
cp "$ENV_FILE" "${PROJECT_DIR}/.env"
chmod 600 "${PROJECT_DIR}/.env"

log "Secrets configured at ${PROJECT_DIR}/secrets/"

# -------------------------------------------
# 6. Firewall
# -------------------------------------------
echo ""
echo "--- Configuring firewall ---"

sudo ufw allow 22/tcp    # SSH
sudo ufw allow 8000/tcp  # Gateway API
sudo ufw --force enable

log "Firewall configured (SSH + Gateway only)"

# -------------------------------------------
# 7. Verify
# -------------------------------------------
echo ""
echo "--- Verification ---"

echo ""
echo "Docker:"
docker --version
docker compose version

echo ""
echo "Project structure:"
ls -la "${PROJECT_DIR}/"

echo ""
echo "Secrets:"
echo "  telegram.env: $(test -f ${PROJECT_DIR}/secrets/telegram.env && echo '✓ exists' || echo '✗ missing')"
echo "  .env:         $(test -f ${PROJECT_DIR}/.env && echo '✓ exists' || echo '✗ missing')"

echo ""
echo "=============================="
echo "  ✅ Step 1 Complete!"
echo "=============================="
echo ""
echo "Next: Run 'docker compose up --build -d' from ${PROJECT_DIR}"
echo ""
