import Redis from 'ioredis';
import { config } from '../config.js';

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000);
    console.log(`⏳ Redis reconnect attempt ${times} (delay ${delay}ms)`);
    return delay;
  },
});

redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err.message));

const TASK_QUEUE = 'task_queue';

/**
 * Push a task to the Redis queue (FIFO).
 * @param {string} sessionId
 * @param {string} task
 * @param {string|number} chatId
 * @param {object} [meta] - Optional adapter metadata (source, threadId, threadType)
 */
export async function enqueueTask(sessionId, task, chatId, meta = {}) {
  const payload = JSON.stringify({ session_id: sessionId, task, chat_id: chatId, ...meta });
  await redis.rpush(TASK_QUEUE, payload);
}

/**
 * Pop a task from the Redis queue.
 * @returns {Promise<{session_id: string, task: string, chat_id: number} | null>}
 */
export async function dequeueTask() {
  const result = await redis.lpop(TASK_QUEUE);
  return result ? JSON.parse(result) : null;
}

/**
 * Get the number of tasks in the queue.
 * @returns {Promise<number>}
 */
export async function getQueueSize() {
  return await redis.llen(TASK_QUEUE);
}

export { redis };
