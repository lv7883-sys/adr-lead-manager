'use strict';
//
// backfill-professores.js — roda SÓ a reconciliação do professor canônico (person + external_ref
// + fechamento de professor_person_id) p/ todos os tenants ativos, SEM o scrape pesado do cadastro.
// Idempotente; use p/ fechar o gap na hora (o cron diário já roda isto no fim do daily-sync).
//
//   docker exec adr-lead-manager node src/cadastro/backfill-professores.js
//
const { pool } = require('../db');
const logger = require('../logger');
const { runProfessoresAllTenants } = require('./daily-sync-cadastro');

async function main() {
  const { rows: tenants } = await pool.query('SELECT tenant_id FROM tenants_active()');
  const out = await runProfessoresAllTenants(tenants);
  logger.info('backfill_professores.done', out);
  console.log('[backfill-professores]',
    `tenants=${out.tenants} pessoas_novas=${out.pessoas_novas} refs_novos=${out.refs_novos} contratos_fechados=${out.contratos_fechados}`);
  return out;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { logger.error('backfill_professores.fatal', { error: e.message }); process.exit(1); });
}

module.exports = { main };
