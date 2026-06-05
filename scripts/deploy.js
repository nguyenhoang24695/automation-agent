import { Client } from 'ssh2';

const SSH_CONFIG = {
  host: '192.168.5.123',
  port: 22,
  username: 'ubuntu',
  password: 'Admin@123',
  readyTimeout: 10000,
};

const REPO_URL = 'https://github.com/nguyenhoang24695/automation-agent.git';
const PROJECT_DIR = '/home/ubuntu/automation-agent';

function sshExec(command, label = '', showOutput = false) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';

    conn.on('ready', () => {
      if (label) console.log(`\n▶ ${label}`);
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); reject(err); return; }
        stream.on('data', (data) => {
          stdout += data.toString();
          if (showOutput) process.stdout.write(data.toString());
        });
        stream.stderr.on('data', (data) => {
          stderr += data.toString();
          if (showOutput) process.stderr.write(data.toString());
        });
        stream.on('close', (code) => {
          conn.end();
          if (code === 0) {
            if (label) console.log(`  ✅ Done`);
          } else {
            console.log(`  ⚠️  Exit code: ${code}`);
            if (stderr) console.log(`  stderr: ${stderr.slice(0, 200)}`);
          }
          resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
        });
      });
    });

    conn.on('error', (err) => {
      console.error(`❌ SSH error (${label}):`, err.message);
      reject(err);
    });

    conn.connect(SSH_CONFIG);
  });
}

// --- Deploy Steps ---

console.log('🚀 Deploying AI Agent to Ubuntu server...\n');
console.log(`Server: ${SSH_CONFIG.username}@${SSH_CONFIG.host}`);
console.log(`Repo: ${REPO_URL}`);
console.log(`Target: ${PROJECT_DIR}`);

// Step 1: Clone or update repo
const checkDir = await sshExec(`test -d ${PROJECT_DIR}/.git && echo 'exists' || echo 'new'`);
if (checkDir.stdout.includes('exists')) {
  await sshExec(`cd ${PROJECT_DIR} && git pull origin main`, 'Pulling latest code', true);
} else {
  await sshExec(`git clone ${REPO_URL} ${PROJECT_DIR}`, 'Cloning repository', true);
}

// Step 2: Create .env from .env.example
await sshExec(
  `cd ${PROJECT_DIR} && test -f .env && echo 'env exists' || cp .env.example .env`,
  'Creating .env file'
);

// Step 3: Create required directories
await sshExec(
  `mkdir -p ${PROJECT_DIR}/secrets ${PROJECT_DIR}/logs ${PROJECT_DIR}/redis/data`,
  'Creating directories'
);

// Step 4: Check current .env content (to verify credentials)
const envCheck = await sshExec(`cd ${PROJECT_DIR} && head -30 .env`, 'Checking .env');
console.log(`  Current .env (first 30 lines):\n${envCheck.stdout}`);

// Step 5: Add ubuntu user to docker group (if needed)
await sshExec(
  'echo Admin@123 | sudo -S usermod -aG docker ubuntu 2>/dev/null; echo done',
  'Ensuring docker group membership'
);

// Step 6: Build Docker image
await sshExec(
  `cd ${PROJECT_DIR} && echo Admin@123 | sudo -S docker compose build --no-cache`,
  'Building Docker image (this may take a few minutes...)',
  true
);

// Step 7: Start services
await sshExec(
  `cd ${PROJECT_DIR} && echo Admin@123 | sudo -S docker compose up -d`,
  'Starting services',
  true
);

// Step 8: Wait for services to start
console.log('\n⏳ Waiting 5 seconds for services to start...');
await new Promise(r => setTimeout(r, 5000));

// Step 9: Verify
const healthCheck = await sshExec('curl -s http://localhost:8000/api/health', 'Health check');
console.log(`  Response: ${healthCheck.stdout}`);

const queueCheck = await sshExec('curl -s http://localhost:8000/api/queue/size', 'Queue check');
console.log(`  Response: ${queueCheck.stdout}`);

const containerCheck = await sshExec('echo Admin@123 | sudo -S docker compose ps', 'Container status', true);

console.log('\n🎉 Deployment complete!');
console.log('Next steps:');
console.log('  1. Test your Telegram bot — send /start');
console.log('  2. Check logs: sudo docker compose logs -f gateway');
console.log('  3. To enable Zalo: edit .env → set ZALO_ENABLED=true → sudo docker compose restart');
