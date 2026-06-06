import { Client } from 'ssh2';

const SSH_CONFIG = { host: '192.168.5.123', port: 22, username: 'ubuntu', password: 'Admin@123', readyTimeout: 10000 };
const SUDO = 'echo Admin@123 | sudo -S';

function sshExec(command, label = '') {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '', stderr = '';
    conn.on('ready', () => {
      if (label) console.log(`\n=== ${label} ===`);
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); reject(err); return; }
        stream.on('data', (d) => { stdout += d.toString(); process.stdout.write(d.toString()); });
        stream.stderr.on('data', (d) => { stderr += d.toString(); process.stderr.write(d.toString()); });
        stream.on('close', (code) => { conn.end(); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
      });
    });
    conn.on('error', reject);
    conn.connect(SSH_CONFIG);
  });
}

// Check all running containers
await sshExec(`${SUDO} docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"`, 'ALL CONTAINERS');

// Check OpenHands container logs
await sshExec(`${SUDO} docker logs openhands-session_6302853216_15 --tail=50 2>&1`, 'OPENHANDS CONTAINER LOGS');

// Try health endpoint directly
await sshExec(`curl -s -o /dev/null -w "HTTP %{http_code}" http://172.17.0.2:3000/api/v1/health 2>&1 || echo "CANNOT REACH"`, 'HEALTH CHECK FROM HOST');

// Latest worker logs (the full flow)
await sshExec(`cd /home/ubuntu/automation-agent && ${SUDO} docker compose logs --tail=30 worker`, 'LATEST WORKER LOGS');
