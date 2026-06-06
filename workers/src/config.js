import 'dotenv/config';

export const config = {
  // Redis connection
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379/0',

  // Telegram Bot Token
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,

  // SDK Service URL (persistent OpenHands Python service)
  sdkServiceUrl: process.env.SDK_SERVICE_URL || 'http://sdk-service:8080',

  // 9Router (LLM Router) — passed to SDK service
  ninerouterUrl: process.env.NINEROUTER_URL || 'http://9router:20128',
  ninerouterApiKey: process.env.NINEROUTER_API_KEY || '',
  ninerouterModel: process.env.NINEROUTER_MODEL || 'kr/claude-sonnet-4.5',

  // Workspace base path
  workspaceBase: process.env.WORKSPACE_BASE || '/workspaces',

  // Task timeout in seconds
  taskTimeout: parseInt(process.env.TASK_TIMEOUT || '600', 10),
};

// Validate required fields
if (!config.telegramBotToken) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

console.log(`✅ Worker config loaded — timeout: ${config.taskTimeout}s, SDK: ${config.sdkServiceUrl}, LLM: ${config.ninerouterUrl}`);
