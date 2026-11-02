'use strict';
/*
 * deploy/wa-sync-once.js — RECONEXÃO: força o backfill do histórico do WhatsApp AGORA, uma vez,
 * sem esperar o cron (a cada 3 min) nem uma reconexão. Puxa da Evolution (findMessages) as
 * mensagens trocadas em outro aparelho durante uma queda e mescla em Leads + Caixa de Entrada.
 * Idempotente (dedup por external_message_id) e seguro (só histórico: não roda funil/IA).
 *
 * ⚠ ONDE RODAR: DENTRO do container. `DATABASE_URL` e o endereço da Evolution usam NOMES DE
 *   CONTAINER, que o host não resolve — no host isto falha com `EAI_AGAIN`, não com uma mensagem
 *   que explique o motivo. Na VPS:
 *
 *     docker exec -w /app adr-lead-manager node deploy/wa-sync-once.js --all
 *
 *   (Até 02/11/2026 isso era impossível: o `Dockerfile` não copiava `deploy/`, e o comando
 *   falhava com "Cannot find module" — fazendo parecer que o backfill não era necessário.)
 *
 * TODOS os tenants ativos (mesmo ciclo do cron, mas na hora):
 *   docker exec -w /app adr-lead-manager node deploy/wa-sync-once.js --all
 *
 * UM tenant (deep = TODAS as conversas, HISTÓRICO INTEIRO de cada uma):
 *   docker exec -w /app -e TENANT_ID=<uuid> adr-lead-manager node deploy/wa-sync-once.js
 *
 * ⚠ E LEIA O NÚMERO COM CUIDADO. `--all` só PUXA quando detecta reconexão (connection.update) ou
 *   quando o último sync está com mais de WA_SYNC_SAFETY_HOURS (6h). Um reinício curto do LM NÃO
 *   muda o estado da instância na Evolution, então nenhuma reconexão é detectada e a saída vem
 *   `{"reconexoes":0,"safety":0,"inseridos":0}` — e esse `inseridos: 0` significa "NÃO PROCUREI",
 *   não "procurei e não havia". Medido em 02/11/2026, depois de um deploy.
 *
 *   Para FECHAR a janela de um reinício, o que procura de verdade é o backfill RASO de um tenant
 *   (conversas ativas na janela de WA_SYNC_SHALLOW_DAYS, com teto). Ele devolve `chats: N`, e N>0
 *   é a prova de que ele foi olhar:
 *
 *     docker exec -w /app adr-lead-manager node -e "const{pool}=require('./src/db');\
 *       require('./src/waSync').backfillTenant('<uuid>',{deep:false})\
 *       .then(r=>console.log(JSON.stringify(r))).finally(()=>pool.end())"
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
