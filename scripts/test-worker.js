/**
 * Test Worker — Push a test task to Redis and monitor worker execution.
 * 
 * Usage:
 *   node scripts/test-worker.js                    # Default test task
 *   node scripts/test-worker.js "Your custom task" # Custom task
 * 
 * Prerequisites:
 *   - ssh2 package installed: npm install ssh2
 *   - Server accessible at 192.168.5.123 with ubuntu/Admin@123
 *   - Docker Compose services running (redis, worker)
 */

import { Client } from 'ssh2';

const SSH = {
  host: process.env.SSH_HOST || '192.168.5.123',
  port: parseInt(process.env.SSH_PORT || '22'),
  username: process.env.SSH_USER || 'ubuntu',
  password: process.env.SSH_PASS || 'Admin@123',
  readyTimeout: 15000,
};

const SUDO = `echo ${SSH.password} | sudo -S`;
const PROJECT_DIR = '/home/ubuntu/automation-agent';

function sshExec(cmd, label = '', timeout = 300000) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let out = '';
    const timer = setTimeout(() => { c.end(); reject(new Error('SSH timeout')); }, timeout);
    c.on('ready', () => {
      if (label) console.log(`\n=== ${label} ===`);
      c.exec(cmd, (e, s) => {
        if (e) { clearTimeout(timer); c.end(); reject(e); return; }
        s.on('data', d => { out += d; process.stdout.write(d); });
        s.stderr.on('data', d => { process.stderr.write(d); });
        s.on('close', () => { clearTimeout(timer); c.end(); resolve(out.trim()); });
      });
    });
    c.on('error', reject);
    c.connect(SSH);
  });
}

// Parse args
const customTask = process.argv.slice(2).join(' ');
const taskText = customTask || 'Create a file called hello.txt with the text "Hello from OpenHands SDK" in it.';
const sessionId = `test_${Date.now()}`;

console.log(`\n🧪 Test Worker`);
console.log(`   Session: ${sessionId}`);
console.log(`   Task: ${taskText}`);
console.log(`   Server: ${SSH.host}`);

// Check worker is running
await sshExec(
  `cd ${PROJECT_DIR} && ${SUDO} docker compose ps worker`,
  'Worker status'
);

// Push task to Redis
const taskJson = JSON.stringify({
  session_id: sessionId,
  task: taskText,
  chat_id: 0,
  source: 'test-script',
});

await sshExec(
  `cd ${PROJECT_DIR} && ${SUDO} docker compose exec -T redis redis-cli LPUSH task_queue '${taskJson}'`,
  'Push task to Redis'
);

console.log('\n📋 Monitoring worker execution (5 min timeout)...\n');
console.log('   Press Ctrl+C to stop monitoring.\n');

// Monitor worker logs
await sshExec(
  `cd ${PROJECT_DIR} && ${SUDO} docker compose logs -f --tail=5 worker`,
  'Worker logs',
  300000
);

// Check workspace output
console.log('\n--- Checking workspace output ---');
await sshExec(
  `${SUDO} ls -la ${PROJECT_DIR}/workspaces/${sessionId}/ 2>/dev/null || echo "No workspace created"`,
  'Workspace contents'
);
