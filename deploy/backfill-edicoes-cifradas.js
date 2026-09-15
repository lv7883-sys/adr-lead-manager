'use strict';
/*
 * deploy/backfill-edicoes-cifradas.js — paridade com o WhatsApp, etapa 2: as bolhas falsas
 * "[mensagem de visualização única]" que eram, na verdade, EDIÇÕES CIFRADAS de outra mensagem.
 *
 * Para cada linha com secretEncryptedMessage (em messages e staff_outbound_samples):
 *   1) aplica a edição na mensagem original (waEdicao.aplicarEdicaoCifrada): texto novo quando decifra,
 *      senão só a marca de editada;
 *   2) ARQUIVA a linha em wa_linha_arquivada (cópia integral) e a retira da tabela — ela não é mensagem;
 *   3) recalcula a última atividade das conversas afetadas (edição não reordena a lista no WhatsApp).
 * Antes, atualiza o mapa número <-> @lid (mensagens do banco + lista de conversas da API).
 *
 * Rodar DENTRO do container (a imagem não tem /app/deploy: copie para /tmp trocando os requires):
 *   sed "s#require('../src/#require('/app/src/#g" deploy/backfill-edicoes-cifradas.js > /tmp/bec.js
 *   docker cp /tmp/bec.js adr-lead-manager:/tmp/bec.js
 *   docker exec adr-lead-manager node /tmp/bec.js            # ENSAIO: só conta
 *   docker exec adr-lead-manager node /tmp/bec.js --apply    # aplica, arquiva e recalcula
 * Env: TENANT_ID (default Valinhos)
 */
const { withTenant, pool } = require('../src/db');
const waEdicao = require('../src/waEdicao');

const APPLY = process.argv.includes('--apply');
const TENANT_ID = process.env.TENANT_ID || 'ed731a58-62e5-45ad-acba-a5502ff39e92';

(async () => {
  try {
    console.log(APPLY ? '=== --apply: aplica edições, arquiva as bolhas falsas e recalcula ===' : '=== ENSAIO (nada muda) — use --apply ===');

    // mapa @lid: pares vistos nas mensagens já gravadas + lista de conversas da API
    const aprendidos = await withTenant(TENANT_ID, async (c) => {
      const pares = (await c.query(`
        SELECT DISTINCT raw->'data'->'key' AS key FROM messages
         WHERE raw->'data'->'key'->>'participantAlt' IS NOT NULL OR raw->'data'->'key'->>'remoteJidAlt' IS NOT NULL`)).rows
        .flatMap((r) => waEdicao.paresDaKey(r.key));
      if (APPLY) {
        for (const p of pares) {
          await c.query(`INSERT INTO wa_lid (tenant_id, lid, pn) VALUES ($1,$2,$3)
                         ON CONFLICT (tenant_id, lid) DO UPDATE SET pn = COALESCE(EXCLUDED.pn, wa_lid.pn), visto_em = now()`,
          [TENANT_ID, p.lid, p.pn]);
        }
      }
      return pares.length;
    });
    const daApi = APPLY ? await waEdicao.atualizarLidsDaApi(TENANT_ID, { intervaloMs: 0 }) : 0;
    console.log(`pares número<->@lid: ${aprendidos} do banco, ${daApi} da API`);

    const falsas = await withTenant(TENANT_ID, async (c) => (await c.query(`
      SELECT 'messages' AS tabela, id, raw, conversation_id, NULL::text AS dig, received_at FROM messages
       WHERE tenant_id = $1 AND raw->'data'->'message' ? 'secretEncryptedMessage'
      UNION ALL
      SELECT 'staff_outbound_samples', id, raw, NULL::uuid, regexp_replace(external_id, '[^0-9]', '', 'g'), received_at FROM staff_outbound_samples
       WHERE tenant_id = $1 AND raw->'data'->'message' ? 'secretEncryptedMessage'
      ORDER BY received_at ASC`, [TENANT_ID])).rows);
    console.log(`bolhas falsas: ${falsas.length} (${falsas.filter((f) => f.tabela === 'messages').length} recebidas, ${falsas.filter((f) => f.tabela !== 'messages').length} enviadas)`);
    if (!APPLY) return;

    const tot = { editada: 0, marcada: 0, alvo_ausente: 0, invalida: 0, arquivadas: 0, erros: 0 };
    const motivos = {};
    const convs = new Set(); const digs = new Set();
    for (const f of falsas) {
      const d = f.raw && f.raw.data;
      try {
        const r = await waEdicao.aplicarEdicaoCifrada(TENANT_ID, { key: d.key, message: d.message });
        tot[r.resultado] = (tot[r.resultado] || 0) + 1;
        if (r.motivo) motivos[`${f.tabela === 'messages' ? 'recebida' : 'enviada'}:${r.motivo}`] = (motivos[`${f.tabela === 'messages' ? 'recebida' : 'enviada'}:${r.motivo}`] || 0) + 1;
        await withTenant(TENANT_ID, async (c) => {
          await c.query(
            `INSERT INTO wa_linha_arquivada (tenant_id, tabela, linha_id, motivo, linha)
             SELECT $1, $2, t.id, 'edicao_cifrada', to_jsonb(t) FROM ${f.tabela} t WHERE t.id = $3`,
            [TENANT_ID, f.tabela, f.id]);
          await c.query(`DELETE FROM ${f.tabela} WHERE id = $1`, [f.id]);
        });
        tot.arquivadas++;
        if (f.conversation_id) convs.add(f.conversation_id);
        if (f.dig) digs.add(f.dig);
      } catch (e) {
        tot.erros++;
        if (tot.erros <= 3) console.log(`  [ERRO] ${f.tabela}/${f.id}: ${e.message}`);
      }
    }

    // última atividade das conversas afetadas, pela mesma régua da migr. 111
    const recalc = await withTenant(TENANT_ID, (c) => c.query(`
      UPDATE conversations cv
         SET last_activity_at = COALESCE(GREATEST(
               (SELECT max(m.received_at) FROM messages m WHERE m.conversation_id = cv.id AND m.role = 'USER'),
               (SELECT max(s.received_at) FROM staff_outbound_samples s
                 WHERE s.tenant_id = cv.tenant_id AND s.is_group IS NOT TRUE
                   AND regexp_replace(s.external_id, '[^0-9]', '', 'g') = regexp_replace(cv.external_id, '[^0-9]', '', 'g'))),
               cv.updated_at)
       WHERE cv.tenant_id = $1
         AND (cv.id = ANY($2::uuid[]) OR regexp_replace(cv.external_id, '[^0-9]', '', 'g') = ANY($3::text[]))`,
    [TENANT_ID, [...convs], [...digs]]));

    console.log('resultado:', JSON.stringify(tot));
    console.log('sem texto legível, por quê:', JSON.stringify(motivos));
    console.log(`conversas com a última atividade recalculada: ${recalc.rowCount}`);
  } finally {
    try { await pool.end(); } catch { /* */ }
    try { require('../src/redisClient').redis.disconnect(); } catch { /* */ }
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
