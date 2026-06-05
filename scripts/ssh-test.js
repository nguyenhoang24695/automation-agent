import { Client } from 'ssh2';

const conn = new Client();

conn.on('ready', () => {
  console.log('✅ SSH connected!');
  conn.exec('hostname && uname -a && whoami', (err, stream) => {
    if (err) { console.error('Exec error:', err.message); conn.end(); return; }
    stream.on('data', (data) => process.stdout.write(data.toString()));
    stream.stderr.on('data', (data) => process.stderr.write(data.toString()));
    stream.on('close', () => {
      console.log('\n✅ Test complete');
      conn.end();
    });
  });
});

conn.on('error', (err) => {
  console.error('❌ SSH error:', err.message);
  process.exit(1);
});

conn.connect({
  host: '192.168.5.123',
  port: 22,
  username: 'ubuntu',
  password: 'Admin@123',
  readyTimeout: 10000,
});
