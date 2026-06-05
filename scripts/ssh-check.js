import { Client } from 'ssh2';

const SSH_CONFIG = {
  host: '192.168.5.123',
  port: 22,
  username: 'ubuntu',
  password: 'Admin@123',
  readyTimeout: 10000,
};

export function sshExec(command, label = '') {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';

    conn.on('ready', () => {
      if (label) console.log(`⏳ ${label}...`);
      conn.exec(command, (err, stream) => {
        if (err) { conn.end(); reject(err); return; }
        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); });
        stream.on('close', (code) => {
          conn.end();
          if (code !== 0 && stderr) console.log(`⚠️  [${label}] ${stderr.trim()}`);
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

// Run checks
const checks = [
  ['docker --version', 'Docker'],
  ['docker compose version', 'Docker Compose'],
  ['git --version', 'Git'],
  ['free -h | head -2', 'Memory'],
  ['df -h / | tail -1', 'Disk'],
  ['id', 'User info'],
];

console.log('🔍 Checking server environment...\n');

for (const [cmd, label] of checks) {
  try {
    const result = await sshExec(cmd, label);
    console.log(`  ${label}: ${result.stdout.split('\n')[0]}\n`);
  } catch (err) {
    console.log(`  ${label}: NOT INSTALLED\n`);
  }
}
