import { Telegraf } from 'telegraf';
import { config } from '../config.js';
import { isAllowed } from './whitelist.js';
import { enqueueTask } from '../queue/redis.js';

const bot = new Telegraf(config.telegramBotToken);

// /start command
bot.start((ctx) => {
  if (!isAllowed(ctx.from.id)) {
    return ctx.reply('⛔ Access denied.');
  }
  return ctx.reply('🤖 AI Coding Agent ready.\n\nSend a task description to begin.\nType /help for available commands.');
});

// /help command
bot.command('help', (ctx) => {
  if (!isAllowed(ctx.from.id)) {
    return ctx.reply('⛔ Access denied.');
  }
  return ctx.reply(
    [
      '📖 *Available Commands*',
      '',
      '/start — Start the bot',
      '/help — Show this help message',
      '/status — Check queue status',
      '',
      '💡 *Send any text* to create a coding task.',
      'The task will be queued and processed by the AI worker.',
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );
});

// /status command — quick queue check from Telegram
bot.command('status', async (ctx) => {
  if (!isAllowed(ctx.from.id)) {
    return ctx.reply('⛔ Access denied.');
  }
  const { getQueueSize } = await import('../queue/redis.js');
  const size = await getQueueSize();
  return ctx.reply(`📊 Queue: ${size} task(s) pending`, { parse_mode: 'Markdown' });
});

// Handle all text messages — enqueue as coding task
bot.on('text', async (ctx) => {
  if (!isAllowed(ctx.from.id)) {
    return ctx.reply('⛔ Access denied.');
  }

  const taskText = ctx.message.text;
  const sessionId = `session_${ctx.from.id}_${ctx.message.message_id}`;

  await enqueueTask(sessionId, taskText, ctx.chat.id);
  await ctx.reply(
    `📋 Task received!\nSession: \`${sessionId}\`\nStatus: Queued`,
    { parse_mode: 'Markdown' }
  );
});

/**
 * Start the Telegram bot (long polling).
 */
export async function startBot() {
  console.log('🤖 Telegram bot started (polling)');
  await bot.launch();
}

/**
 * Stop the Telegram bot gracefully.
 */
export async function stopBot() {
  await bot.stop();
  console.log('🤖 Telegram bot stopped');
}

export { bot };
