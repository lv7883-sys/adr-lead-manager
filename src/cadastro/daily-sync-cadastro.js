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
const { syncProfessores } = require('./sync-professores');
const { runContractConvert, loadConfig } = require('./contractConvert');

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
  // PROFESSOR CANÔNICO (105): garante person + external_ref(professor) p/ todo professor dos contratos
  // e fecha service_account.professor_person_id. Lê o estado PRESENTE (professor_nome enriquecido);
  // idempotente e independente do sync do binding ter tido sucesso. Nunca lança.
  summary.professores = await runProfessoresAllTenants(tenants);
  // CONVERTIDO POR CONTRATO (079): passa a base atualizada contra os leads ATIVOS. Independe do sync
  // ter tido sucesso (é idempotente e lê o que está presente); gated por contract_convert_mode. Nunca lança.
  summary.contractConvert = await runContractConvertAllTenants(tenants);
  logger.info('cadastro_sync.done', summary);
  return summary;
}

// Reconcilia o professor canônico de cada tenant ATIVO. Best-effort (nunca lança); por-tenant sob RLS.
async function runProfessoresAllTenants(tenants) {
  const out = { tenants: 0, pessoas_novas: 0, refs_novos: 0, contratos_fechados: 0, byTenant: [] };
  for (const { tenant_id: tenantId } of tenants) {
    try {
      const stats = await withTenant(tenantId, (c) => syncProfessores(c, { tenantId }));
      out.tenants++;
      out.pessoas_novas += stats.pessoas_novas || 0;
      out.refs_novos += stats.refs_novos || 0;
      out.contratos_fechados += stats.contratos_fechados || 0;
      out.byTenant.push({ tenant: tenantId, ...stats });
      logger.info('sync_professores.tenant_done', { tenant_id: tenantId, ...stats });
    } catch (e) {
      logger.error('sync_professores.tenant_error', { tenant_id: tenantId, error: e.message });
      out.byTenant.push({ tenant: tenantId, error: e.message });
    }
  }
  return out;
}

// Roda o casador contrato→lead para cada tenant ATIVO, conforme contract_convert_mode. Best-effort.
// FORWARD-LOOKING: contrato novo com lead vinculado só vira 'convertido' se a 1ª MENSAGEM do lead for
// anterior à matrícula (com a janela do tenant); senão vira 'cliente'. A régua vive no contractConvert.
async function runContractConvertAllTenants(tenants) {
  const out = { tenants: 0, convertido: 0, cliente: 0, queued: 0, byTenant: [] };
  for (const { tenant_id: tenantId } of tenants) {
    try {
      const r = await withTenant(tenantId, async (c) => {
        const cfg = await loadConfig(c, tenantId);
        if (cfg.mode === 'off') return { ...cfg, skipped: true };
        const stats = await runContractConvert(c, { tenantId, mode: cfg.mode, janelaDias: cfg.janelaDias });
        return { ...cfg, ...stats };
      });
      if (!r.skipped) {
        out.tenants++;
        out.convertido += r.convertido || 0; out.cliente += r.cliente || 0; out.queued += r.queued || 0;
      }
      out.byTenant.push({ tenant: tenantId, ...r });
      if (!r.skipped) logger.info('contract_convert.tenant_done', { tenant_id: tenantId, ...r });
    } catch (e) {
      logger.error('contract_convert.tenant_error', { tenant_id: tenantId, error: e.message });
      out.byTenant.push({ tenant: tenantId, error: e.message });
    }
  }
  return out;
}

module.exports = { runDailySync, processBinding, classifyError, safeguard, runContractConvertAllTenants, runProfessoresAllTenants };

if (require.main === module) {
  runDailySync().then((s) => process.exit(s.error ? 1 : 0)).catch((e) => { logger.error('cadastro_sync.fatal', { error: e.message }); process.exit(1); });
}
