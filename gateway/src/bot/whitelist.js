import { config } from '../config.js';

/**
 * Check if a Telegram user ID is in the whitelist.
 * @param {number} userId - Telegram user ID
 * @returns {boolean}
 */
export function isAllowed(userId) {
  return config.allowedUsers.includes(userId);
}
