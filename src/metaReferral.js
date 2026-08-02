'use strict';
//
// metaReferral.js — ADR-042/Meta: ATRIBUIÇÃO DE CAMPANHA nos DMs (Click-to-Messenger /
// Click-to-Instagram-Direct). Quando alguém clica num anúncio "enviar mensagem", a Meta manda
// um objeto `referral` (ad_id/ref/source/type/ads_context_data) no 1º contato. Aqui a gente
// EXTRAI esse objeto do evento messaging[] e REGISTRA o toque (append-only, first-touch) em
// meta_ad_referral — sem depender de a conversa já existir (o referral pode chegar antes da msg).
//
// DM orgânico (sem clique em anúncio) não tem referral → nada a atribuir.
//
const { withTenant } = require('./db');

// Extrai o referral de um evento messaging[]. Vem em 3 lugares, nesta ordem de preferência:
//   - m.referral            (usuário existente clicando anúncio / link com ref)
//   - m.postback.referral   (novo usuário via "Começar" a partir do anúncio)
//   - m.message.referral    (referral anexado à 1ª mensagem)
// Retorna null se não houver anúncio (ad_id) nem código (ref) — i.e., DM orgânico.
function extractReferral(m) {
  const r = (m && (m.referral
        || (m.postback && m.postback.referral)
        || (m.message && m.message.referral))) || null;
  if (!r) return null;
  const out = {
    ref: r.ref || null,
    adId: r.ad_id || null,
    source: r.source || null,
    type: r.type || null,
    adsContext: r.ads_context_data || null,
  };
  if (!out.adId && !out.ref) return null;
  return out;
}

// Registra o toque (first-touch). Reentrega do webhook / clique repetido no MESMO anúncio
// NÃO duplica (índice único casa o ON CONFLICT). Best-effort — o chamador captura erro.
async function recordReferral(tenantId, channel, psid, referral) {
  if (!tenantId || !channel || !psid || !referral) return { skipped: 'args' };
  await withTenant(tenantId, (c) => c.query(
    `INSERT INTO meta_ad_referral (tenant_id, channel, psid, ad_id, ref, source, ref_type, ads_context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, channel, psid, (coalesce(ad_id,'')), (coalesce(ref,''))) DO NOTHING`,
    [tenantId, channel, psid, referral.adId, referral.ref, referral.source, referral.type,
     referral.adsContext ? JSON.stringify(referral.adsContext) : null]));
  return { ok: true };
}

// Atribuição (first-touch) de uma conversa Meta: a linha MAIS ANTIGA por (channel, psid).
// Retorna { ad_id, ref, source, ref_type, ads_context, received_at } ou null.
async function referralForConversation(tenantId, channel, psid) {
  if (!tenantId || !channel || !psid) return null;
  return withTenant(tenantId, async (c) => (await c.query(
    `SELECT ad_id, ref, source, ref_type, ads_context, received_at
       FROM meta_ad_referral
      WHERE tenant_id = $1 AND channel = $2 AND psid = $3
      ORDER BY received_at ASC LIMIT 1`, [tenantId, channel, psid])).rows[0] || null);
}

module.exports = { extractReferral, recordReferral, referralForConversation };
