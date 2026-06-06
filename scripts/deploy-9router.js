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

console.log('🚀 Deploying 9Router LLM Router...\n');

// 1. Pull latest
await sshExec(`cd ${PROJECT_DIR} && git pull origin main`, 'Pulling latest code', true);

// 2. Stop all services
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose down`, 'Stopping services', true);

// 3. Pull 9Router image
console.log('\n📦 Pulling 9Router image...');
await sshExec(`${SUDO} docker pull decolua/9router:latest`, 'Pulling 9Router image', true);

// 4. Rebuild and start all services
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose up --build -d`, 'Starting all services', true);

// 5. Wait for startup
console.log('\n⏳ Waiting 10 seconds for services...');
await new Promise(r => setTimeout(r, 10000));

// 6. Check container status
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose ps`, 'Container status', true);

// 7. Test 9Router dashboard
console.log('\n🌐 Testing 9Router dashboard...');
const routerHealth = await sshExec('curl -s -o /dev/null -w "%{http_code}" http://localhost:20128');
console.log(`  9Router dashboard HTTP status: ${routerHealth.stdout}`);

// 8. Test 9Router API
const routerApi = await sshExec('curl -s http://localhost:20128/v1/models 2>/dev/null | head -c 200');
console.log(`  9Router API models: ${routerApi.stdout.slice(0, 200) || '(no response or needs auth)'}`);

// 9. Worker logs
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose logs --tail=15 worker`, 'Worker logs', true);

// 10. Gateway health
const health = await sshExec('curl -s http://localhost:8000/api/health');
console.log(`\n🏥 Gateway health: ${health.stdout}`);

// 11. 9Router logs
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose logs --tail=15 9router`, '9Router logs', true);

console.log('\n🎉 9Router deployment complete!');
console.log('\n📌 Next steps:');
console.log('   1. Open dashboard: http://192.168.5.123:20128');
console.log('   2. Connect a FREE provider (Kiro AI or OpenCode Free)');
console.log('   3. Copy API key → set NINEROUTER_API_KEY in .env');
console.log('   4. Restart worker: docker compose restart worker');
