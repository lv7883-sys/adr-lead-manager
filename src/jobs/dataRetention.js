'use strict';

const { pool, withTenant } = require('../db');
const logger = require('../logger');
const { anonymizeLead } = require('../anonymize');

// LGPD (item 4) — retenção automática. Anonimiza leads "frios" cujo último
// contato passou do prazo de retenção. Prazo: tenants.retention_days, com
// fallback para platform_settings.default_retention_days (730). Cron mensal.
const RETENTION_STATUSES = ['COLD', 'LOST', 'OPTED_OUT'];

async function runDataRetention(deps = {}) {
  const q = deps.pool || pool;
  const wt = deps.withTenant || withTenant;

  const defaultDays =
    (await q.query('SELECT default_retention_days FROM platform_settings LIMIT 1')).rows[0]
      ?.default_retention_days ?? 730;
  const tenants = (await q.query('SELECT tenant_id, retention_days FROM tenants_for_retention()')).rows;

  let anonymized = 0;
  const perTenant = [];
  for (const t of tenants) {
    const days = t.retention_days != null ? t.retention_days : defaultDays;
    try {
      const n = await wt(t.tenant_id, async (c) => {
        const due = (
          await c.query(
            `SELECT l.id, l.phone
               FROM leads l
              WHERE l.status = ANY($1)
                AND (l.phone IS NULL OR l.phone NOT LIKE 'anonimizado_%')
                AND COALESCE(
                      (SELECT max(m.received_at) FROM messages m
                         JOIN conversations cv ON cv.id = m.conversation_id
                        WHERE cv.external_id = l.phone),
                      l.updated_at
                    ) < now() - make_interval(days => $2::int)`,
            [RETENTION_STATUSES, days]
          )
        ).rows;
        for (const lead of due) {
          await anonymizeLead(c, {
            tenantId: t.tenant_id, leadId: lead.id, phone: lead.phone,
            actor: 'system:retention', action: 'lead.retention_anonymize',
            details: { retention_days: days },
          });
        }
        return due.length;
      });
      anonymized += n;
      perTenant.push({ tenant_id: t.tenant_id, days, anonymized: n });
    } catch (err) {
      logger.error('retention.tenant_error', { tenant_id: t.tenant_id, error: err.message });
    }
  }
  logger.info('retention.done', { tenants: tenants.length, anonymized });
  return { tenants: tenants.length, anonymized, perTenant };
}

module.exports = { runDataRetention };
