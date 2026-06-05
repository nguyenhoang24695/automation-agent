import { config } from './config.js';

const API_BASE = `https://api.telegram.org/bot${config.telegramBotToken}`;

/**
 * Send a message to a Telegram chat.
 * Splits long messages to stay within Telegram's 4096 char limit.
 *
 * @param {number|string} chatId - Telegram chat ID
 * @param {string} text - Message text (Markdown supported)
 */
export async function sendTelegramMessage(chatId, text) {
  const MAX_LEN = 4096;
  const chunks = [];

  for (let i = 0; i < text.length; i += MAX_LEN) {
    chunks.push(text.slice(i, i + MAX_LEN));
  }

  for (const chunk of chunks) {
    try {
      const response = await fetch(`${API_BASE}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`❌ Telegram API error (${response.status}): ${error}`);
      }
    } catch (err) {
      console.error(`❌ Failed to send Telegram message to ${chatId}:`, err.message);
    }
  }
}

/**
 * Send a short status update to Telegram.
 *
 * @param {number|string} chatId - Telegram chat ID
 * @param {string} sessionId - Task session ID
 * @param {string} status - 'queued', 'running', 'done', 'error'
 */
export async function sendStatus(chatId, sessionId, status) {
  const icons = {
    queued: '📋',
    running: '🔄',
    done: '✅',
    error: '❌',
  };
  const icon = icons[status] || '❓';
  const msg = `${icon} Session \`${sessionId}\`: ${status}`;

  try {
    await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: 'Markdown',
      }),
    });
  } catch (err) {
    console.error('❌ Failed to send status:', err.message);
  }
}
