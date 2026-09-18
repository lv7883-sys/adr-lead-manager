'use strict';
//
// daily-sync-experimentais.js — RUNNER do cron das AULAS EXPERIMENTAIS da Extranet (migr 129; molde
// daily-sync-leads). Multi-tenant: itera tenants ativos com extranet_lead_mode != 'off' (o MESMO
// kill-switch do sync de leads — é a mesma Extranet e o mesmo propósito) e binding SCRAPE_EXTRANET.
//
// INVOCAÇÃO:
//   rotina diária (cron do host):   docker exec adr-lead-manager node /app/src/cadastro/daily-sync-experimentais.js
//   carga inicial / reprocessar:    ... daily-sync-experimentais.js --desde=2026-06
//                                    (EXTRANET_EXP_MAX_DETALHES=200 para caber num run só)
//
// JANELA DIÁRIA: mês-2 .. mês+1. Mês+1 pega o que já está marcado para o mês que vem; os dois
// anteriores pegam a aula 'Realizada' que vira 'Realizada com matrícula posterior' quando a pessoa
// matricula semanas depois. Cada página mensal custa ~25s de fila; o detalhe só é lido para aula
// nova ou que mudou de rótulo.
//
const { pool, withTenant } = require('../db');
const logger = require('../logger');
const adapter = require('./adapters/valinhos-experimentais');
const sync = require('./sync-experimentais');

const KIND = 'SCRAPE_EXTRANET_EXPERIMENTAIS';   // discrimina no cadastro_sync_log (072)

// competência em São Paulo, deslocada k meses
function compSP(k = 0, d = new Date()) {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' })
    .format(d).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + k, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}
function mesesDesde(desde) {
  const out = []; const fim = compSP(1);
  let [y, m] = desde.split('-').map(Number);
  for (let i = 0; i < 36; i++) {
    const c = `${y}-${String(m).padStart(2, '0')}`;
    out.push(c);
    if (c >= fim) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function registrarExecucao(tenantId, { status, startedAt, stats, error }) {
  const finished = new Date();
  await withTenant(tenantId, (c) => c.query(
    `INSERT INTO lead_manager.cadastro_sync_log (tenant_id, kind, status, started_at, finished_at, duration_ms, stats, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [tenantId, KIND, status, startedAt, finished, finished - startedAt, stats ? JSON.stringify(stats) : null, error || null]),
  ).catch((e) => logger.error('extranet_exp_sync.log_error', { tenant_id: tenantId, error: e.message }));
}

async function modo(tenantId) {
  try {
    const r = await withTenant(tenantId, (c) => c.query(
      'SELECT extranet_lead_mode FROM lead_manager.tenant_lead_config WHERE tenant_id=$1', [tenantId]));
    return r.rows[0]?.extranet_lead_mode || 'off';
  } catch { return 'off'; }
}

// Processa UM binding. Nunca lança.
async function processBinding(tenantId, binding, meses) {
  const startedAt = new Date();
  try {
    const snapshot = await adapter.coletar(binding, {
      meses,
      // registra o que a grade mostrou e devolve o que precisa de detalhe — transação curta, entre
      // uma busca e outra na Extranet
      precisaDetalhe: (aulas) => withTenant(tenantId, async (c) => {
        await sync.registrarAulas(c, tenantId, aulas);
        return sync.idsParaDetalhar(c, tenantId, aulas.map((a) => a.aulaId));
      }),
      // grava cada detalhe na hora (transação curta por aula) — ver o adapter
      aoDetalhar: (d) => withTenant(tenantId, (c) => sync.aplicarDetalhes(c, tenantId, [d])),
    });
    const stats = await withTenant(tenantId, async (c) => {
      // os detalhes já foram gravados um a um pelo aoDetalhar; aqui só a ligação e o retrato
      const detalhadas = snapshot.detalhes.length;
      const ligadas = await sync.ligarLeads(c, tenantId);
      return { ...snapshot.stats, meses_lidos: meses, detalhadas, ligadas_agora: ligadas, espelho: await sync.resumo(c, tenantId) };
    });
    await registrarExecucao(tenantId, { status: 'OK', startedAt, stats });
    logger.info('extranet_exp_sync.ok', { tenant_id: tenantId, binding_id: binding.id, stats });
    return { binding: binding.id, status: 'OK', stats };
  } catch (e) {
    await registrarExecucao(tenantId, { status: 'ERROR', startedAt, error: e.message });
    logger.error('extranet_exp_sync.error', { tenant_id: tenantId, binding_id: binding.id, error: e.message });
    return { binding: binding.id, status: 'ERROR', error: e.message };
  }
}

async function runExperimentaisSync({ desde } = {}) {
  const meses = desde ? mesesDesde(desde) : [compSP(-2), compSP(-1), compSP(0), compSP(1)];
  const summary = { meses, tenants: 0, bindings: 0, ok: 0, error: 0, skipped_off: 0, results: [] };
  const { rows: tenants } = await pool.query('SELECT tenant_id FROM tenants_active()');
  summary.tenants = tenants.length;
  for (const { tenant_id: tenantId } of tenants) {
    if ((await modo(tenantId)) === 'off') { summary.skipped_off++; continue; }
    let bindings;
    try {
      bindings = (await withTenant(tenantId, (c) => c.query(
        `SELECT id, kind, config FROM resources.resource_source_binding
          WHERE status='ACTIVE' AND kind='SCRAPE_EXTRANET' ORDER BY created_at`))).rows;
    } catch (e) { logger.error('extranet_exp_sync.list_error', { tenant_id: tenantId, error: e.message }); continue; }
    for (const binding of bindings) {
      summary.bindings++;
      const res = await processBinding(tenantId, binding, meses);
      summary.results.push({ tenant: tenantId, ...res });
      summary[res.status === 'OK' ? 'ok' : 'error']++;
    }
  }
  logger.info('extranet_exp_sync.done', summary);
  return summary;
}

module.exports = { runExperimentaisSync, processBinding, compSP, mesesDesde };

if (require.main === module) {
  const arg = process.argv.find((a) => a.startsWith('--desde='));
  const desde = arg ? arg.split('=')[1] : null;
  if (desde && !/^\d{4}-\d{2}$/.test(desde)) { console.error('--desde=YYYY-MM'); process.exit(2); }
  runExperimentaisSync({ desde }).then((s) => process.exit(s.error ? 1 : 0))
    .catch((e) => { logger.error('extranet_exp_sync.fatal', { error: e.message }); process.exit(1); });
}
