/**
 * Deploy — Upload all service files and rebuild everything.
 * 
 * Usage:
 *   node scripts/deploy.js          # Full rebuild (worker + sdk-service)
 *   node scripts/deploy.js worker   # Worker only
 *   node scripts/deploy.js sdk      # SDK service only
 */

import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';

const SSH = {
  host: process.env.SSH_HOST || '192.168.5.123',
  port: parseInt(process.env.SSH_PORT || '22'),
  username: process.env.SSH_USER || 'ubuntu',
  password: process.env.SSH_PASS || 'Admin@123',
  readyTimeout: 15000,
};

const SUDO = `echo ${SSH.password} | sudo -S`;
const PROJECT_DIR = '/home/ubuntu/automation-agent';

function sshExec(cmd, label = '', timeout = 300000) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let out = '';
    const timer = setTimeout(() => { c.end(); reject(new Error('SSH timeout')); }, timeout);
    c.on('ready', () => {
      if (label) console.log(`\n=== ${label} ===`);
      c.exec(cmd, (e, s) => {
        if (e) { clearTimeout(timer); c.end(); reject(e); return; }
        s.on('data', d => { out += d; process.stdout.write(d); });
        s.stderr.on('data', d => { process.stderr.write(d); });
        s.on('close', () => { clearTimeout(timer); c.end(); resolve(out.trim()); });
      });
    });
    c.on('error', reject);
    c.connect(SSH);
  });
}

function uploadFile(localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => {
      c.sftp((err, sftp) => {
        if (err) { c.end(); reject(err); return; }
        const readStream = fs.createReadStream(localPath);
        const writeStream = sftp.createWriteStream(remotePath);
        writeStream.on('close', () => { c.end(); resolve(); });
        writeStream.on('error', (e) => { c.end(); reject(e); });
        readStream.pipe(writeStream);
      });
    });
    c.on('error', reject);
    c.connect(SSH);
  });
}

const target = process.argv[2] || 'all';

console.log(`\n🚀 Deploy (${target})\n`);

// Ensure remote directories exist
await sshExec(`mkdir -p ${PROJECT_DIR}/workers/src ${PROJECT_DIR}/sdk-service ${PROJECT_DIR}/gateway/src/api ${PROJECT_DIR}/gateway/src/bot ${PROJECT_DIR}/gateway/src/queue`, 'Prepare directories');

// Upload worker files
if (target === 'all' || target === 'worker') {
  const workerFiles = ['index.js', 'config.js', 'worker.js', 'log-collector.js', 'notifier.js'];
  for (const file of workerFiles) {
    const local = path.resolve('workers/src', file);
    if (!fs.existsSync(local)) { console.log(`⚠️  Skipping ${file}`); continue; }
    console.log(`📤 workers/src/${file}`);
    await uploadFile(local, `${PROJECT_DIR}/workers/src/${file}`);
  }
  // Upload package.json and Dockerfile
  for (const file of ['package.json', 'Dockerfile']) {
    const local = path.resolve('workers', file);
    if (fs.existsSync(local)) {
      console.log(`📤 workers/${file}`);
      await uploadFile(local, `${PROJECT_DIR}/workers/${file}`);
    }
  }
  console.log('✅ Worker files uploaded');
}

// Upload gateway files
if (target === 'all' || target === 'gateway') {
  const gwFiles = ['index.js', 'config.js'];
  for (const file of gwFiles) {
    const local = path.resolve('gateway/src', file);
    if (!fs.existsSync(local)) { console.log(`⚠️  Skipping ${file}`); continue; }
    console.log(`📤 gateway/src/${file}`);
    await uploadFile(local, `${PROJECT_DIR}/gateway/src/${file}`);
  }
  const gwSubdirs = ['api', 'bot', 'queue'];
  for (const subdir of gwSubdirs) {
    const dir = path.resolve('gateway/src', subdir);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
      console.log(`📤 gateway/src/${subdir}/${file}`);
      await uploadFile(path.join(dir, file), `${PROJECT_DIR}/gateway/src/${subdir}/${file}`);
    }
  }
  for (const file of ['package.json', 'Dockerfile']) {
    const local = path.resolve('gateway', file);
    if (fs.existsSync(local)) {
      console.log(`📤 gateway/${file}`);
      await uploadFile(local, `${PROJECT_DIR}/gateway/${file}`);
    }
  }
  console.log('✅ Gateway files uploaded');
}

// Upload sdk-service files
if (target === 'all' || target === 'sdk') {
  const sdkFiles = ['app.py', 'Dockerfile', 'requirements.txt', '.dockerignore'];
  for (const file of sdkFiles) {
    const local = path.resolve('sdk-service', file);
    if (!fs.existsSync(local)) { console.log(`⚠️  Skipping ${file}`); continue; }
    console.log(`📤 sdk-service/${file}`);
    await uploadFile(local, `${PROJECT_DIR}/sdk-service/${file}`);
  }
  console.log('✅ SDK service files uploaded');
}

// Upload docker-compose.yml
if (target === 'all') {
  console.log('📤 docker-compose.yml');
  await uploadFile(path.resolve('docker-compose.yml'), `${PROJECT_DIR}/docker-compose.yml`);
}

// Rebuild services
const services = target === 'all' ? '' :
  target === 'worker' ? 'worker' :
  target === 'gateway' ? 'gateway' : 'sdk-service';

await sshExec(
  `cd ${PROJECT_DIR} && ${SUDO} docker compose build ${services} && ${SUDO} docker compose up -d`,
  `Rebuild & restart (${services || 'all'})`,
  300000
);

// Wait for startup
await new Promise(r => setTimeout(r, 5000));

// Check status
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose ps`, 'Service status');
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose logs --tail=5 sdk-service`, 'SDK Service logs');
await sshExec(`cd ${PROJECT_DIR} && ${SUDO} docker compose logs --tail=5 worker`, 'Worker logs');

console.log('\n✅ Deploy complete! Run: node scripts/test-worker.js');
