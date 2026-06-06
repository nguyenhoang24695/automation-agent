import { Client } from 'ssh2';

const SSH = { host: '192.168.5.123', port: 22, username: 'ubuntu', password: 'Admin@123', readyTimeout: 10000 };
const SUDO = 'echo Admin@123 | sudo -S';

function sshExec(cmd, label = '') {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let out = '', err = '';
    c.on('ready', () => {
      if (label) console.log(`\n=== ${label} ===`);
      c.exec(cmd, (e, s) => {
        if (e) { c.end(); reject(e); return; }
        s.on('data', d => { out += d; process.stdout.write(d); });
        s.stderr.on('data', d => { err += d; process.stderr.write(d); });
        s.on('close', () => { c.end(); resolve(out.trim()); });
      });
    });
    c.on('error', reject);
    c.connect(SSH);
  });
}

await sshExec(`cd /home/ubuntu/automation-agent && ${SUDO} docker compose logs --tail=60 worker`, 'WORKER LOGS');
await sshExec(`${SUDO} docker ps -a --format "table {{.Names}}\\t{{.Status}}"`, 'CONTAINERS');
