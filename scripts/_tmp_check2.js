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

// Check OpenHands container logs for more detail
await sshExec(`${SUDO} docker logs openhands-session_6302853216_18 --tail=80 2>&1`, 'OPENHANDS CONTAINER LOGS (last session)');

// Check if the container is still running or exited
await sshExec(`${SUDO} docker ps -a --filter "name=openhands" --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"`, 'OPENHANDS CONTAINERS');

// Test the API endpoint directly from host with longer timeout
await sshExec(`curl -s -m 60 -X POST http://localhost:20128/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer sk-fd59d04d50199658-zvwzgi-ae65d860" -d '{"model":"kr/claude-sonnet-4.5","messages":[{"role":"user","content":"say hi"}]}' | head -c 500`, 'TEST 9Router API');
