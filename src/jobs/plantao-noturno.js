'use strict';
//
// plantao-noturno.js — RESUMO NOTURNO do plantão (ADR-040). 1×/dia: monta o MESMO resumo do
// card (resumoPlantao) por tenant e manda via hook de ops. Tudo verde → 1 linha curta/sistema;
// algo destoou → destaca só o que precisa de olho. Molde dos outros crons (host, TZ Brasília).
//
// INVOCAÇÃO: cron do HOST → docker exec adr-lead-manager node src/jobs/plantao-noturno.js
//
const { pool } = require('../db');
const logger = require('../logger');
const { resumoPlantao } = require('../plantao');

const ICON = { verde: '🟢', amarelo: '🟡', vermelho: '🔴' };

// Hook de ops (molde do notifyOpsHook do resource sync): HOJE = log de alta visibilidade
// (event 'plantao.resumo', alert:true quando algo destoa). PLUGAR canal real (WhatsApp ops /
// e-mail) do tenant aqui quando existir.
function notifyPlantao(tenantId, resumo) {
  const alerta = resumo.pior !== 'verde';
  const destoou = resumo.systems.filter((s) => s.status !== 'verde');
  const linhas = resumo.systems.map((s) => `${ICON[s.status]} ${s.label}: ${s.numeros}${s.detalhe ? ' — ' + s.detalhe : ''}`);
  logger[alerta ? 'error' : 'info']('plantao.resumo', {
    alert: alerta, tenant_id: tenantId, pior: resumo.pior,
    destaque: alerta ? destoou.map((s) => `${s.label}: ${s.detalhe || s.numeros}`).join(' | ') : 'tudo verde',
    linhas,
  });
  // TODO(ADR-040): enviar `linhas` (verde: curto; alerta: só o destaque) pro canal do tenant.
}

async function run() {
  const summary = { tenants: 0, alerta: 0 };
  const { rows } = await pool.query('SELECT tenant_id FROM tenants_active()');
  summary.tenants = rows.length;
  for (const { tenant_id: tenantId } of rows) {
    try {
      const r = await resumoPlantao(tenantId);
      if (r.pior !== 'verde') summary.alerta++;
      notifyPlantao(tenantId, r);
    } catch (e) { logger.error('plantao.tenant_erro', { tenant_id: tenantId, error: e.message }); }
  }
  logger.info('plantao.done', summary);
  return summary;
}

module.exports = { run, notifyPlantao };

if (require.main === module) {
  run().then(() => process.exit(0)).catch((e) => { logger.error('plantao.fatal', { error: e.message }); process.exit(1); });
}
