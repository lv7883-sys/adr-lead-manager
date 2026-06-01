'use strict';

const express = require('express');
const { pool } = require('./db');
const { redis } = require('./redisClient');
const logger = require('./logger');
const webhookRouter = require('./routes/webhook');
const adminRouter = require('./routes/admin');
const tenantRouter = require('./routes/tenant');

const PORT = process.env.PORT || 3002;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const startedAt = Date.now();

// Liveness: o processo está de pé? Não toca no banco.
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'adr-lead-manager',
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

// Readiness: pronto para receber tráfego? Verifica dependências (DB).
app.get('/health/ready', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    res.json({ status: 'ready', db: rows[0].ok === 1 ? 'up' : 'unknown' });
  } catch (err) {
    res.status(503).json({ status: 'unavailable', db: 'down', error: err.message });
  }
});

// Webhooks de provedores externos (Z-API / Evolution API).
app.use('/webhook', webhookRouter);

// API administrativa (protegida por JWT + role PLATFORM_ADMIN).
app.use('/admin', adminRouter);

// Self-service da unidade (protegido por JWT + requireTenantRole).
app.use('/tenant', tenantRouter);

// Só sobe o listener quando executado diretamente (não nos testes que
// importam o app).
if (require.main === module) {
  const server = app.listen(PORT, () => {
    logger.info('server.started', { port: Number(PORT) });
  });

  // Encerramento gracioso para deploys/rolling restarts.
  const shutdown = (signal) => {
    logger.info('server.shutdown', { signal });
    server.close(() =>
      Promise.allSettled([pool.end(), redis.quit()]).then(() => process.exit(0))
    );
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
