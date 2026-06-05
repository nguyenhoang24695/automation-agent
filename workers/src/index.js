import Redis from 'ioredis';
import { config } from './config.js';
import { executeTask } from './worker.js';
import { sendTelegramMessage, sendStatus } from './notifier.js';

// Connect to the same Redis as Gateway
const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000);
    console.log(`⏳ Redis reconnect attempt ${times} (delay ${delay}ms)`);
    return delay;
  },
});

redis.on('connect', () => console.log('✅ Worker Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err.message));

const TASK_QUEUE = 'task_queue';
const POLL_TIMEOUT = 5; // seconds for BLPOP

/**
 * Main worker loop: BLPOP from Redis, execute task, notify via Telegram.
 */
async function runWorker() {
  console.log('🔄 Worker started, waiting for tasks...');

  while (true) {
    try {
      // BLPOP blocks until a task is available (or timeout of POLL_TIMEOUT seconds)
      const result = await redis.blpop(TASK_QUEUE, POLL_TIMEOUT);
      if (!result) continue; // timeout, try again

      const [, raw] = result; // result is [queueName, value]
      const taskData = JSON.parse(raw);

      console.log(`\n📨 Dequeued: ${taskData.session_id}`);

      // Notify user: task started
      if (taskData.chat_id) {
        await sendStatus(taskData.chat_id, taskData.session_id, 'running');
      }

      // Execute the task
      const execResult = await executeTask(taskData);

      // Notify user: task finished with formatted logs
      if (taskData.chat_id) {
        await sendTelegramMessage(taskData.chat_id, execResult.logs);
      }

    } catch (err) {
      console.error('❌ Worker loop error:', err.message);
      // Brief pause before retry on error
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('\n⏹ Worker shutting down...');
  redis.disconnect();
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('\n⏹ Worker shutting down...');
  redis.disconnect();
  process.exit(0);
});

runWorker();
