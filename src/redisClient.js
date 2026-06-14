'use strict';

const Redis = require('ioredis');
const logger = require('./logger');

// Conexão única e resiliente. lazyConnect evita derrubar o boot se o Redis
// estiver indisponível — o histórico simplesmente cai no fallback PostgreSQL.
const redis = new Redis(process.env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
});
redis.on('error', (err) => logger.warn('redis.error', { error: err.message }));

let connecting = null;
async function ensureConnected() {
  if (redis.status === 'ready') return;
  if (!connecting) {
    connecting = redis.connect().catch((err) => {
      connecting = null;
      throw err;
    });
  }
  await connecting;
}

// ---- Cache de gating de assinatura (E9-05; TTL 5min — padrão ADR-002) ----
const SUB_TTL_SECONDS = 5 * 60;
const subStatusKey = (tenantId, feature = 'lead_manager') => `sub:${tenantId}:${feature}`;

async function getCachedSubStatus(tenantId, feature = 'lead_manager') {
  try {
    await ensureConnected();
    return (await redis.get(subStatusKey(tenantId, feature))) || null;
  } catch (err) {
    logger.warn('redis.sub_get_failed', { tenant_id: tenantId, error: err.message });
    return null;
  }
}

async function setCachedSubStatus(tenantId, feature, value) {
  try {
    await ensureConnected();
    await redis.set(subStatusKey(tenantId, feature), value, 'EX', SUB_TTL_SECONDS);
  } catch (err) {
    logger.warn('redis.sub_set_failed', { tenant_id: tenantId, error: err.message });
  }
}

async function invalidateSubStatus(tenantId, feature = 'lead_manager') {
  try {
    await ensureConnected();
    await redis.del(subStatusKey(tenantId, feature));
  } catch (err) {
    logger.warn('redis.sub_del_failed', { tenant_id: tenantId, error: err.message });
  }
}

// ---- Cache genérico JSON (best-effort; ex.: sugestão de retomada, TTL 24h) ----
async function getCache(key) {
  try {
    await ensureConnected();
    const v = await redis.get(key);
    return v ? JSON.parse(v) : null;
  } catch (err) {
    logger.warn('redis.cache_get_failed', { key, error: err.message });
    return null;
  }
}
async function setCache(key, value, ttlSeconds) {
  try {
    await ensureConnected();
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn('redis.cache_set_failed', { key, error: err.message });
  }
}

module.exports = {
  redis,
  SUB_TTL_SECONDS,
  subStatusKey,
  getCachedSubStatus,
  setCachedSubStatus,
  invalidateSubStatus,
  getCache,
  setCache,
};
