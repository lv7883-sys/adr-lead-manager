'use strict';
//
// daily-sync-leads.js — RUNNER do cron de LEADS da Extranet (migr 102; molde daily-sync-cadastro).
// Multi-tenant: itera tenants ativos com extranet_lead_mode != 'off' e binding SCRAPE_EXTRANET
// (mesma Extranet/creds do cadastro). GENÉRICO: o conhecimento da Extranet vive no adapter
// (valinhos-leads); a régua de etapa vive no sync core (sync-extranet-leads).
//
// INVOCAÇÃO (cron do HOST, a cada 3h em horário comercial — deploy/crontab.extranet-leads-sync.txt):
//   docker exec adr-lead-manager node /app/src/cadastro/daily-sync-leads.js
//
// Run CURTO (1–3 fetches de lista) — ainda assim o adapter pega o advisory lock POR FETCH (clique
// humano e os outros syncs têm prioridade justa na fila). O sync (DB) roda FORA do lock de Extranet.
//
const { pool, withTenant } = require('../db');
const logger = require('../logger');
const valinhosLeads = require('./adapters/valinhos-leads');
const { syncExtranetLeads } = require('./sync-extranet-leads');

const MAX_DROP_FRAC = Number(process.env.EXTRANET_LEADS_SAFEGUARD_MAX_DROP ?? 0.34);

class SafeguardError extends Error { constructor(d) { super(`salvaguarda: ${d.reason}`); this.code = 'SAFEGUARD'; this.detail = d; } }

const _TRANSIENT = new Set(['BLOCK', 'TIMEOUT', 'SESSION_EXPIRED', 'NETWORK', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET']);
function classifyError(err) {
  const code = err && err.code;
  if (code === 'SAFEGUARD') return 'SAFEGUARD';
  if (code === 'CREDENTIAL') return 'CREDENTIAL';
  if (_TRANSIENT.has(code)) return 'TRANSIENT';
  const m = (err && err.message) || '';
  if (/credencial|login rejeit|não autenticada|send_login|cookie de unidade/i.test(m)) return 'CREDENTIAL';
  if (/lock timeout|cooldown|rate|429|fetch failed|network|socket|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|timeout de \d+s|expirad|redirect/i.test(m)) return 'TRANSIENT';
  return 'UNKNOWN';
}

const _ALERT = new Set(['CREDENTIAL', 'SAFEGUARD', 'UNKNOWN']);
function notifyOpsHook({ tenantId, binding, kind, error }) {
  if (!_ALERT.has(kind)) return;
  logger.error('extranet_leads_sync.alert', { alert: true, actionable: kind === 'CREDENTIAL', tenant_id: tenantId, binding_id: binding.id, error_kind: kind, error });
}

// Leads PRESENTES no espelho (não soft-deletados) DENTRO da janela do snapshot — base da
// salvaguarda de encolhimento. A lista PODE encolher legitimamente (exclusão de lead); a
// salvaguarda vira SAFEGUARD no log e um humano decide (re-rodar com
// EXTRANET_LEADS_SAFEGUARD_MAX_DROP maior). Nunca desligar.
async function currentCount(tenantId, windowStart) {
  const r = await withTenant(tenantId, (c) => c.query(
    `SELECT count(*)::int AS n FROM lead_manager.extranet_lead
      WHERE tenant_id=$1 AND fonte_ausente_em IS NULL
        AND ($2::date IS NULL OR data_cadastro IS NULL OR data_cadastro >= $2::date)`,
    [tenantId, windowStart || null]));
  return r.rows[0].n;
}
function safeguard(snapshot, cur) {
  const n = (snapshot.leads || []).length;
  if (cur > 0 && n === 0) return { ok: false, reason: `snapshot vazio (0 leads) vs ${cur} presentes` };
  const piso = Math.floor(cur * (1 - MAX_DROP_FRAC));
  if (cur > 0 && n < piso) return { ok: false, reason: `queda > ${Math.round(MAX_DROP_FRAC * 100)}%: ${n} no snapshot vs ${cur} presentes (piso ${piso})` };
  return { ok: true };
}

const KIND = 'SCRAPE_EXTRANET_LEADS';   // discrimina no cadastro_sync_log (072) — tabela reusada
async function registrarExecucao(tenantId, { status, startedAt, stats, error, errorKind }) {
  const finished = new Date();
  await withTenant(tenantId, (c) => c.query(
    `INSERT INTO lead_manager.cadastro_sync_log (tenant_id, kind, status, started_at, finished_at, duration_ms, stats, error, error_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [tenantId, KIND, status, startedAt, finished, finished - startedAt, stats ? JSON.stringify(stats) : null, error || null, errorKind || null]),
  ).catch((e) => logger.error('extranet_leads_sync.log_error', { tenant_id: tenantId, error: e.message }));
}

async function extranetLeadMode(tenantId) {
  try {
    const r = await withTenant(tenantId, (c) => c.query(
      'SELECT extranet_lead_mode FROM lead_manager.tenant_lead_config WHERE tenant_id=$1', [tenantId]));
    return r.rows[0]?.extranet_lead_mode || 'off';
  } catch { return 'off'; }   // migração 102 ausente → inerte (degrada elegante)
}

// Processa UM binding. Nunca lança.
async function processBinding(tenantId, binding, mode) {
  const startedAt = new Date();
  try {
    const snapshot = await valinhosLeads.produce(binding, { tenantId });
    const cur = await currentCount(tenantId, snapshot.windowStart);
    const sg = safeguard(snapshot, cur);
    if (!sg.ok) throw new SafeguardError(sg);
    const stats = await withTenant(tenantId, (c) => syncExtranetLeads(c, { tenantId, snapshot, mode }));
    Object.assign(stats, snapshot.stats, { mode });
    await registrarExecucao(tenantId, { status: 'OK', startedAt, stats });
    logger.info('extranet_leads_sync.ok', { tenant_id: tenantId, binding_id: binding.id, stats });
    return { binding: binding.id, status: 'OK', stats };
  } catch (e) {
    const errorKind = classifyError(e);
    const status = e.code === 'SAFEGUARD' ? 'SAFEGUARD' : 'ERROR';
    await registrarExecucao(tenantId, { status, startedAt, error: e.message, errorKind });
    notifyOpsHook({ tenantId, binding, kind: errorKind, error: e.message });
    logger.error('extranet_leads_sync.error', { tenant_id: tenantId, binding_id: binding.id, error_kind: errorKind, error: e.message });
    return { binding: binding.id, status, errorKind, error: e.message };
  }
}

async function runLeadsSync() {
  const summary = { tenants: 0, bindings: 0, ok: 0, error: 0, skipped_off: 0, results: [] };
  const { rows: tenants } = await pool.query('SELECT tenant_id FROM tenants_active()');
  summary.tenants = tenants.length;
  for (const { tenant_id: tenantId } of tenants) {
    const mode = await extranetLeadMode(tenantId);
    if (mode === 'off') { summary.skipped_off++; continue; }
    let bindings;
    try {
      bindings = (await withTenant(tenantId, (c) => c.query(
        `SELECT id, kind, config FROM resources.resource_source_binding
          WHERE status='ACTIVE' AND kind='SCRAPE_EXTRANET' ORDER BY created_at`))).rows;
    } catch (e) { logger.error('extranet_leads_sync.list_error', { tenant_id: tenantId, error: e.message }); continue; }
    for (const binding of bindings) {
      summary.bindings++;
      const res = await processBinding(tenantId, binding, mode);
      summary.results.push({ tenant: tenantId, ...res });
      summary[res.status === 'OK' ? 'ok' : 'error']++;
    }
  }
  logger.info('extranet_leads_sync.done', summary);
  return summary;
}

module.exports = { runLeadsSync, processBinding, classifyError, safeguard };

if (require.main === module) {
  runLeadsSync().then((s) => process.exit(s.error ? 1 : 0)).catch((e) => { logger.error('extranet_leads_sync.fatal', { error: e.message }); process.exit(1); });
}
