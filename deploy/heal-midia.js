'use strict';
/*
 * deploy/heal-midia.js — recupera mídia cujo download falhou: media_type presente, media_url NULL,
 * mas o payload cru (raw) foi guardado. Re-baixa da Evolution a partir do raw, grava no disco
 * (MEDIA_ROOT) e preenche media_url em `messages` (entrada) e `staff_outbound_samples` (saída).
 *
 * POR QUÊ: mídia recebida durante uma desconexão do WhatsApp (entrada) e toda mídia de saída antiga
 * (foto/vídeo/doc da recepção, que só passaram a ser baixadas agora) apareciam como "[mídia]" sem
 * arquivo. Como o raw ficou salvo, dá pra re-baixar depois — nada se perdeu.
 *
 * Roda como postgres (BYPASSRLS) → TODA query filtra tenant_id explicitamente.
 * Rodar DENTRO do container (env/volume/credenciais corretos):
 *   docker cp deploy/heal-midia.js adr-lead-manager:/app/deploy/heal-midia.js
 *   docker exec adr-lead-manager node deploy/heal-midia.js            # DRY-RUN (não baixa)
 *   docker exec adr-lead-manager node deploy/heal-midia.js --apply    # recupera de verdade
 * Opções (env): TENANT_ID=<uuid> (default Valinhos)  DIAS=<janela, default 60>  --all (todos)
 *               HEAL_THROTTLE_MS=<ms entre chamadas à Evolution, default 1500 — anti-ban>
 */
const { pool } = require('../src/db');
const media = require('../src/media');
const { detectarMidia } = require('../src/routes/webhook');
const { decrypt } = require('../src/crypto');

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const TENANT_ID = process.env.TENANT_ID || 'ed731a58-62e5-45ad-acba-a5502ff39e92'; // Valinhos
const DIAS = parseInt(process.env.DIAS || '60', 10);
const THROTTLE = parseInt(process.env.HEAL_THROTTLE_MS || '1500', 10);
const TABELAS = ['messages', 'staff_outbound_samples']; // conjunto fixo (nunca vem de input)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function credDe(tenantId) {
  const r = (await pool.query(
    'SELECT evolution_instance, evolution_token_enc FROM tenants WHERE id = $1', [tenantId])).rows[0];
  if (!r || !r.evolution_instance || !r.evolution_token_enc) return null;
  try { return { instance: r.evolution_instance, apikey: decrypt(r.evolution_token_enc) }; }
  catch { return null; }
}

// Reconstrói o objeto `media` (que salvarMidia espera) a partir do raw guardado.
function mediaDeRaw(raw) {
  const m = raw && raw.data && raw.data.message;
  const key = raw && raw.data && raw.data.key;
  if (!m || !key) return null;
  const det = detectarMidia(m);
  if (!det) return null;
  return { ...det, rawMessage: m, messageKey: key };
}

async function pendentesTabela(tenantId, tabela) {
  return (await pool.query(
    `SELECT id, media_type, raw
       FROM lead_manager.${tabela}
      WHERE tenant_id = $1 AND media_type IS NOT NULL AND media_url IS NULL AND raw IS NOT NULL
        AND received_at >= now() - ($2 || ' days')::interval
      ORDER BY received_at DESC`, [tenantId, String(DIAS)])
  ).rows.map((r) => ({ ...r, tabela }));
}

async function healTenant(tenantId) {
  const rows = [];
  for (const t of TABELAS) rows.push(...await pendentesTabela(tenantId, t));
  console.log(`\n=== tenant ${tenantId} — ${rows.length} mídia(s) sem arquivo (janela ${DIAS}d) ===`);
  if (!rows.length) return { ok: 0, fail: 0, skip: 0 };
  const cred = await credDe(tenantId);
  if (!cred) { console.log('  ! sem credencial Evolution utilizável — pulando tenant'); return { ok: 0, fail: 0, skip: rows.length }; }

  let ok = 0; let fail = 0; let skip = 0;
  for (const r of rows) {
    const md = mediaDeRaw(r.raw);
    if (!md) { skip++; console.log(`  [SKIP] ${r.tabela}/${r.id} (${r.media_type}) — raw sem nó de mídia`); continue; }
    if (!APPLY) { ok++; console.log(`  [SERIA] ${r.tabela}/${r.id} (${r.media_type})`); continue; }
    try {
      const saved = await media.salvarMidia({ tenantId, instance: cred.instance, apikey: cred.apikey, media: md });
      if (!saved) { fail++; console.log(`  [FALHOU] ${r.tabela}/${r.id} — Evolution não devolveu base64`); await sleep(THROTTLE); continue; }
      await pool.query(
        `UPDATE lead_manager.${r.tabela}
            SET media_url = $2, media_filename = COALESCE(media_filename, $3)
          WHERE id = $1 AND tenant_id = $4 AND media_url IS NULL`,
        [r.id, saved.media_url, saved.media_filename || null, tenantId]);
      ok++; console.log(`  [OK] ${r.tabela}/${r.id} → ${saved.media_url}`);
    } catch (e) { fail++; console.log(`  [ERRO] ${r.tabela}/${r.id} — ${e.message}`); }
    await sleep(THROTTLE);
  }
  return { ok, fail, skip };
}

(async () => {
  try {
    let tenants = [TENANT_ID];
    if (ALL) tenants = (await pool.query('SELECT id FROM tenants')).rows.map((r) => r.id);
    console.log(APPLY
      ? '=== MODO --apply: baixa da Evolution e grava media_url ==='
      : '=== DRY-RUN (nada baixa) — rode com --apply para recuperar ===');
    const tot = { ok: 0, fail: 0, skip: 0 };
    for (const t of tenants) { const r = await healTenant(t); tot.ok += r.ok; tot.fail += r.fail; tot.skip += r.skip; }
    console.log(`\nRESUMO: ${APPLY ? 'recuperadas' : 'recuperáveis'}=${tot.ok}  falhas=${tot.fail}  puladas=${tot.skip}`);
  } finally {
    try { await pool.end(); } catch {}
    try { require('../src/redisClient').redis.disconnect(); } catch {}
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
