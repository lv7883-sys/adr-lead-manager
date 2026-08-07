'use strict';
/*
 * deploy/wa-sync-once.js — RECONEXÃO: força o backfill do histórico do WhatsApp AGORA, uma vez,
 * sem esperar o cron (a cada 3 min) nem uma reconexão. Puxa da Evolution (findMessages) as
 * mensagens trocadas em outro aparelho durante uma queda e mescla em Leads + Caixa de Entrada.
 * Idempotente (dedup por external_message_id) e seguro (só histórico: não roda funil/IA).
 *
 * UM tenant (deep = TODAS as conversas, HISTÓRICO INTEIRO de cada uma):
 *   TENANT_ID=<uuid> node deploy/wa-sync-once.js
 * TODOS os tenants ativos (mesmo ciclo do cron, mas na hora):
 *   node deploy/wa-sync-once.js --all
 */
const { pool } = require('../src/db');
const waSync = require('../src/waSync');
const TENANT_ID = process.env.TENANT_ID || null;
const ALL = process.argv.includes('--all');

(async () => {
  try {
    if (ALL) {
      const r = await waSync.syncReconnections();
      console.log('sync (todos):', JSON.stringify(r));
    } else if (TENANT_ID) {
      const r = await waSync.backfillTenant(TENANT_ID, { deep: true });
      console.log('backfill:', JSON.stringify(r));
    } else {
      console.error('Informe TENANT_ID=<uuid> ou use --all');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('ERRO:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
