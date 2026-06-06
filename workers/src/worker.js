import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { LogCollector } from './log-collector.js';

const SDK_SERVICE_URL = config.sdkServiceUrl || 'http://sdk-service:8080';

/**
 * Execute a task by sending it to the persistent SDK service via HTTP.
 *
 * The SDK service maintains conversation objects per session,
 * enabling context retention across tasks and instant execution
 * (no container creation, no SDK installation overhead).
 *
 * @param {{session_id: string, task: string, chat_id: number|string, source?: string}} taskData
 * @returns {{status: string, logs: string, exitCode: number}}
 */
export async function executeTask(taskData) {
  const { session_id, task } = taskData;
  const workspacePath = path.join(config.workspaceBase, session_id);

  const collector = new LogCollector(session_id);
  collector.add(`Task: ${task}`);

  console.log(`\n🚀 Starting task: ${session_id}`);
  console.log(`   Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`);

  // Create workspace directory (for host persistence)
  fs.mkdirSync(workspacePath, { recursive: true });

  try {
    // Wait for SDK service to be ready (with timeout)
    await waitForSdkService(collector);

    // Send task to SDK service
    console.log(`📤 Sending task to SDK service: ${SDK_SERVICE_URL}`);
    collector.add('Sending task to SDK service...');

    const response = await fetch(`${SDK_SERVICE_URL}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id,
        task,
        workspace: workspacePath,
      }),
      signal: AbortSignal.timeout(config.taskTimeout * 1000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SDK service error (${response.status}): ${errorText}`);
    }

    const result = await response.json();

    // Parse result
    const status = result.status === 'done' ? 'done' : 'error';
    const exitCode = result.status === 'done' ? 0 : -1;

    collector.add(`Session: ${result.new_session ? 'NEW' : 'REUSED'} (task #${result.task_number})`);
    collector.add(`Duration: ${result.duration}s`);

    // Capture agent's text reply (the actual conversational response)
    const agentReply = result.response || null;

    // Append agent logs (for file debugging)
    if (result.logs) {
      result.logs.split('\n').forEach(line => collector.add(line));
    }

    if (result.error) {
      collector.add(`Error: ${result.error}`);
    }

    console.log(`📋 Task ${session_id}: ${status} (${result.duration}s, task #${result.task_number})`);
    if (agentReply) console.log(`💬 Agent reply: ${agentReply.slice(0, 200)}`);

    // Save full logs to file (for debugging)
    saveLogsToFile(session_id, collector);

    // Return agentReply separately — index.js will send only this to Telegram
    return { status, logs: collector.getSummary(status), exitCode, agentReply };

  } catch (err) {
    collector.add(`Error: ${err.message}`);
    console.error(`❌ Task ${session_id} failed:`, err.message);

    saveLogsToFile(session_id, collector);

    return { status: 'error', logs: collector.getSummary('error'), exitCode: -1 };
  }
}

/**
 * Wait for SDK service to be ready (health check).
 */
async function waitForSdkService(collector) {
  const MAX_WAIT = 60; // seconds
  const startTime = Date.now();

  while ((Date.now() - startTime) < MAX_WAIT * 1000) {
    try {
      const response = await fetch(`${SDK_SERVICE_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const health = await response.json();
        collector.add(`SDK service ready (${health.active_sessions} active sessions)`);
        console.log(`✅ SDK service ready`);
        return;
      }
    } catch {
      // Service not ready yet
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  throw new Error(`SDK service not ready after ${MAX_WAIT}s`);
}

/**
 * Save collected logs to a file for debugging.
 */
function saveLogsToFile(sessionId, collector) {
  try {
    const logDir = '/app/logs';
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, `${sessionId}.log`),
      collector.logs.join('\n'),
      'utf-8'
    );
    console.log(`💾 Logs saved: /app/logs/${sessionId}.log`);
  } catch (err) {
    console.error(`⚠️ Failed to save log file for ${sessionId}:`, err.message);
  }
}
