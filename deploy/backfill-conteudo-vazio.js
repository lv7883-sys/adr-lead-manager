'use strict';
/*
 * deploy/backfill-conteudo-vazio.js — paridade com o WhatsApp, etapa 3: as bolhas VAZIAS que a importação de
 * histórico criou (body '' e raw '{}', sem guardar o tipo) — 2.954 saídas em 15/09/2026.
 *
 * Para cada linha vazia, busca a mensagem real na API (findMessages pelo id) e passa pelo tradutor único
 * (waConteudo): se tem conteúdo, grava texto, cartão, citação, tipo de mídia e a mensagem inteira no raw
 * (o que libera o botão "Carregar mídia"); se não é bolha (protocolo, edição cifrada, voto…), ARQUIVA a
 * linha (wa_linha_arquivada) e a retira; se a API não tem mais a mensagem, deixa como está e conta.
 *
 * Rodar DENTRO do container:
 *   sed "s#require('../src/#require('/app/src/#g" deploy/backfill-conteudo-vazio.js > /tmp/bcv.js
 *   docker cp /tmp/bcv.js adr-lead-manager:/tmp/bcv.js
 *   docker exec adr-lead-manager node /tmp/bcv.js            # ENSAIO: busca uma amostra e conta
 *   docker exec adr-lead-manager node /tmp/bcv.js --apply    # aplica
 * Env: TENANT_ID (default Valinhos)  THROTTLE_MS (default 120 entre chamadas à API)
 */
const { withTenant, pool } = require('../src/db');
const outbound = require('../src/outbound');
const { descrever } = require('../src/waConteudo');
const { detectarMidia } = require('../src/routes/webhook');
const waEdicao = require('../src/waEdicao');
const { aplicarProtocoloDoHistorico } = require('../src/waSync');

const APPLY = process.argv.includes('--apply');
const TENANT_ID = process.env.TENANT_ID || 'ed731a58-62e5-45ad-acba-a5502ff39e92';
const THROTTLE = parseInt(process.env.THROTTLE_MS || '120', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    const cr = await outbound.credsForTenant(TENANT_ID);
    const base = (process.env.EVOLUTION_URL || '').replace(/\/+$/, '');
    const buscar = async (id) => {
      const r = await fetch(`${base}/chat/findMessages/${encodeURIComponent(cr.instance)}`, {
        method: 'POST', headers: { apikey: cr.apikey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ where: { key: { id } } }) });
      const j = await r.json().catch(() => null);
      const lista = (j && (j.messages?.records || j.records || (Array.isArray(j) ? j : []))) || [];
      return lista.find((x) => x && x.key && x.key.id === id) || null;
    };

    const vazias = await withTenant(TENANT_ID, async (c) => (await c.query(`
      SELECT 'staff_outbound_samples' AS tabela, id, external_message_id, received_at FROM staff_outbound_samples
       WHERE tenant_id = $1 AND coalesce(trim(body), '') = '' AND external_message_id IS NOT NULL
      UNION ALL
      SELECT 'messages', id, external_message_id, received_at FROM messages
       WHERE tenant_id = $1 AND coalesce(trim(body), '') = '' AND external_message_id IS NOT NULL
      ORDER BY received_at`, [TENANT_ID])).rows);
    console.log(`${APPLY ? '=== --apply ===' : '=== ENSAIO (amostra de 25, nada muda) ==='} vazias: ${vazias.length}`);

    const lote = APPLY ? vazias : vazias.slice(0, 25);
    const tot = { recuperada: 0, arquivada: 0, edicao_aplicada: 0, apagamento_aplicado: 0, sem_na_api: 0, erro: 0 };
    const tipos = {};
    for (const v of lote) {
      try {
        const rec = await buscar(v.external_message_id);
        await sleep(THROTTLE);
        if (!rec || !rec.message) { tot.sem_na_api++; continue; }
        const d = descrever(rec.message);
        const m = d.inner || {};
        const chave = Object.keys(m).filter((k) => k !== 'messageContextInfo')[0] || '(vazio)';
        tipos[chave] = (tipos[chave] || 0) + 1;
        const media = detectarMidia(m);
        let body = m.conversation ?? (m.extendedTextMessage && m.extendedTextMessage.text) ?? d.texto ?? (media && media.placeholder) ?? null;
        if (body === '') body = null;
        if (!APPLY) { if (body) tot.recuperada++; else tot.arquivada++; continue; }
        // edição (cifrada ou aberta) e apagamento: aplicados na mensagem ORIGINAL; a linha vazia é arquivada.
        const prot = await aplicarProtocoloDoHistorico(TENANT_ID, { ...rec, message: m });
        if (prot === 'apagada') tot.apagamento_aplicado++; else if (prot) tot.edicao_aplicada++;
        await withTenant(TENANT_ID, async (c) => {
          if (body) {
            await c.query(
              `UPDATE ${v.tabela}
                  SET body = $2, conteudo = COALESCE(conteudo, $3::jsonb), reply_to_external_id = COALESCE(reply_to_external_id, $4),
                      media_type = COALESCE(media_type, $5), raw = $6::jsonb
                WHERE id = $1 AND coalesce(trim(body), '') = ''`,
              [v.id, body, d.conteudo ? JSON.stringify(d.conteudo) : null, (d.conteudo && d.conteudo.contexto && d.conteudo.contexto.citadaId) || null,
                media ? media.kind : null, JSON.stringify({ source: 'historico', data: rec })]);
            tot.recuperada++;
          } else {
            await c.query(
              `INSERT INTO wa_linha_arquivada (tenant_id, tabela, linha_id, motivo, linha)
               SELECT $1, $2, t.id, 'sem_conteudo:' || $3, to_jsonb(t) FROM ${v.tabela} t WHERE t.id = $4`,
              [TENANT_ID, v.tabela, chave, v.id]);
            await c.query(`DELETE FROM ${v.tabela} WHERE id = $1`, [v.id]);
            tot.arquivada++;
          }
        });
      } catch (e) {
        tot.erro++;
        if (tot.erro <= 3) console.log(`  [ERRO] ${v.tabela}/${v.id}: ${e.message}`);
      }
    }
    console.log('resultado:', JSON.stringify(tot));
    console.log('tipos encontrados:', JSON.stringify(tipos));
  } finally {
    try { await pool.end(); } catch { /* */ }
    try { require('../src/redisClient').redis.disconnect(); } catch { /* */ }
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
