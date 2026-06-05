import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { LogCollector } from './log-collector.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

/**
 * Execute a task by spawning an OpenHands container with real-time log streaming.
 *
 * @param {{session_id: string, task: string, chat_id: number|string, source?: string}} taskData
 * @returns {{status: string, logs: string, exitCode: number}}
 */
export async function executeTask(taskData) {
  const { session_id, task, chat_id, source } = taskData;
  const workspacePath = path.join(config.workspaceBase, session_id);
  const containerName = `openhands-${session_id}`;

  // Initialize log collector
  const collector = new LogCollector(session_id);
  collector.add(`Task: ${task}`);

  console.log(`\n🚀 Starting task: ${session_id}`);
  console.log(`   Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`);

  // Create workspace directory
  fs.mkdirSync(workspacePath, { recursive: true });

  try {
    // Pull image if not already available
    try {
      await docker.getImage(config.openhandsImage).inspect();
    } catch {
      collector.add('Pulling OpenHands image...');
      console.log('📦 Pulling OpenHands image (first time)...');
      await new Promise((resolve, reject) => {
        docker.pull(config.openhandsImage, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
        });
      });
      collector.add('Image pulled');
      console.log('✅ Image pulled');
    }

    // Create OpenHands container
    const container = await docker.createContainer({
      Image: config.openhandsImage,
      name: containerName,
      Env: [
        `SANDBOX_RUNTIME_CONTAINER_IMAGE=${config.openhandsImage}`,
      ],
      HostConfig: {
        Binds: [`${workspacePath}:/workspace:rw`],
        NetworkMode: 'bridge',
        Memory: config.memLimit,
        NanoCpus: config.cpuLimit * 1e9,
        AutoRemove: true,
      },
      Cmd: ['python', '-m', 'openhands.core.main', '-t', task],
    });

    await container.start();
    collector.add(`Container started: ${containerName}`);

    const info = await container.inspect();
    console.log(`✅ Container started: ${info.Id.slice(0, 12)}`);

    // Stream logs in real-time
    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
    });

    logStream.on('data', (chunk) => {
      const lines = chunk.toString('utf-8').split('\n').filter(Boolean);
      lines.forEach((line) => collector.add(line));
    });

    // Wait for container to finish (with timeout)
    const waitResult = await container.wait(config.taskTimeout);
    const statusCode = waitResult.StatusCode;

    // Final log capture (in case stream missed anything)
    try {
      const finalLogs = await container.logs({ stdout: true, stderr: true });
      const finalText = finalLogs.toString('utf-8');
      if (finalText && collector.logs.length <= 2) {
        finalText.split('\n').filter(Boolean).forEach(l => collector.add(l));
      }
    } catch { /* container auto-removed */ }

    const status = statusCode === 0 ? 'done' : 'error';

    // Save logs to file
    saveLogsToFile(session_id, collector);

    console.log(`📋 Task ${session_id}: ${status} (exit ${statusCode}, ${collector.logs.length} log lines)`);
    return { status, logs: collector.getSummary(status), exitCode: statusCode };

  } catch (err) {
    collector.add(`Error: ${err.message}`);
    console.error(`❌ Task ${session_id} failed:`, err.message);

    // Save logs even on error
    saveLogsToFile(session_id, collector);

    // Clean up container on error
    try {
      const container = docker.getContainer(containerName);
      await container.kill();
      await container.remove({ force: true });
    } catch { /* container may already be gone */ }

    return { status: 'error', logs: collector.getSummary('error'), exitCode: -1 };
  }
}

/**
 * Save collected logs to a file for debugging.
 * @param {string} sessionId
 * @param {LogCollector} collector
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
