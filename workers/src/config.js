import 'dotenv/config';

export const config = {
  // Redis connection (same Redis as Gateway)
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379/0',

  // Telegram Bot Token (same as Gateway — used to send results back)
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,

  // OpenHands Docker image
  openhandsImage: process.env.OPENHANDS_IMAGE || 'docker.openhands.dev/openhands/openhands:1.7',

  // OpenHands Agent Server image (used internally by OpenHands)
  agentServerRepo: process.env.AGENT_SERVER_IMAGE_REPOSITORY || 'ghcr.io/openhands/agent-server',
  agentServerTag: process.env.AGENT_SERVER_IMAGE_TAG || '1.19.1-python',

  // Workspace base path (where task files are created)
  workspaceBase: process.env.WORKSPACE_BASE || '/workspaces',

  // Task timeout in seconds
  taskTimeout: parseInt(process.env.TASK_TIMEOUT || '600', 10),

  // Memory limit in bytes (default 2GB)
  memLimit: parseInt(process.env.MEM_LIMIT || '2147483648', 10),

  // CPU limit (number of CPUs)
  cpuLimit: parseInt(process.env.CPU_LIMIT || '1', 10),

  // 9Router (LLM Router) — OpenAI-compatible API
  ninerouterUrl: process.env.NINEROUTER_BASE_URL || 'http://9router:20128',
  ninerouterApiKey: process.env.NINEROUTER_API_KEY || '',
  ninerouterModel: process.env.NINEROUTER_MODEL || 'kr/claude-sonnet-4.5',
};

// Validate required fields
if (!config.telegramBotToken) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

console.log(`✅ Worker config loaded — timeout: ${config.taskTimeout}s, mem: ${Math.round(config.memLimit / 1073741824)}GB, LLM: ${config.ninerouterUrl}`);
