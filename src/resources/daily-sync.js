'use strict';

// daily-sync.js — RUNNER do Sincronizador de Recursos (ADR-026 §2.4). GENÉRICO e
// AGNÓSTICO DE FONTE: despacha por `kind` via adapters/index (registry). Só os adapters
// são específicos; lock, log, safeguard e cron são infra genérica (ver memória
// scraping-valinhos-only-principio).
//
// INVOCAÇÃO: cron do HOST (Passo 6) →
//   docker exec adr-lead-manager node src/resources/daily-sync.js
//
// POR BINDING (cadence=daily, status=ACTIVE):
//   pega pg_advisory_lock → produce(snapshot) → valida → SALVAGUARDA → upsert idempotente
//   (core, soft-delete) → solta lock. Grava resource_sync_log + saúde no binding. Um
//   binding que falha NÃO derruba os outros (try/catch por binding).

const os = require('os');
const fs = require('fs');
const path = require('path');

const { pool, withTenant } = require('../db');
const logger = require('../logger');
const { withExtranetLock } = require('./extranet-lock');
const { syncResources } = require('./sync');
const { validateSnapshot } = require('./snapshot');
const adapters = require('./adapters');

// Salvaguarda: aborta o upsert se o snapshot vier suspeitosamente MENOR que o estado
// atual (parse quebrado / muro de login passando batido). Crescer é livre; encolher além
// desta fração dispara parada. Configurável; default = não perder mais de 1/3.
const MAX_DROP_FRAC = Number(process.env.RESOURCES_SAFEGUARD_MAX_DROP ?? 0.34);
// Teto de espera pela aquisição do lock (o outro app pode estar acessando a Extranet).
const LOCK_TIMEOUT_MS = Number(process.env.RESOURCES_LOCK_TIMEOUT_MS ?? 180000);

class SafeguardError extends Error {
  constructor(detail) { super(`salvaguarda: ${detail.reason}`); this.code = 'SAFEGUARD'; this.detail = detail; }
}

// Classifica a falha p/ VISIBILIDADE (Passo 4): distingue o que um humano precisa
// resolver do que se auto-resolve. Usa err.code (tipado na FONTE, extranet-client) e cai
// p/ heurística de mensagem em erros de fora do adapter (lock timeout / rede).
//   CREDENTIAL → login rejeitado: humano resolve (trocar senha no binding).
//   TRANSIENT  → 429/Extranet fora/timeout/rede/lock: se auto-resolve no próximo run.
//   SAFEGUARD  → fonte devolveu pouco demais: humano confere antes de confiar.
//   UNKNOWN    → não classificado.
const _TRANSIENT_CODES = new Set([
  'BLOCK', 'TIMEOUT', 'SESSION_EXPIRED', 'NETWORK',
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET',
]);
function classifyError(err) {
  const code = err && err.code;
  if (code === 'SAFEGUARD') return 'SAFEGUARD';
  if (code === 'CREDENTIAL') return 'CREDENTIAL';
  if (_TRANSIENT_CODES.has(code)) return 'TRANSIENT';
  const m = (err && err.message) || '';
  if (/lock timeout|canceling statement due to lock/i.test(m)) return 'TRANSIENT';
  if (/fetch failed|network|socket|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(m)) return 'TRANSIENT';
  return 'UNKNOWN';
}

// Gancho de ALERTA. Hoje o repo NÃO tem canal de alerta de OPS (ADR-020 = leads
// silenciosos; notify.js = lead p/ recepção — audiência errada). Então o erro ACIONÁVEL
// por humano vira um log de ALTA VISIBILIDADE (event 'resources_sync.alert', flag
// alert:true) — greppável/monitorável já. TRANSIENT não alerta (se auto-resolve).
// PLUGAR aqui um canal real (WhatsApp ops / e-mail / Slack) quando existir.
const _ALERT_KINDS = new Set(['CREDENTIAL', 'SAFEGUARD', 'UNKNOWN']);
function notifyOpsHook({ tenantId, binding, kind, error }) {
  if (!_ALERT_KINDS.has(kind)) return;
  logger.error('resources_sync.alert', {
    alert: true, actionable: kind === 'CREDENTIAL',
    tenant_id: tenantId, binding_id: binding.id, error_kind: kind, error,
  });
  // TODO(ADR-026 §2.4): plugar canal de alerta de ops quando o repo tiver um.
}

// Contagens atuais (ativas) deste binding — base da salvaguarda.
async function currentCounts(tenantId, bindingId) {
  const r = await withTenant(tenantId, (c) => c.query(
    `SELECT count(*) FILTER (WHERE active)::int AS resources_active,
            (SELECT count(*)::int FROM resources.capability          WHERE tenant_id=$1 AND source_binding_id=$2) AS capabilities,
            (SELECT count(*)::int FROM resources.resource_availability WHERE tenant_id=$1 AND source_binding_id=$2) AS availability
       FROM resources.resource WHERE tenant_id=$1 AND source_binding_id=$2`,
    [tenantId, bindingId]));
  return r.rows[0];
}

function safeguard(snapshot, cur) {
  const snapRes = snapshot.resources.length;
  if (cur.resources_active > 0 && snapRes === 0) {
    return { ok: false, reason: `snapshot vazio (0 recursos) vs ${cur.resources_active} ativos no banco`, snapRes, cur };
  }
  const piso = Math.floor(cur.resources_active * (1 - MAX_DROP_FRAC));
  if (cur.resources_active > 0 && snapRes < piso) {
    return { ok: false, reason: `queda > ${Math.round(MAX_DROP_FRAC * 100)}%: ${snapRes} recursos no snapshot vs ${cur.resources_active} ativos (piso ${piso})`, snapRes, cur };
  }
  return { ok: true, snapRes, cur };
}

// Grava 1 linha no histórico + atualiza saúde do binding. Best-effort no log; a saúde
// do binding é o que o dashboard futuro lê (Passo 4).
async function registrarExecucao(tenantId, binding, { status, startedAt, stats, error, errorKind }) {
  const finished = new Date();
  const durationMs = finished - startedAt;
  await withTenant(tenantId, (c) => c.query(
    `INSERT INTO resources.resource_sync_log
       (tenant_id, source_binding_id, kind, status, started_at, finished_at, duration_ms, stats, error, error_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    [tenantId, binding.id, binding.kind, status, startedAt, finished, durationMs,
     stats ? JSON.stringify(stats) : null, error || null, errorKind || null]),
  ).catch((e) => logger.error('resources_sync.log_error', { tenant_id: tenantId, binding_id: binding.id, error: e.message }));

  await withTenant(tenantId, (c) => c.query(
    `UPDATE resources.resource_source_binding
        SET last_sync_at=$3, last_sync_status=$4, last_error=$5, last_error_kind=$6, updated_at=now()
      WHERE id=$2 AND tenant_id=$1`,
    [tenantId, binding.id, finished, status,
     status === 'ERROR' ? (error || 'erro') : null,
     status === 'ERROR' ? (errorKind || 'UNKNOWN') : null]),
  ).catch((e) => logger.error('resources_sync.binding_health_error', { tenant_id: tenantId, binding_id: binding.id, error: e.message }));
}

// Processa UM binding. Nunca lança — devolve o resultado e isola a falha.
async function processBinding(tenantId, binding) {
  const startedAt = new Date();
  const adapter = adapters.forKind(binding.kind);
  if (!adapter) {
    const error = `kind sem adapter: ${binding.kind} (suportado hoje: SCRAPE_EXTRANET)`;
    await registrarExecucao(tenantId, binding, { status: 'SKIPPED', startedAt, error });
    logger.warn('resources_sync.skipped', { tenant_id: tenantId, binding_id: binding.id, kind: binding.kind });
    return { binding: binding.id, status: 'SKIPPED', error };
  }

  let destDir;
  try {
    const stats = await withExtranetLock(async () => {
      destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resync-'));
      const snapshot = await adapter.produce(binding, { destDir }); // login + fetch (SOB o lock)
      validateSnapshot(snapshot);

      const cur = await currentCounts(tenantId, binding.id);
      const sg = safeguard(snapshot, cur);
      if (!sg.ok) throw new SafeguardError(sg);                     // PARA antes de escrever

      return withTenant(tenantId, (c) =>
        syncResources(c, { tenantId, sourceBindingId: binding.id, snapshot }));
    }, { timeoutMs: LOCK_TIMEOUT_MS });

    await registrarExecucao(tenantId, binding, { status: 'OK', startedAt, stats });
    logger.info('resources_sync.ok', { tenant_id: tenantId, binding_id: binding.id, kind: binding.kind, stats });
    return { binding: binding.id, status: 'OK', stats };
  } catch (e) {
    const errorKind = classifyError(e);
    await registrarExecucao(tenantId, binding, { status: 'ERROR', startedAt, error: e.message, errorKind });
    notifyOpsHook({ tenantId, binding, kind: errorKind, error: e.message });
    logger.error('resources_sync.error', { tenant_id: tenantId, binding_id: binding.id, kind: binding.kind, error_kind: errorKind, error: e.message });
    return { binding: binding.id, status: 'ERROR', errorKind, error: e.message };
  } finally {
    if (destDir) fs.rm(destDir, { recursive: true, force: true }, () => {});
  }
}

// Um ciclo em todos os tenants ativos com binding cadence=daily/status=ACTIVE.
async function runDailySync() {
  const summary = { tenants: 0, bindings: 0, ok: 0, error: 0, skipped: 0, results: [] };
  const { rows: tenants } = await pool.query('SELECT tenant_id FROM tenants_active()');
  summary.tenants = tenants.length;

  for (const { tenant_id: tenantId } of tenants) {
    let bindings;
    try {
      bindings = (await withTenant(tenantId, (c) => c.query(
        `SELECT id, kind, config FROM resources.resource_source_binding
          WHERE status='ACTIVE' AND config->>'cadence'='daily'
          ORDER BY created_at`))).rows;
    } catch (e) {
      logger.error('resources_sync.list_error', { tenant_id: tenantId, error: e.message });
      continue;
    }
    for (const binding of bindings) {
      summary.bindings++;
      const res = await processBinding(tenantId, binding); // isolado: falha não derruba os outros
      summary.results.push({ tenant: tenantId, ...res });
      summary[res.status === 'OK' ? 'ok' : res.status === 'ERROR' ? 'error' : 'skipped']++;
    }
  }
  logger.info('resources_sync.done', { tenants: summary.tenants, bindings: summary.bindings, ok: summary.ok, error: summary.error, skipped: summary.skipped });
  return summary;
}

module.exports = { runDailySync, processBinding, safeguard, classifyError };

// Entrypoint do cron do host.
if (require.main === module) {
  runDailySync()
    .then((s) => { console.log(JSON.stringify(s)); return pool.end(); })
    .then(() => process.exit(0))
    .catch((e) => { console.error('resources_sync.fatal', e.message); process.exit(1); });
}
