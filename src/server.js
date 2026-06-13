'use strict';

const express = require('express');
const { pool } = require('./db');
const { redis } = require('./redisClient');
const logger = require('./logger');
const webhookRouter = require('./routes/webhook');
const adminRouter = require('./routes/admin');
const tenantRouter = require('./routes/tenant');
const cors = require('cors');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const PORT = process.env.PORT || 3002;

const app = express();
app.set('trust proxy', 1);   // atrás do Traefik — req.ip = IP real do cliente (rate limit)
app.disable('x-powered-by');
// CORS — whitelist de origens de navegador (item de segurança 1). Chamadas
// server-to-server (ex.: Scheduler -> LM) não enviam Origin e não são afetadas.
app.use(cors({
  origin: ['https://agenda.leovecchi.com', 'https://leads-api.leovecchi.com'],
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
}));
// Guarda o corpo BRUTO em req.rawBody (necessário pra verificar a assinatura
// X-Hub-Signature-256 dos webhooks da Meta, que é HMAC do payload original).
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

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

// ---- Rate limiting (item de segurança 5). Janela de 1 min; limites por env ----
const RL_WINDOW_MS = 60_000;
function rl429(req, res) {
  const reset = req.rateLimit && req.rateLimit.resetTime
    ? new Date(req.rateLimit.resetTime).getTime() : Date.now() + RL_WINDOW_MS;
  res.status(429).json({ error: 'rate_limit_exceeded', retry_after: Math.max(1, Math.ceil((reset - Date.now()) / 1000)) });
}
// Chave por tenant extraído da URL; fallback para o IP (normalizado p/ IPv6).
function tenantUrlKey(re) {
  return (req) => {
    const m = (req.originalUrl || '').match(re);
    return (m && m[1]) ? `t:${m[1].toLowerCase()}` : ipKeyGenerator(req.ip);
  };
}
const mkLimiter = (limit, keyGenerator) => rateLimit({
  windowMs: RL_WINDOW_MS, limit, standardHeaders: true, legacyHeaders: false, keyGenerator, handler: rl429,
});
// /webhook/* e /tenant/*: por tenant (id na URL). /admin/*: por IP.
const webhookLimiter = mkLimiter(Number(process.env.RL_WEBHOOK || 100), tenantUrlKey(/\/webhook\/[^/]+\/([0-9a-f-]{36})/i));
const tenantLimiter  = mkLimiter(Number(process.env.RL_TENANT  || 500), tenantUrlKey(/\/tenant\/([0-9a-f-]{36})/i));
const adminLimiter   = mkLimiter(Number(process.env.RL_ADMIN   || 200), (req) => ipKeyGenerator(req.ip));

// Webhook da Meta (Lead Ads / IG DM / Messenger) — fora do limiter keyed-por-tenant
// (a URL /webhook/meta não tem tenant na path). Verificação + log por enquanto.
app.use('/webhook', require('./routes/webhook-meta'));

// Webhooks de provedores externos (Z-API / Evolution API).
app.use('/webhook', webhookLimiter, webhookRouter);

// API administrativa (protegida por JWT + role PLATFORM_ADMIN).
app.use('/admin', adminLimiter, adminRouter);

// Self-service da unidade (protegido por JWT + requireTenantRole).
app.use('/tenant', tenantLimiter, tenantRouter);

// ADR-016 — arquivos de mídia recebidos (autenticado por tenant).
app.use('/media', require('./routes/media'));

// Só sobe o listener quando executado diretamente (não nos testes que
// importam o app).
if (require.main === module) {
  const server = app.listen(PORT, () => {
    logger.info('server.started', { port: Number(PORT) });
  });

  // E9-03: cron diário de expiração de trial — 06:00 America/Sao_Paulo.
  const cron = require('node-cron');
  const { runTrialExpiry } = require('./jobs/trialExpiry');
  cron.schedule(
    '0 6 * * *',
    () => {
      runTrialExpiry()
        .then((s) => logger.info('cron.trial_expiry.done', s))
        .catch((e) => logger.error('cron.trial_expiry.error', { error: e.message }));
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // LGPD (item 4): retenção automática — 1º dia do mês, 03:00 America/Sao_Paulo.
  const { runDataRetention } = require('./jobs/dataRetention');
  cron.schedule(
    '0 3 1 * *',
    () => {
      runDataRetention()
        .then((s) => logger.info('cron.data_retention.done', s))
        .catch((e) => logger.error('cron.data_retention.error', { error: e.message }));
    },
    { timezone: 'America/Sao_Paulo' }
  );

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
