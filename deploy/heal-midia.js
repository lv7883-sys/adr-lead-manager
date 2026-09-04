'use strict';
/*
 * deploy/heal-midia.js — recupera mídia cujo download falhou: media_url NULL mas o payload cru
 * (raw) tem o nó de mídia. Re-baixa da Evolution a partir do raw, grava no disco (MEDIA_ROOT) e
 * preenche media_url em `messages` (entrada) e `staff_outbound_samples` (saída).
 *
 * POR QUÊ: mídia recebida durante desconexão do WhatsApp (entrada) e mídia de saída antiga
 * (foto/vídeo/doc que não eram baixadas) apareciam como "[mídia]" sem arquivo. O raw ficou salvo,
 * então dá pra re-baixar — nada se perdeu. (Mídia MUITO antiga pode não estar mais no servidor do
 * WhatsApp → a Evolution devolve vazio e a linha é contada como falha, sem quebrar o resto.)
 *
 * RLS: lê e escreve DENTRO de withTenant (o pool NÃO bypassa RLS). A rede (Evolution) roda FORA da
 * transação p/ não segurar conexão. UPDATE em messages é permitido ao role; em staff_outbound_samples
 * pode não ser (o script reporta o erro por linha, sem abortar).
 *
 * Rodar DENTRO do container (env/volume/credenciais corretos):
 *   docker cp deploy/heal-midia.js adr-lead-manager:/app/deploy/heal-midia.js
 *   docker exec adr-lead-manager node deploy/heal-midia.js            # DRY-RUN
 *   docker exec adr-lead-manager node deploy/heal-midia.js --apply    # recupera
 * Env: TENANT_ID (default Valinhos)  DIAS (janela, default 60)  LIMITE (máx por tabela, default 0=todos)
 *      HEAL_THROTTLE_MS (ms entre chamadas à Evolution, default 1500 — anti-ban)
 *      TABELA (messages|staff_outbound_samples — restringe; default as duas)
 */
const { withTenant, pool } = require('../src/db');
const media = require('../src/media');
const { detectarMidia } = require('../src/routes/webhook');
const { decrypt } = require('../src/crypto');

const APPLY = process.argv.includes('--apply');
const TENANT_ID = process.env.TENANT_ID || 'ed731a58-62e5-45ad-acba-a5502ff39e92'; // Valinhos
const DIAS = parseInt(process.env.DIAS || '60', 10);
const LIMITE = parseInt(process.env.LIMITE || '0', 10);
const THROTTLE = parseInt(process.env.HEAL_THROTTLE_MS || '1500', 10);
const NOS = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'documentWithCaptionMessage'];
const TABELAS = process.env.TABELA ? [process.env.TABELA] : ['messages', 'staff_outbound_samples'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function credDe(tenantId) {
  const r = await withTenant(tenantId, async (c) => (
    await c.query('SELECT evolution_instance, evolution_token_enc FROM tenants WHERE id = $1', [tenantId])).rows[0]);
  if (!r || !r.evolution_instance || !r.evolution_token_enc) return null;
  try { return { instance: r.evolution_instance, apikey: decrypt(r.evolution_token_enc) }; } catch { return null; }
}

function mediaDeRaw(raw) {
  const m = raw && raw.data && raw.data.message;
  const key = raw && raw.data && raw.data.key;
  if (!m || !key) return null;
  const det = detectarMidia(m);
  if (!det) return null;
  return { ...det, rawMessage: m, messageKey: key };
}

async function pendentes(tenantId, tabela) {
  return withTenant(tenantId, async (c) => (await c.query(
    `SELECT id, media_type, raw FROM lead_manager.${tabela}
      WHERE media_url IS NULL AND raw IS NOT NULL
        AND jsonb_exists_any(raw->'data'->'message', $1)
        AND received_at >= now() - ($2 || ' days')::interval
      ORDER BY received_at DESC ${LIMITE > 0 ? `LIMIT ${LIMITE}` : ''}`, [NOS, String(DIAS)])
  ).rows.map((r) => ({ ...r, tabela })));
}

async function gravarUrl(tenantId, tabela, id, url, filename) {
  return withTenant(tenantId, (c) => c.query(
    `UPDATE lead_manager.${tabela} SET media_url = $1, media_filename = COALESCE(media_filename, $2)
      WHERE id = $3 AND media_url IS NULL`, [url, filename || null, id]));
}

async function healTabela(tenantId, tabela, cred) {
  const rows = await pendentes(tenantId, tabela);
  console.log(`\n[${tabela}] ${rows.length} mídia(s) sem arquivo (janela ${DIAS}d${LIMITE ? `, limite ${LIMITE}` : ''})`);
  let ok = 0; let fail = 0; let skip = 0;
  for (const r of rows) {
    const md = mediaDeRaw(r.raw);
    if (!md) { skip++; continue; }
    if (!APPLY) { ok++; continue; }
    try {
      const saved = await media.salvarMidia({ tenantId, instance: cred.instance, apikey: cred.apikey, media: md });
      if (!saved) { fail++; }
      else { await gravarUrl(tenantId, tabela, r.id, saved.media_url, saved.media_filename); ok++; }
    } catch (e) { fail++; if (fail <= 3) console.log(`  [ERRO] ${tabela}/${r.id} — ${e.message}`); }
    await sleep(THROTTLE);
  }
  console.log(`  → ${APPLY ? 'recuperadas' : 'recuperáveis'}=${ok}  falhas=${fail}  puladas=${skip}`);
  return { ok, fail, skip };
}

(async () => {
  try {
    console.log(APPLY ? '=== MODO --apply: baixa da Evolution e grava media_url ==='
      : '=== DRY-RUN (nada baixa) — rode com --apply para recuperar ===');
    console.log(`tenant=${TENANT_ID}`);
    const cred = APPLY ? await credDe(TENANT_ID) : { instance: '(dry)', apikey: '(dry)' };
    if (APPLY && !cred) { console.log('! sem credencial Evolution utilizável — abortando'); return; }
    const tot = { ok: 0, fail: 0, skip: 0 };
    for (const t of TABELAS) { const r = await healTabela(TENANT_ID, t, cred); tot.ok += r.ok; tot.fail += r.fail; tot.skip += r.skip; }
    console.log(`\nRESUMO: ${APPLY ? 'recuperadas' : 'recuperáveis'}=${tot.ok}  falhas=${tot.fail}  puladas=${tot.skip}`);
  } finally { try { await pool.end(); } catch {} try { require('../src/redisClient').redis.disconnect(); } catch {} }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
