import { Zalo, ThreadType } from 'zca-js';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { isZaloAllowed } from './zalo-whitelist.js';
import { enqueueTask } from '../queue/redis.js';

let zaloApi = null;

/**
 * Image metadata getter required by zca-js v2.
 * Extracts dimensions and size from local image files.
 */
async function imageMetadataGetter(filePath) {
  const data = await fs.promises.readFile(filePath);
  const metadata = await sharp(data).metadata();
  return {
    height: metadata.height || 0,
    width: metadata.width || 0,
    size: metadata.size || data.length,
  };
}

/**
 * Load saved Zalo credentials from disk.
 */
function loadCredentials() {
  const credPath = path.resolve(config.zalo.credentialsPath);
  if (!fs.existsSync(credPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  } catch {
    console.error('❌ Failed to parse Zalo credentials file');
    return null;
  }
}

/**
 * Save Zalo credentials to disk for reuse after QR login.
 */
function saveCredentials(data) {
  const credPath = path.resolve(config.zalo.credentialsPath);
  const dir = path.dirname(credPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(credPath, JSON.stringify(data, null, 2));
  console.log('✅ Zalo credentials saved to', credPath);
}

/**
 * Start the Zalo adapter.
 * Tries saved credentials first, falls back to QR login.
 */
export async function startZalo() {
  if (!config.zalo.enabled) {
    console.log('⏭  Zalo adapter disabled (ZALO_ENABLED=false)');
    return;
  }

  console.log('🔄 Starting Zalo adapter...');
  const zalo = new Zalo({ imageMetadataGetter });

  // Try saved credentials first
  const credentials = loadCredentials();
  if (credentials) {
    try {
      zaloApi = await zalo.login(credentials);
      console.log('✅ Zalo logged in (saved credentials), UID:', zaloApi.getContext().uid);
    } catch (err) {
      console.warn('⚠️  Saved Zalo credentials expired:', err.message);
      console.log('🔄 Falling back to QR login...');
      zaloApi = await loginWithQR(zalo);
    }
  } else {
    console.log('📱 No saved Zalo credentials — starting QR login...');
    zaloApi = await loginWithQR(zalo);
  }

  // Start listening for messages
  setupListener();
}

/**
 * QR code login flow.
 * Generates a QR image that must be scanned with the Zalo mobile app.
 */
async function loginWithQR(zalo) {
  const qrPath = path.resolve('./secrets/zalo_qr.png');
  const dir = path.dirname(qrPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const api = await zalo.loginQR(
    {
      qrPath,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    },
    (event) => {
      if (event.type === 'GotLoginInfo') {
        saveCredentials(event.data);
      }
    }
  );

  console.log('✅ Zalo logged in via QR code');
  console.log(`📱 QR code saved at: ${qrPath}`);
  return api;
}

/**
 * Set up WebSocket listener for incoming Zalo messages.
 * Only one listener can be active per account at a time.
 */
function setupListener() {
  const { listener } = zaloApi;

  listener.on('message', async (message) => {
    // Skip self-sent messages
    if (message.isSelf) return;

    // Only handle text messages
    const content = message.data?.content;
    if (typeof content !== 'string') return;

    const senderId = message.threadId;
    const isGroup = message.type === ThreadType.Group;

    // Whitelist check for DMs (groups are allowed for now)
    if (!isGroup && !isZaloAllowed(senderId)) {
      await sendZaloMessage(message.threadId, message.type, '⛔ Access denied.');
      return;
    }

    // Generate session ID: zalo_{userId}_{timestamp}
    const sessionId = `zalo_${senderId}_${Date.now()}`;

    // Enqueue task with Zalo adapter metadata
    await enqueueTask(sessionId, content, senderId, {
      source: 'zalo',
      threadId: message.threadId,
      threadType: message.type,
    });

    // Confirm receipt with quoted reply
    await sendZaloMessage(
      message.threadId,
      message.type,
      `📋 Task received!\nSession: ${sessionId}\nStatus: Queued`,
      message.data // quote original message
    );
  });

  listener.onConnected(() => console.log('✅ Zalo WebSocket connected'));
  listener.onClosed(() => console.log('⚠️  Zalo WebSocket disconnected'));
  listener.onError((err) => console.error('❌ Zalo WebSocket error:', err));

  listener.start();
  console.log('🤖 Zalo adapter started (listening for messages)');
}

/**
 * Send a message back to a Zalo user or group.
 * Used by the adapter itself and by workers to send logs back.
 *
 * @param {string} threadId - Zalo thread (user or group ID)
 * @param {string|number} threadType - ThreadType.User or ThreadType.Group
 * @param {string} text - Message text
 * @param {object} [quote] - Optional original message to quote/reply to
 */
export async function sendZaloMessage(threadId, threadType, text, quote = null) {
  if (!zaloApi) {
    console.warn('⚠️  Zalo API not initialized — cannot send message');
    return;
  }
  try {
    const payload = { msg: text };
    if (quote) payload.quote = quote;
    await zaloApi.sendMessage(payload, threadId, threadType);
  } catch (err) {
    console.error('❌ Failed to send Zalo message:', err.message);
  }
}

/**
 * Stop the Zalo adapter gracefully.
 */
export async function stopZalo() {
  if (zaloApi?.listener) {
    try {
      zaloApi.listener.stop();
      console.log('🤖 Zalo adapter stopped');
    } catch (err) {
      console.error('Error stopping Zalo adapter:', err.message);
    }
  }
}

export { zaloApi };
