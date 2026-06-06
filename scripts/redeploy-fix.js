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
          else if (code !== 0) console.log(`  ⚠️  Exit ${code}: ${stderr.slice(0, 300)}`);
          resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
        });
      });
    });
    conn.on('error', (err) => { console.error(`❌ SSH error:`, err.message); reject(err); });
    conn.connect(SSH_CONFIG);
  });
}

console.log('🔄 Redeploying with fixed OpenHands image URL...\n');

// 1. Pull latest
await sshExec(`cd ${PROJECT_DIR} && git pull origin main`, 'Pulling latest code', true);

// 2. Stop all services
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose down`, 'Stopping services', true);

// 3. Rebuild and start
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose up --build -d`, 'Rebuilding and starting', true);

// 4. Wait
console.log('\n⏳ Waiting 8 seconds...');
await new Promise(r => setTimeout(r, 8000));

// 5. Check status
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose ps`, 'Container status', true);

// 6. Worker logs
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose logs --tail=20 worker`, 'Worker logs', true);

// 7. Health
const health = await sshExec('curl -s http://localhost:8000/api/health', 'Health check');
console.log(`  → ${health.stdout}`);

// 8. Test image pull manually
console.log('\n📦 Testing OpenHands image pull...');
await sshExec(
  `${SUDO} docker pull docker.openhands.dev/openhands/openhands:1.7`,
  'Pulling OpenHands image on host',
  true
);

console.log('\n🎉 Redeployment complete!');
console.log('\n📱 Send a test message to your Telegram bot.');
console.log('   Watch worker logs: docker compose logs -f worker');
