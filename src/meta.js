'use strict';
//
// meta.js — cliente da Graph API da Meta + resolução de tenant + verificação de
// assinatura dos webhooks. P0 da arquitetura do LM (Lead Ads / IG DM / Messenger).
//
const crypto = require('crypto');
const { pool, withTenant } = require('./db');
const { decrypt } = require('./crypto');
const logger = require('./logger');

const GRAPH = 'https://graph.facebook.com/' + (process.env.META_GRAPH_VERSION || 'v21.0');

// GET na Graph API com timeout. Lança em HTTP !ok (corpo de erro anexado).
async function graphGet(path, params) {
  const url = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) {
      const e = new Error(`Graph GET ${path} -> HTTP ${r.status}`);
      e.status = r.status; e.body = data;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Busca os dados reais de um lead de Lead Ad. Retorna { field_data, created_time, ... }.
// field_data = [{ name: 'full_name', values: ['João'] }, ...].
async function fetchLead(leadgenId, pageToken) {
  return graphGet('/' + encodeURIComponent(leadgenId), {
    fields: 'field_data,created_time,ad_id,form_id',
    access_token: pageToken,
  });
}

// Nome do usuário de um DM, pelo PSID. Best-effort: devolve null em erro.
async function fetchUserName(psid, pageToken) {
  try {
    const d = await graphGet('/' + encodeURIComponent(psid), { fields: 'name', access_token: pageToken });
    return (d && d.name) || null;
  } catch (e) {
    logger.warn('meta.fetch_user_name_failed', { error: e.message });
    return null;
  }
}

// field_data -> objeto { field_name: primeiro_valor }. Normaliza chaves p/ minúsculas.
function fieldDataToMap(fieldData) {
  const map = {};
  for (const f of Array.isArray(fieldData) ? fieldData : []) {
    if (!f || !f.name) continue;
    const v = Array.isArray(f.values) ? f.values[0] : f.values;
    map[String(f.name).toLowerCase()] = v != null ? String(v) : null;
  }
  return map;
}

// Resolve o tenant pelo page_id (via função SECURITY DEFINER, sem contexto RLS).
async function tenantByPageId(pageId) {
  if (!pageId) return null;
  const { rows } = await pool.query('SELECT lead_manager.tenant_by_meta_page($1) AS id', [String(pageId)]);
  return (rows[0] && rows[0].id) || null;
}

// Page Access Token (decifrado) + page_id do tenant. null se não configurado.
async function pageCredsForTenant(tenantId) {
  const row = await withTenant(tenantId, (c) =>
    c.query('SELECT meta_page_id, meta_page_token_enc FROM tenants WHERE id = $1', [tenantId]).then((r) => r.rows[0])
  );
  if (!row) return null;
  const token = decrypt(row.meta_page_token_enc);
  return { pageId: row.meta_page_id, token: token || null };
}

// Verifica a assinatura X-Hub-Signature-256 (HMAC-SHA256 do corpo BRUTO com o
// META_APP_SECRET). Retorna true/false, ou null se o secret não estiver configurado
// (nesse caso o chamador decide a política — ver webhook-meta.js).
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.META_APP_SECRET || '';
  if (!secret) return null;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(rawBody || Buffer.alloc(0)).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  fetchLead, fetchUserName, fieldDataToMap,
  tenantByPageId, pageCredsForTenant, verifySignature,
};
