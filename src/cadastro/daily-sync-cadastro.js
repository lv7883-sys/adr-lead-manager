'use strict';
//
// daily-sync-cadastro.js — RUNNER do cron de contratos/alunos (molde resources/daily-sync.js).
// Multi-tenant: itera tenants ativos com binding SCRAPE_EXTRANET (reusa o binding de recursos —
// mesma Extranet/creds). GENÉRICO: o conhecimento da Extranet vive no adapter (valinhos-contratos).
//
// INVOCAÇÃO (cron do HOST, Passo 2): docker exec adr-lead-manager node src/cadastro/daily-sync-cadastro.js
//
// DIFERENÇA-CHAVE vs. o sincronizador de recursos: aquele segura o advisory lock durante TODO o
// run (~24 fetches, rápido). Este é LONGO (~1.200 fetches) → NÃO segura o lock o run todo; o
// ADAPTER pega o lock POR FETCH e solta entre requests (clique humano tem prioridade). O sync
// (DB) roda FORA de qualquer lock de Extranet.
//
const { pool, withTenant } = require('../db');
const logger = require('../logger');
const valinhosContratos = require('./adapters/valinhos-contratos');
const { syncCadastro } = require('./sync-cadastro');

const MAX_DROP_FRAC = Number(process.env.CADASTRO_SAFEGUARD_MAX_DROP ?? 0.34);

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

// Alerta de OPS (molde do resource sync): log de alta visibilidade p/ o que humano resolve.
const _ALERT = new Set(['CREDENTIAL', 'SAFEGUARD', 'UNKNOWN']);
function notifyOpsHook({ tenantId, binding, kind, error }) {
  if (!_ALERT.has(kind)) return;
  logger.error('cadastro_sync.alert', { alert: true, actionable: kind === 'CREDENTIAL', tenant_id: tenantId, binding_id: binding.id, error_kind: kind, error });
}

// Contratos PRESENTES (não soft-deletados) deste tenant — base da salvaguarda.
async function currentCount(tenantId) {
  const r = await withTenant(tenantId, (c) => c.query(
    `SELECT count(*)::int AS n FROM lead_manager.service_account sa
       JOIN lead_manager.external_ref er ON er.entity_id=sa.id AND er.entity_kind='account'
            AND er.external_type='contrato' AND er.source='extranet'
      WHERE sa.tenant_id=$1 AND sa.fonte_ausente_em IS NULL`, [tenantId]));
  return r.rows[0].n;
}
function safeguard(snapshot, cur) {
  const n = snapshot.contratos.length;
  if (cur > 0 && n === 0) return { ok: false, reason: `snapshot vazio (0 contratos) vs ${cur} presentes` };
  const piso = Math.floor(cur * (1 - MAX_DROP_FRAC));
  if (cur > 0 && n < piso) return { ok: false, reason: `queda > ${Math.round(MAX_DROP_FRAC * 100)}%: ${n} no snapshot vs ${cur} presentes (piso ${piso})` };
  return { ok: true };
}

async function registrarExecucao(tenantId, binding, { status, startedAt, stats, error, errorKind }) {
  const finished = new Date();
  await withTenant(tenantId, (c) => c.query(
    `INSERT INTO lead_manager.cadastro_sync_log (tenant_id, kind, status, started_at, finished_at, duration_ms, stats, error, error_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [tenantId, binding.kind, status, startedAt, finished, finished - startedAt, stats ? JSON.stringify(stats) : null, error || null, errorKind || null]),
  ).catch((e) => logger.error('cadastro_sync.log_error', { tenant_id: tenantId, error: e.message }));
}

// Processa UM binding. Nunca lança.
async function processBinding(tenantId, binding) {
  const startedAt = new Date();
  try {
    // PRODUCE: o adapter fetcha (lock POR-FETCH + gap ≥25s, solto entre requests). Run longo.
    const snapshot = await valinhosContratos.produce(binding, { tenantId });
    // SALVAGUARDA antes de escrever
    const cur = await currentCount(tenantId);
    const sg = safeguard(snapshot, cur);
    if (!sg.ok) throw new SafeguardError(sg);
    // SYNC (DB, FORA de lock de Extranet)
    const stats = await withTenant(tenantId, (c) => syncCadastro(c, { tenantId, snapshot }));
    Object.assign(stats, snapshot.stats);
    await registrarExecucao(tenantId, binding, { status: 'OK', startedAt, stats });
    logger.info('cadastro_sync.ok', { tenant_id: tenantId, binding_id: binding.id, stats });
    return { binding: binding.id, status: 'OK', stats };
  } catch (e) {
    const errorKind = classifyError(e);
    const status = e.code === 'SAFEGUARD' ? 'SAFEGUARD' : 'ERROR';
    await registrarExecucao(tenantId, binding, { status, startedAt, error: e.message, errorKind });
    notifyOpsHook({ tenantId, binding, kind: errorKind, error: e.message });
    logger.error('cadastro_sync.error', { tenant_id: tenantId, binding_id: binding.id, error_kind: errorKind, error: e.message });
    return { binding: binding.id, status, errorKind, error: e.message };
  }
}

async function runDailySync() {
  const summary = { tenants: 0, bindings: 0, ok: 0, error: 0, results: [] };
  const { rows: tenants } = await pool.query('SELECT tenant_id FROM tenants_active()');
  summary.tenants = tenants.length;
  for (const { tenant_id: tenantId } of tenants) {
    let bindings;
    try {
      bindings = (await withTenant(tenantId, (c) => c.query(
        `SELECT id, kind, config FROM resources.resource_source_binding
          WHERE status='ACTIVE' AND kind='SCRAPE_EXTRANET' ORDER BY created_at`))).rows;
    } catch (e) { logger.error('cadastro_sync.list_error', { tenant_id: tenantId, error: e.message }); continue; }
    for (const binding of bindings) {
      summary.bindings++;
      const res = await processBinding(tenantId, binding);
      summary.results.push({ tenant: tenantId, ...res });
      summary[res.status === 'OK' ? 'ok' : 'error']++;
    }
  }
  logger.info('cadastro_sync.done', summary);
  return summary;
}

module.exports = { runDailySync, processBinding, classifyError, safeguard };

if (require.main === module) {
  runDailySync().then((s) => process.exit(s.error ? 1 : 0)).catch((e) => { logger.error('cadastro_sync.fatal', { error: e.message }); process.exit(1); });
}
