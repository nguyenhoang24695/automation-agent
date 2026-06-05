# AI Coding Agent MVP

## Goal

Build a self-hosted AI coding agent system that can:

* Receive commands from Telegram
* Execute coding tasks autonomously
* Work with Git repositories
* Install dependencies
* Run local web applications
* Expose preview URLs through tunnel
* Run safely inside Docker sandbox
* Use multiple LLM providers through 9Router

---

# High Level Architecture

```text
Telegram
   ↓
Gateway API
   ↓
Task Queue
   ↓
OpenHands Worker
   ↓
Docker Workspace
   ↓
9Router
   ↓
Claude / Gemini / Qwen
```

---

# Core Components

| Component         | Purpose              |
| ----------------- | -------------------- |
| Telegram Bot      | Chat interface       |
| Gateway API       | Orchestration layer  |
| Redis             | Task queue           |
| OpenHands         | AI coding agent      |
| Docker            | Sandbox isolation    |
| 9Router           | LLM routing/fallback |
| Cloudflare Tunnel | Public preview URLs  |

---

# MVP Scope

## Phase 1

Must support:

* Telegram commands
* Single user only
* Spawn OpenHands worker
* Execute coding task
* Return logs to Telegram
* Run inside Docker

No need yet:

* Zalo
* Multi-user
* Database memory
* Kubernetes
* Production deployment
* OAuth
* Multi-agent workflows

---

# Recommended Stack

## Gateway API

* Node.js 20
* Express
* Telegraf (Telegram bot)
* ioredis

## Worker

* Node.js 20
* dockerode (Docker API)
* ioredis
* Cloudflared

## AI

* OpenHands
* 9Router
* Claude Sonnet
* Gemini fallback

## Infrastructure

* Ubuntu 24.04
* Docker
* Docker Compose
* Cloudflare Tunnel

---

# Folder Structure

```text
/opt/ai-agent/
│
├── docker-compose.yml
├── gateway/
├── workers/
├── workspaces/
├── redis/
├── secrets/
└── logs/
```

---

# Security Rules

## IMPORTANT

Never:

* Mount `/`
* Mount `/home`
* Mount `/root`
* Mount `/var/run/docker.sock`
* Run agent as root
* Expose OpenHands publicly

---

## Workspace Isolation

Each task should run in:

```text
/workspaces/{session_id}
```

---

## Telegram Whitelist

Allow only approved Telegram user IDs.

Example:

```javascript
const ALLOWED_USERS = [123456789];
```

---

# Telegram Flow

```text
User sends message
    ↓
Gateway receives message
    ↓
Gateway validates user
    ↓
Gateway pushes task to queue
    ↓
Worker starts OpenHands container
    ↓
OpenHands executes task
    ↓
Logs streamed back to Telegram
```

---

# Initial MVP Tasks

## Task 1

```text
Create hello world HTML page and run local server.
```

---

## Task 2

```text
Create simple Next.js landing page.
```

---

## Task 3

```text
Clone Git repository and run project locally.
```

---

# Docker Compose Example

```yaml
services:

  gateway:
    build: ./gateway
    ports:
      - "8000:8000"
    depends_on:
      - redis

  redis:
    image: redis:7

  9router:
    image: decolua/9router

  openhands-worker:
    image: docker.all-hands.dev/all-hands-ai/openhands:latest
```

---

# 9Router Notes

9Router responsibilities:

* model routing
* fallback
* quota protection
* cost optimization

Suggested routing:

| Task                | Model         |
| ------------------- | ------------- |
| planning            | Qwen          |
| simple tasks        | Gemini Flash  |
| hard coding         | Claude Sonnet |
| difficult debugging | Claude Opus   |

---

# Cloudflare Tunnel

Purpose:

* expose local preview URL
* temporary testing
* avoid public VPS ports

Suggested flow:

```text
Next.js app
   ↓
localhost:3000
   ↓
Cloudflare Tunnel
   ↓
public preview URL
```

---

# Future Features

## Phase 2

* Zalo integration
* Session persistence
* Multi-user support
* GitHub PR automation
* Voice commands

---

## Phase 3

* Multi-agent orchestration
* OpenCode workers
* Browser automation
* Kubernetes scaling
* Web dashboard

---

# Recommended Development Order

## Step 1

Setup:

* Ubuntu
* Docker
* Telegram bot

---

## Step 2

Build minimal gateway.

---

## Step 3

Run OpenHands from Docker.

---

## Step 4

Stream logs back to Telegram.

---

## Step 5

Add Git support.

---

## Step 6

Add Cloudflare Tunnel.

---

## Step 7

Add Zalo adapter.

---

# Success Criteria

MVP is successful when:

* Telegram command triggers coding task
* OpenHands runs autonomously
* Docker sandbox works
* Local web app runs
* Preview URL accessible
* Logs returned to Telegram

---

# Long Term Vision

Build a personal self-hosted AI software engineer platform:

```text
Telegram/Zalo
    ↓
AI Gateway
    ↓
Autonomous Coding Agents
    ↓
Docker Sandboxes
    ↓
Multi-model LLM routing
```
