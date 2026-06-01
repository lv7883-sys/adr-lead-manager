'use strict';

const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3002;

// Pool compartilhado. O search_path do lead_manager_user já aponta para
// o schema lead_manager (definido via ALTER ROLE na migration 001).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const app = express();
app.disable('x-powered-by');
app.use(express.json());

const startedAt = Date.now();

// Liveness: o processo está de pé? Não toca no banco — usado pelo
// orchestrator para reiniciar o container se travar.
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

const server = app.listen(PORT, () => {
  console.log(`[adr-lead-manager] ouvindo na porta ${PORT}`);
});

// Encerramento gracioso para deploys/rolling restarts.
function shutdown(signal) {
  console.log(`[adr-lead-manager] recebido ${signal}, encerrando...`);
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
