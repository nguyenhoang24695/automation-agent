import { Client } from 'ssh2';

const conn = new Client();
const SSH = { host: '192.168.5.123', port: 22, username: 'ubuntu', password: 'Admin@123', readyTimeout: 10000 };
const SUDO = 'echo Admin@123 | sudo -S';
const DIR = '/home/ubuntu/automation-agent';

conn.on('ready', () => {
  conn.exec(`cd ${DIR} && ${SUDO} docker compose logs --tail=30 gateway`, (err, stream) => {
    let out = '';
    stream.on('data', (d) => { out += d.toString(); });
    stream.stderr.on('data', (d) => { out += d.toString(); });
    stream.on('close', () => { console.log(out); conn.end(); });
  });
});
conn.connect(SSH);
