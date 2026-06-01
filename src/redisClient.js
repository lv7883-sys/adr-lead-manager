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

const HISTORY_TTL_SECONDS = 72 * 60 * 60; // 72h
const historyKey = (conversationId) => `lm:conv:${conversationId}:messages`;

// Lê do Redis; em qualquer falha, retorna null para o chamador cair no PG.
async function getCachedHistory(conversationId) {
  try {
    await ensureConnected();
    const raw = await redis.get(historyKey(conversationId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn('redis.get_failed', { conversation_id: conversationId, error: err.message });
    return null;
  }
}

// Popula o cache (best-effort) após reconstruir o histórico do PG.
async function setCachedHistory(conversationId, messages) {
  try {
    await ensureConnected();
    await redis.set(historyKey(conversationId), JSON.stringify(messages), 'EX', HISTORY_TTL_SECONDS);
  } catch (err) {
    logger.warn('redis.set_failed', { conversation_id: conversationId, error: err.message });
  }
}

// Invalida o cache. Chamado SEMPRE depois de persistir no PostgreSQL.
async function invalidateHistory(conversationId) {
  try {
    await ensureConnected();
    await redis.del(historyKey(conversationId));
  } catch (err) {
    logger.warn('redis.del_failed', { conversation_id: conversationId, error: err.message });
  }
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

module.exports = {
  redis,
  historyKey,
  HISTORY_TTL_SECONDS,
  getCachedHistory,
  setCachedHistory,
  invalidateHistory,
  SUB_TTL_SECONDS,
  subStatusKey,
  getCachedSubStatus,
  setCachedSubStatus,
  invalidateSubStatus,
};
