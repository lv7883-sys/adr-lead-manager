'use strict';

// E9-03 — job diário de ciclo de vida do trial (ADR-004 §3).
//   TRIALING vencido            -> GRACE (enterGrace; grace_until = +grace_days)
//   GRACE vencido               -> EXPIRED -> SUSPENDED
//   TRIALING em D-3 / D-1        -> lembrete ao Leo (idempotente por marco)
// Idempotente por construção: linhas já transicionadas saem dos status
// elegíveis; lembretes são travados por reminder_sent(subscription_id, marco).

const { pool } = require('../db');
const svc = require('../subscriptionService');
const reminders = require('../reminders');
const logger = require('../logger');

const DAY = 86400000;
const daysUntil = (date, now) => Math.ceil((new Date(date).getTime() - now.getTime()) / DAY);

// Enumeração cross-tenant via função SECURITY DEFINER (bypass RLS controlado).
async function defaultLoadDue() {
  const { rows } = await pool.query('SELECT * FROM trial_lifecycle_due()');
  return rows;
}

// Trava idempotente: retorna true só na primeira vez (marco ainda não enviado).
async function recordReminderOnce(subscriptionId, marco) {
  const r = await pool.query(
    `INSERT INTO reminder_sent (subscription_id, marco)
     VALUES ($1, $2) ON CONFLICT (subscription_id, marco) DO NOTHING RETURNING id`,
    [subscriptionId, marco]
  );
  return r.rowCount > 0;
}

/**
 * Executa um ciclo do job. deps injetáveis para teste:
 *  - now: relógio de referência
 *  - loadDue: fonte das assinaturas elegíveis (default = função SECURITY DEFINER)
 *  - sendReminder: canal de lembrete (default = reminders.notifyTrialReminder)
 */
async function runTrialExpiry({
  now = new Date(),
  loadDue = defaultLoadDue,
  sendReminder = reminders.notifyTrialReminder,
} = {}) {
  const due = await loadDue();
  const summary = { graced: 0, suspended: 0, reminders: 0, scanned: due.length };

  for (const row of due) {
    const { subscription_id, tenant_id, feature, status, valid_until, grace_until } = row;
    try {
      if (status === 'TRIALING') {
        if (valid_until && new Date(valid_until) < now) {
          // Trial vencido -> entra em carência.
          await svc.enterGrace({ tenantId: tenant_id, feature });
          summary.graced += 1;
          if (await recordReminderOnce(subscription_id, 'EXPIRED')) {
            await sendReminder({ marco: 'EXPIRED', tenantId: tenant_id, feature, daysRemaining: 0, validUntil: valid_until });
            summary.reminders += 1;
          }
        } else if (valid_until) {
          // Lembretes D-3 / D-1.
          const d = daysUntil(valid_until, now);
          const marco = d <= 1 ? 'D-1' : d <= 3 ? 'D-3' : null;
          if (marco && (await recordReminderOnce(subscription_id, marco))) {
            await sendReminder({ marco, tenantId: tenant_id, feature, daysRemaining: d, validUntil: valid_until });
            summary.reminders += 1;
          }
        }
      } else if (status === 'GRACE') {
        if (grace_until && new Date(grace_until) < now) {
          // Carência vencida -> EXPIRED -> SUSPENDED.
          await svc.expire({ tenantId: tenant_id, feature, source: 'SYSTEM', actor: 'system' });
          await svc.suspend({ tenantId: tenant_id, feature, source: 'SYSTEM', actor: 'system' });
          summary.suspended += 1;
        }
      }
    } catch (err) {
      logger.error('cron.trial_expiry.row_error', { tenant_id, feature, error: err.message });
    }
  }

  logger.info('cron.trial_expiry.summary', summary);
  return summary;
}

module.exports = { runTrialExpiry, daysUntil };
