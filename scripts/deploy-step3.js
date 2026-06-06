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

console.log('🚀 Deploying Step 3 (Worker service) to server...\n');

// 1. Pull latest code
await sshExec(`cd ${PROJECT_DIR} && git pull origin main`, 'Pulling latest code', true);

// 2. Create workspaces directory if not exists
await sshExec(`mkdir -p ${PROJECT_DIR}/workspaces`, 'Ensuring workspaces directory exists', true);

// 3. Stop all services
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose down`, 'Stopping all services', true);

// 4. Build and start with new worker service
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose up --build -d`, 'Building and starting all services', true);

// 5. Wait for services to stabilize
console.log('\n⏳ Waiting 8 seconds for services to start...');
await new Promise(r => setTimeout(r, 8000));

// 6. Check container status
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose ps`, 'Container status', true);

// 7. Check gateway health
const health = await sshExec('curl -s http://localhost:8000/api/health', 'Gateway health check');
console.log(`  → ${health.stdout}`);

// 8. Check worker logs
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose logs --tail=15 worker`, 'Worker logs (last 15 lines)', true);

// 9. Check gateway logs
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose logs --tail=10 gateway`, 'Gateway logs (last 10 lines)', true);

// 10. Verify Redis connectivity from worker
const redisCheck = await sshExec(
  `cd ${PROJECT_DIR} && ${SUDO} docker compose exec worker node -e "const R=require('ioredis');const r=new R('redis://redis:6379/0');r.ping().then(v=>{console.log('Redis OK:',v);process.exit(0)}).catch(e=>{console.error('Redis FAIL:',e.message);process.exit(1)})"`,
  'Redis connectivity from worker'
);
console.log(`  → ${redisCheck.stdout || redisCheck.stderr}`);

console.log('\n🎉 Step 3 deployment complete!');
console.log('\n📱 Test: Send a message to your Telegram bot');
console.log('   The worker should pick it up and spawn an OpenHands container.');
console.log('\n⚠️  Note: First task will trigger OpenHands image pull (~2GB). This may take a few minutes.');
