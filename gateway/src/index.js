import express from 'express';
import { config } from './config.js';
import { startBot, stopBot } from './bot/telegram.js';
import { startZalo, stopZalo } from './bot/zalo.js';
import apiRoutes from './api/routes.js';

const app = express();

// API routes
app.use('/api', apiRoutes);

// Start Express server
const server = app.listen(config.gatewayPort, () => {
  console.log(`🚀 Gateway API listening on port ${config.gatewayPort}`);
});

// Start adapters
startBot();
startZalo();

// Graceful shutdown
async function shutdown(signal) {
  console.log(`\n⏹  Received ${signal} — shutting down...`);
  try { await stopBot(); } catch (err) { console.error('Error stopping Telegram:', err.message); }
  try { await stopZalo(); } catch (err) { console.error('Error stopping Zalo:', err.message); }
  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => {
    console.error('⚠️  Forced shutdown after timeout');
    process.exit(1);
  }, 5000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
