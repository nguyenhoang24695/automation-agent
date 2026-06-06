import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { LogCollector } from './log-collector.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

/**
 * Detect the Docker network this worker container is on.
 * Falls back to 'bridge' if detection fails.
 */
async function getWorkerNetwork() {
  try {
    const hostname = (await fs.promises.readFile('/etc/hostname', 'utf-8')).trim();
    const workerContainer = docker.getContainer(hostname);
    const info = await workerContainer.inspect();
    const networkNames = Object.keys(info.NetworkSettings.Networks);
    if (networkNames.length > 0) {
      console.log(`🌐 Worker network: ${networkNames[0]}`);
      return networkNames[0];
    }
  } catch (err) {
    console.log(`⚠️ Network detection failed: ${err.message}, using bridge`);
  }
  return 'bridge';
}

/**
 * Pull the OpenHands image if not already available.
 */
async function ensureImage(collector) {
  try {
    await docker.getImage(config.openhandsImage).inspect();
  } catch {
    collector.add('Pulling OpenHands image (this may take a few minutes)...');
    console.log(`📦 Pulling OpenHands image: ${config.openhandsImage}`);
    await new Promise((resolve, reject) => {
      docker.pull(config.openhandsImage, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
      });
    });
    collector.add('Image pulled successfully');
    console.log('✅ Image pulled');
  }
}

/**
 * Wait for the OpenHands server to be ready on port 3000.
 * @param {string} containerIp - Container IP on Docker bridge network
 * @param {number} maxWait - Max seconds to wait
 * @returns {boolean}
 */
async function waitForReady(containerIp, maxWait = 60) {
  const url = `http://${containerIp}:3000/api/v1/health`;
  console.log(`⏳ Waiting for OpenHands at ${url}...`);

  for (let i = 0; i < maxWait; i++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        console.log('✅ OpenHands server is ready');
        return true;
      }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('⚠️ OpenHands server did not become ready in time');
  return false;
}

/**
 * Submit a task to OpenHands via REST API.
 * @param {string} containerIp
 * @param {string} task
 * @returns {string|null} - app_conversation_id or null
 */
async function submitTask(containerIp, task) {
  const url = `http://${containerIp}:3000/api/v1/app-conversations`;
  console.log(`📤 Submitting task to OpenHands...`);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initial_message: {
          content: [{ type: 'text', text: task }],
        },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const error = await resp.text();
      console.error(`❌ Submit failed (${resp.status}): ${error}`);
      return null;
    }

    const data = await resp.json();
    const convId = data.app_conversation_id || data.conversation_id || data.id;
    console.log(`✅ Task submitted — conversation: ${convId}`);
    return convId;

  } catch (err) {
    console.error('❌ Submit error:', err.message);
    return null;
  }
}

/**
 * Poll OpenHands API for task completion.
 * @param {string} containerIp
 * @param {string} conversationId
 * @param {number} timeoutSec
 * @returns {{status: string, events: object[]}}
 */
async function pollForResult(containerIp, conversationId, timeoutSec) {
  const url = `http://${containerIp}:3000/api/v1/app-conversations/${conversationId}`;
  const startTime = Date.now();

  console.log(`⏳ Polling for results...`);

  while ((Date.now() - startTime) < timeoutSec * 1000) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const data = await resp.json();
        const status = data.status || data.state || 'unknown';

        // Check if task is complete
        if (['done', 'completed', 'finished', 'error', 'failed', 'stopped'].includes(status)) {
          console.log(`📋 Task finished with status: ${status}`);
          return { status, data };
        }
      }
    } catch { /* poll error, retry */ }

    await new Promise(r => setTimeout(r, 5000));
  }

  return { status: 'timeout', data: null };
}

/**
 * Execute a task by spawning an OpenHands server container.
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

  let container = null;

  try {
    // Ensure image is available
    await ensureImage(collector);

    // Create OpenHands container (as a server)
    container = await docker.createContainer({
      Image: config.openhandsImage,
      name: containerName,
      Env: [
        `AGENT_SERVER_IMAGE_REPOSITORY=${config.agentServerRepo}`,
        `AGENT_SERVER_IMAGE_TAG=${config.agentServerTag}`,
        'LOG_ALL_EVENTS=true',
        `SANDBOX_RUNTIME_CONTAINER_IMAGE=${config.agentServerRepo}:${config.agentServerTag}`,
        // LLM configuration via 9Router
        `LLM_API_URL=${config.ninerouterUrl}/v1`,
        `LLM_API_KEY=${config.ninerouterApiKey}`,
        `LLM_MODEL=${config.ninerouterModel}`,
      ],
      ExposedPorts: { '3000/tcp': {} },
      HostConfig: {
        Binds: [
          `${workspacePath}:/opt/workspace_base:rw`,
          '/var/run/docker.sock:/var/run/docker.sock',
        ],
        ExtraHosts: ['host.docker.internal:host-gateway'],
        PortBindings: {}, // Don't bind to host — use Docker network IP
        Memory: config.memLimit,
        NanoCpus: config.cpuLimit * 1e9,
      },
    });

    await container.start();
    collector.add(`Container started: ${containerName}`);

    // Connect OpenHands to worker's Docker network so they can communicate
    const workerNetwork = await getWorkerNetwork();
    const network = docker.getNetwork(workerNetwork);
    try {
      await network.connect({ Container: container.id });
      collector.add(`Connected to network: ${workerNetwork}`);
      console.log(`🌐 Connected OpenHands to network: ${workerNetwork}`);
    } catch (netErr) {
      // May already be on the network (e.g., bridge)
      collector.add(`Network connect skipped: ${netErr.message}`);
      console.log(`⚠️ Network connect: ${netErr.message}`);
    }

    // Get container IP on the worker's network
    const info = await container.inspect();
    const networks = info.NetworkSettings.Networks;
    const containerIp = networks[workerNetwork]?.IPAddress
      || networks[Object.keys(networks)[0]]?.IPAddress
      || '172.17.0.2';
    console.log(`✅ Container started: ${info.Id.slice(0, 12)} (IP: ${containerIp} on ${workerNetwork})`);
    collector.add(`Container IP: ${containerIp} (${workerNetwork})`);

    // Stream logs in background
    const logStream = await container.logs({ follow: true, stdout: true, stderr: true });
    logStream.on('data', (chunk) => {
      const lines = chunk.toString('utf-8').split('\n').filter(Boolean);
      lines.forEach((line) => collector.add(line));
    });

    // Wait for OpenHands server to be ready
    const ready = await waitForReady(containerIp, 90);
    if (!ready) {
      throw new Error('OpenHands server did not become ready within 90s');
    }
    collector.add('OpenHands server ready');

    // Submit task via REST API
    const conversationId = await submitTask(containerIp, task);
    if (!conversationId) {
      throw new Error('Failed to submit task to OpenHands API');
    }
    collector.add(`Conversation: ${conversationId}`);

    // Poll for results
    const result = await pollForResult(containerIp, conversationId, config.taskTimeout);
    collector.add(`Result: ${result.status}`);

    const status = ['done', 'completed', 'finished'].includes(result.status) ? 'done' : 'error';

    // Save logs to file
    saveLogsToFile(session_id, collector);

    console.log(`📋 Task ${session_id}: ${status} (${collector.logs.length} log lines)`);
    return { status, logs: collector.getSummary(status), exitCode: status === 'done' ? 0 : 1 };

  } catch (err) {
    collector.add(`Error: ${err.message}`);
    console.error(`❌ Task ${session_id} failed:`, err.message);

    saveLogsToFile(session_id, collector);

    return { status: 'error', logs: collector.getSummary('error'), exitCode: -1 };

  } finally {
    // Always clean up the container
    if (container) {
      try {
        await container.stop({ t: 10 });
        await container.remove({ force: true });
        console.log(`🧹 Container ${containerName} cleaned up`);
      } catch { /* may already be gone */ }
    }
  }
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
