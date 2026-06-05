import { Client } from 'ssh2';

const SSH_CONFIG = {
  host: '192.168.5.123',
  port: 22,
  username: 'ubuntu',
  password: 'Admin@123',
  readyTimeout: 10000,
};

const PROJECT_DIR = '/home/ubuntu/automation-agent';
const SUDO = 'echo Admin@123 | sudo -S';

function sshExec(command, label = '', showOutput = false) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';
    conn.on('ready', () => {
      if (label) console.log(`\n▶ ${label}`);
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); reject(err); return; }
        stream.on('data', (data) => { stdout += data.toString(); if (showOutput) process.stdout.write(data.toString()); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); if (showOutput) process.stderr.write(data.toString()); });
        stream.on('close', (code) => {
          conn.end();
          if (code === 0 && label) console.log(`  ✅ Done`);
          else if (code !== 0) console.log(`  ⚠️  Exit ${code}: ${stderr.slice(0, 200)}`);
          resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
        });
      });
    });
    conn.on('error', (err) => { console.error(`❌ SSH error:`, err.message); reject(err); });
    conn.connect(SSH_CONFIG);
  });
}

console.log('🔄 Redeploying with fix...\n');

// Pull latest
await sshExec(`cd ${PROJECT_DIR} && git pull origin main`, 'Pulling latest code', true);

// Stop and remove old containers
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose down`, 'Stopping old containers', true);

// Start fresh
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose up -d`, 'Starting services', true);

// Wait
console.log('\n⏳ Waiting 5 seconds...');
await new Promise(r => setTimeout(r, 5000));

// Verify
const health = await sshExec('curl -s http://localhost:8000/api/health', 'Health check');
console.log(`  → ${health.stdout}`);

const queue = await sshExec('curl -s http://localhost:8000/api/queue/size', 'Queue size');
console.log(`  → ${queue.stdout}`);

const status = await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose ps`, 'Container status', true);

// Check gateway logs
const logs = await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose logs --tail=20 gateway`, 'Gateway logs', true);

console.log('\n🎉 Redeployment complete!');
console.log('\n📱 Test now: Open your Telegram bot and send /start');
