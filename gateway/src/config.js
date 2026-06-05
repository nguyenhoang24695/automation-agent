import 'dotenv/config';

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  allowedUsers: (process.env.ALLOWED_USERS || '')
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter(Boolean),
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379/0',
  gatewayPort: parseInt(process.env.GATEWAY_PORT || '8000', 10),
  zalo: {
    enabled: process.env.ZALO_ENABLED === 'true',
    credentialsPath: process.env.ZALO_CREDENTIALS_PATH || './secrets/zalo_credentials.json',
    allowedUsers: (process.env.ZALO_ALLOWED_USERS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  },
};

// Validate required fields
if (!config.telegramBotToken) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required. Set it in .env');
  process.exit(1);
}

if (config.allowedUsers.length === 0) {
  console.warn('⚠️  ALLOWED_USERS is empty — no one can use the bot!');
}

console.log(`✅ Config loaded — ${config.allowedUsers.length} Telegram user(s), Zalo ${config.zalo.enabled ? 'enabled' : 'disabled'}`);
