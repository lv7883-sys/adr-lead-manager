'use strict';

// SubscriptionService — máquina de estado de assinatura, billing-agnóstica
// (ADR-004, Decisão 5; ADR-005 não altera). Manual hoje e webhook Stripe
// amanhã chamam a MESMA API. Toda transição grava em subscription_events
// (append-only) e respeita idempotência por idempotencyKey.

const { pool, withTenant } = require('./db');
const redisClient = require('./redisClient');
const logger = require('./logger');

const addDays = (n) => new Date(Date.now() + n * 86400000);
const addMonths = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d;
};

async function getDefaultTrialDays() {
  const { rows } = await pool.query('SELECT default_trial_days FROM platform_settings LIMIT 1');
  return rows[0]?.default_trial_days ?? 7;
}

async function getSubscription({ tenantId, feature }) {
  return withTenant(tenantId, (c) =>
    c.query('SELECT * FROM tenant_subscriptions WHERE tenant_id = $1 AND feature = $2', [
      tenantId,
      feature,
    ])
  ).then((r) => r.rows[0] || null);
}

/**
 * Núcleo da transição: idempotência -> aplica estado -> grava evento.
 * `fields` são colunas adicionais a setar (chaves controladas internamente,
 * nunca entrada do usuário). Tudo numa transação sob o contexto RLS do tenant.
 */
async function applyTransition({
  tenantId,
  feature,
  type,
  toStatus,
  source = 'MANUAL',
  actor = null,
  externalRef = null,
  idempotencyKey = null,
  metadata = null,
  allowCreate = false,
  fields = {},
}) {
  const result = await withTenant(tenantId, async (c) => {
    // Idempotência: a mesma chave não re-aplica nem duplica evento.
    if (idempotencyKey) {
      const dup = await c.query(
        'SELECT 1 FROM subscription_events WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      if (dup.rowCount > 0) {
        const sub = (
          await c.query(
            'SELECT * FROM tenant_subscriptions WHERE tenant_id = $1 AND feature = $2',
            [tenantId, feature]
          )
        ).rows[0] || null;
        return { idempotent: true, subscription: sub };
      }
    }

    const cur = (
      await c.query(
        'SELECT * FROM tenant_subscriptions WHERE tenant_id = $1 AND feature = $2 FOR UPDATE',
        [tenantId, feature]
      )
    ).rows[0] || null;
    const fromStatus = cur ? cur.status : null;

    let sub;
    if (!cur) {
      if (!allowCreate) throw new Error(`assinatura inexistente para ${feature}`);
      sub = (
        await c.query(
          `INSERT INTO tenant_subscriptions
             (tenant_id, feature, status, trial_started_at, valid_until, grace_until,
              converted_at, canceled_at, stripe_subscription_id, stripe_price_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            tenantId,
            feature,
            toStatus,
            fields.trial_started_at ?? null,
            fields.valid_until ?? null,
            fields.grace_until ?? null,
            fields.converted_at ?? null,
            fields.canceled_at ?? null,
            fields.stripe_subscription_id ?? null,
            fields.stripe_price_id ?? null,
          ]
        )
      ).rows[0];
    } else {
      const sets = ['status = $3', 'updated_at = now()'];
      const vals = [tenantId, feature, toStatus];
      let i = 4;
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = $${i}`);
        vals.push(v);
        i += 1;
      }
      sub = (
        await c.query(
          `UPDATE tenant_subscriptions SET ${sets.join(', ')}
            WHERE tenant_id = $1 AND feature = $2 RETURNING *`,
          vals
        )
      ).rows[0];
    }

    await c.query(
      `INSERT INTO subscription_events
         (tenant_id, feature, type, from_status, to_status, source, actor, external_ref, idempotency_key, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        tenantId,
        feature,
        type,
        fromStatus,
        toStatus,
        source,
        actor,
        externalRef,
        idempotencyKey,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );

    logger.info('subscription.transition', {
      tenant_id: tenantId,
      feature,
      type,
      from_status: fromStatus,
      to_status: toStatus,
      source,
      actor,
    });
    return { idempotent: false, subscription: sub };
  });

  // E9-05: invalida o cache de gating após uma mudança real de status
  // (idempotente = no-op, não precisa invalidar). Chave por feature.
  if (!result.idempotent) {
    await redisClient.invalidateSubStatus(tenantId, feature.toLowerCase());
  }
  return result;
}

// ---------------- API pública (máquina de estado) ----------------

async function startTrial({ tenantId, feature, days, actor, idempotencyKey }) {
  const trialDays = days ?? (await getDefaultTrialDays());
  return applyTransition({
    tenantId,
    feature,
    type: 'TRIAL_STARTED',
    toStatus: 'TRIALING',
    source: 'MANUAL',
    actor,
    idempotencyKey,
    allowCreate: true,
    fields: {
      trial_started_at: new Date(),
      valid_until: addDays(trialDays),
      grace_until: null,
      converted_at: null,
      canceled_at: null,
    },
  });
}

async function activate({ tenantId, feature, source = 'MANUAL', externalRef, actor, idempotencyKey }) {
  const fields = { converted_at: new Date(), valid_until: addMonths(1), canceled_at: null };
  if (source === 'STRIPE' && externalRef) fields.stripe_subscription_id = externalRef;
  return applyTransition({
    tenantId,
    feature,
    type: 'ACTIVATED',
    toStatus: 'ACTIVE',
    source,
    externalRef,
    actor,
    idempotencyKey,
    allowCreate: true,
    fields,
  });
}

async function suspend({ tenantId, feature, source = 'MANUAL', actor, idempotencyKey, metadata }) {
  return applyTransition({
    tenantId, feature, type: 'SUSPENDED', toStatus: 'SUSPENDED', source, actor, idempotencyKey, metadata,
  });
}

async function reactivate({ tenantId, feature, source = 'MANUAL', actor, idempotencyKey }) {
  return applyTransition({
    tenantId, feature, type: 'REACTIVATED', toStatus: 'ACTIVE', source, actor, idempotencyKey,
    fields: { valid_until: addMonths(1) },
  });
}

async function cancel({ tenantId, feature, source = 'MANUAL', actor, idempotencyKey, metadata }) {
  return applyTransition({
    tenantId, feature, type: 'CANCELED', toStatus: 'CANCELED', source, actor, idempotencyKey, metadata,
    fields: { canceled_at: new Date() },
  });
}

// Tipicamente disparado pelo cron de expiração (E9-03) -> source SYSTEM.
async function expire({ tenantId, feature, source = 'SYSTEM', actor = 'system', idempotencyKey }) {
  return applyTransition({
    tenantId, feature, type: 'EXPIRED', toStatus: 'EXPIRED', source, actor, idempotencyKey,
  });
}

module.exports = {
  startTrial,
  activate,
  suspend,
  reactivate,
  cancel,
  expire,
  getSubscription,
  getDefaultTrialDays,
};
