import { Router } from 'express';
import { getQueueSize } from '../queue/redis.js';
import { config } from '../config.js';

const router = Router();

// GET /api/health
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// GET /api/queue/size
router.get('/queue/size', async (req, res) => {
  try {
    const size = await getQueueSize();
    res.json({ queue_size: size });
  } catch (err) {
    res.status(500).json({ error: 'Redis unavailable', detail: err.message });
  }
});

// GET /api/zalo/status
router.get('/zalo/status', async (req, res) => {
  const { zaloApi } = await import('../bot/zalo.js');
  res.json({
    zalo_enabled: config.zalo.enabled,
    zalo_connected: !!zaloApi,
    zalo_uid: zaloApi?.getContext()?.uid || null,
  });
});

export default router;
