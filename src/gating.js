'use strict';

// E9-05 — gating de assinatura no caminho quente do webhook.
// Resolve se a feature LEAD_MANAGER do tenant está liberada para automação.
// Cache-aside no Redis (TTL 5min) para não bater no banco a cada mensagem.

const { withTenant } = require('./db');
const redisClient = require('./redisClient');

const FEATURE = 'LEAD_MANAGER';
const CACHE_FEATURE = 'lead_manager'; // chave: sub:{tenantId}:lead_manager

// Verdicts: 'active' | 'trialing' | 'blocked'.
// ACTIVE -> active; TRIALING com valid_until futuro -> trialing; resto -> blocked
// (GRACE, EXPIRED, SUSPENDED, CANCELED, TRIALING vencido, ausente).
function verdictFromRow(row) {
  if (!row) return 'blocked';
  if (row.status === 'ACTIVE') return 'active';
  if (row.status === 'TRIALING' && row.valid_until && new Date(row.valid_until) > new Date()) {
    return 'trialing';
  }
  return 'blocked';
}

function isAllowed(verdict) {
  return verdict === 'active' || verdict === 'trialing';
}

/**
 * Retorna { verdict, source }.
 *  - source 'cache' quando veio do Redis (não bateu no banco);
 *  - source 'db' quando reconstruiu do PostgreSQL (e repovoou o cache).
 */
async function resolveStatus(tenantId, deps = {}) {
  const redis = deps.redis || redisClient;

  const cached = await redis.getCachedSubStatus(tenantId, CACHE_FEATURE);
  if (cached) return { verdict: cached, source: 'cache' };

  const row = await withTenant(tenantId, (c) =>
    c.query(
      'SELECT status, valid_until FROM tenant_subscriptions WHERE tenant_id = $1 AND feature = $2',
      [tenantId, FEATURE]
    )
  ).then((r) => r.rows[0] || null);

  const verdict = verdictFromRow(row);
  await redis.setCachedSubStatus(tenantId, CACHE_FEATURE, verdict);
  return { verdict, source: 'db', dbStatus: row?.status ?? null };
}

module.exports = { resolveStatus, isAllowed, verdictFromRow, FEATURE, CACHE_FEATURE };
