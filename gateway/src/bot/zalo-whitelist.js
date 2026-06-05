import { config } from '../config.js';

/**
 * Check if a Zalo user ID is in the whitelist.
 * @param {string} userId - Zalo user ID
 * @returns {boolean}
 */
export function isZaloAllowed(userId) {
  return config.zalo.allowedUsers.includes(userId);
}
