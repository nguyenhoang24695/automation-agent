import { Client } from 'ssh2';

const SSH_CONFIG = {
  host: '192.168.5.123',
  port: 22,
  username: 'ubuntu',
  password: 'Admin@123',
  readyTimeout: 10000,
};

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
        stream.on('close', (code) => { conn.end(); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
      });
    });
    conn.on('error', (err) => { console.error(`❌ SSH error (${label}):`, err.message); reject(err); });
    conn.connect(SSH_CONFIG);
  });
}

// Check what's on port 6379
const portCheck = await sshExec('echo Admin@123 | sudo -S ss -tlnp | grep 6379', 'Checking port 6379', true);

// Check running containers
const containerCheck = await sshExec('echo Admin@123 | sudo -S docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"', 'Running containers', true);

// Fix: stop conflicting container/service, or update our docker-compose to use different port
console.log('\n---\nDiagnosing port conflict...');
