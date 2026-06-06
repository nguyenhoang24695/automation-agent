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

// Worker logs (last 80 lines)
await sshExec(`cd /home/ubuntu/automation-agent && ${SUDO} docker compose logs --tail=80 worker`, 'WORKER LOGS');

// Gateway logs
await sshExec(`cd /home/ubuntu/automation-agent && ${SUDO} docker compose logs --tail=40 gateway`, 'GATEWAY LOGS');

// Check Redis queue
await sshExec(`cd /home/ubuntu/automation-agent && ${SUDO} docker compose exec redis redis-cli LLEN task_queue`, 'REDIS QUEUE LENGTH');

// Check workspace
await sshExec(`cd /home/ubuntu/automation-agent && ${SUDO} ls -la workspaces/ 2>/dev/null`, 'WORKSPACES');

// Check logs dir
await sshExec(`cd /home/ubuntu/automation-agent && ${SUDO} ls -la logs/ 2>/dev/null`, 'LOG FILES');
