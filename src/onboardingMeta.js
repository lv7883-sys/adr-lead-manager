'use strict';
//
// onboardingMeta.js — onboarding de Página do Facebook por-tenant (Item 2 do arco Meta).
//
// 1º caminho de ESCRITA das credenciais Meta em código. Antes disso, meta_page_id /
// meta_page_token_enc eram provisionados à mão. Aqui:
//   - /start  : monta a URL do dialog Facebook Login for Business (FLB) com config_id
//               e um `state` assinado (HMAC com META_APP_SECRET) — defesa-em-profundidade
//               (o /start já é autenticado pelo dashboard) + anti-CSRF no callback.
//   - callback: troca code -> token (System User token do FLB, não-expira), resolve a
//               Página concedida (page_id + PAGE access token derivado + ig opcional),
//               cifra e faz a DUPLA-ESCRITA TRANSACIONAL: tenants.meta_page_* E
//               tenant_lead_source(platform='meta'). Inscreve leadgen. Idempotente.
//
// ADITIVO: NÃO toca meta.js (resolução/ingestão). Só popula o que aquele caminho lê.
// O token guardado em tenants.meta_page_token_enc é o PAGE access token (é o que a
// ingestão usa em fetchLead/fetchUserName/sendMessage) — derivado do System User token
// não-expira do FLB, logo long-lived/efetivamente não-expira (sem refresh novo).
//
const crypto = require('crypto');
const { withTenant } = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { getCache, setCache, delCache } = require('./redisClient');
const logger = require('./logger');

// Versão da Graph confirmada contra a doc do Meta (v25.0, 2026-02-18). O env só sobrescreve.
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const GRAPH = 'https://graph.facebook.com/' + GRAPH_VERSION;
const DIALOG = 'https://www.facebook.com/' + GRAPH_VERSION + '/dialog/oauth';

const STATE_TTL_MS = 10 * 60 * 1000;            // exp curto do state (10 min)
const NONCE_PREFIX = 'meta_onb_nonce:';          // nonce single-use (best-effort via redis)
// Hosts permitidos como return_to (o dashboard). Evita open-redirect no callback.
const RETURN_HOSTS = (process.env.META_ONBOARDING_RETURN_HOSTS || 'agenda.leovecchi.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Falha EXPLÍCITA quando uma env obrigatória falta — nada de fallback que mascare ausência.
function requireEnv(name) {
  const v = process.env[name];
  if (!v) { const e = new Error(`env_ausente:${name}`); e.code = 'env_missing'; e.envName = name; throw e; }
  return v;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const b64urlJson = (obj) => b64url(JSON.stringify(obj));

// HMAC-SHA256 do payload do state com o META_APP_SECRET (nunca vai pro client).
function signState(payloadB64) {
  return b64url(crypto.createHmac('sha256', requireEnv('META_APP_SECRET')).update(payloadB64).digest());
}

// redirect_uri EXATO (precisa bater com o registrado na app Meta). Deriva da base pública do LM.
function redirectUri() {
  return requireEnv('PUBLIC_BASE_URL').replace(/\/+$/, '') + '/onboarding/meta/callback';
}

// return_to válido = http(s) + host na allowlist do dashboard.
function isAllowedReturnTo(returnTo) {
  try {
    const u = new URL(returnTo);
    return (u.protocol === 'https:' || u.protocol === 'http:') && RETURN_HOSTS.includes(u.host);
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Cliente Graph mínimo e próprio (NÃO reusa meta.js — aquele fica intocado).
// ---------------------------------------------------------------------------
async function graphFetch(method, path, params) {
  const url = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { method, headers: { accept: 'application/json' } });
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) { const e = new Error(`Graph ${method} ${path} -> HTTP ${r.status}`); e.status = r.status; e.body = data; throw e; }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// state (assinado) — gerar e validar.
// ---------------------------------------------------------------------------
async function buildStartUrl({ tenantId, returnTo }) {
  const appId = requireEnv('META_APP_ID');
  const configId = requireEnv('META_LOGIN_CONFIG_ID');
  const redirect = redirectUri();                 // valida PUBLIC_BASE_URL
  signState('');                                  // valida META_APP_SECRET cedo (falha explícita)
  if (!isAllowedReturnTo(returnTo)) { const e = new Error('return_to_invalido'); e.code = 'bad_return_to'; throw e; }

  const nonce = crypto.randomBytes(16).toString('hex');
  const pb = b64urlJson({ t: tenantId, n: nonce, e: Date.now() + STATE_TTL_MS, r: returnTo });
  const state = pb + '.' + signState(pb);
  // nonce single-use (idealmente): grava no redis; o callback consome.
  await setCache(NONCE_PREFIX + nonce, { t: tenantId }, Math.ceil(STATE_TTL_MS / 1000));

  const url = new URL(DIALOG);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('config_id', configId);    // Facebook Login for Business
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

// Decodifica (sem verificar HMAC) só o return_to, p/ poder voltar ao dashboard em erro.
// Revalida o host na allowlist — então é seguro mesmo com state forjado.
function returnToFromState(state) {
  try {
    const payload = JSON.parse(Buffer.from(String(state).split('.')[0], 'base64url').toString('utf8'));
    if (payload && payload.r && isAllowedReturnTo(payload.r)) return payload.r;
  } catch { /* ignore */ }
  return null;
}

async function verifyState(state) {
  if (typeof state !== 'string' || !state.includes('.')) { const e = new Error('state_malformado'); e.code = 'bad_state'; throw e; }
  const [pb, sig] = state.split('.');
  const expected = signState(pb);
  const a = Buffer.from(sig || ''); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { const e = new Error('state_assinatura_invalida'); e.code = 'bad_state'; throw e; }
  let payload;
  try { payload = JSON.parse(Buffer.from(pb, 'base64url').toString('utf8')); } catch { const e = new Error('state_payload'); e.code = 'bad_state'; throw e; }
  if (!payload || !payload.t || !payload.e) { const e = new Error('state_incompleto'); e.code = 'bad_state'; throw e; }
  if (Date.now() > Number(payload.e)) { const e = new Error('state_expirado'); e.code = 'state_expired'; throw e; }
  // nonce single-use: precisa existir; é consumido. Se o redis estiver indisponível,
  // HMAC + exp curto seguem protegendo — loga (não mascara).
  if (payload.n) {
    const key = NONCE_PREFIX + payload.n;
    const hit = await getCache(key);
    if (hit) await delCache(key);
    else logger.warn('meta.onboarding.nonce_miss', { tenant_id: payload.t });
  }
  return { tenantId: payload.t, returnTo: payload.r };
}

// ---------------------------------------------------------------------------
// Troca de code -> token e resolução da Página concedida.
// ---------------------------------------------------------------------------
async function exchangeCode(code) {
  const data = await graphFetch('GET', '/oauth/access_token', {
    client_id: requireEnv('META_APP_ID'),
    redirect_uri: redirectUri(),
    client_secret: requireEnv('META_APP_SECRET'),
    code,
  });
  if (!data || !data.access_token) { const e = new Error('sem_access_token'); e.code = 'no_token'; e.body = data; throw e; }
  return data.access_token;   // System User token (FLB) — não-expira.
}

async function resolveGrantedPage(userToken) {
  const data = await graphFetch('GET', '/me/accounts', {
    access_token: userToken,
    fields: 'id,name,access_token,instagram_business_account{id,username}',
  });
  const pages = (data && Array.isArray(data.data)) ? data.data : [];
  if (!pages.length) { const e = new Error('nenhuma_pagina_concedida'); e.code = 'no_page'; throw e; }
  if (pages.length > 1) logger.warn('meta.onboarding.multi_page', { count: pages.length });
  const p = pages[0];                              // self-onboarding = 1 página; multi fica p/ depois
  if (!p.access_token) { const e = new Error('pagina_sem_token'); e.code = 'no_page_token'; throw e; }
  const ig = p.instagram_business_account || null;
  return {
    pageId: String(p.id),
    pageName: p.name || null,
    pageToken: p.access_token,                     // PAGE token (derivado do SU token => long-lived)
    igId: ig && ig.id ? String(ig.id) : null,
  };
}

// Inscreve a Página nos webhooks que usamos: leadgen (Lead Ads) + messages/messaging_postbacks
// (DMs de Messenger/Instagram → Caixa de Entrada) + messaging_referrals (ATRIBUIÇÃO de campanha:
// referral de anúncios "enviar mensagem" p/ usuário existente; o de usuário novo já vem no postback).
// Idempotente.
async function subscribeLeadgen(pageId, pageToken) {
  return graphFetch('POST', '/' + encodeURIComponent(pageId) + '/subscribed_apps', {
    subscribed_fields: 'leadgen,messages,messaging_postbacks,messaging_referrals',
    access_token: pageToken,
  });
}

// Conjunto dos campos atualmente inscritos na Página (verdade viva, não flag persistida).
async function listSubscribedFields(pageId, pageToken) {
  const data = await graphFetch('GET', '/' + encodeURIComponent(pageId) + '/subscribed_apps', { access_token: pageToken });
  const apps = (data && Array.isArray(data.data)) ? data.data : [];
  const set = new Set();
  for (const app of apps) for (const f of (app.subscribed_fields || [])) set.add(typeof f === 'string' ? f : (f && f.name));
  return set;
}

// ---------------------------------------------------------------------------
// DUPLA-ESCRITA TRANSACIONAL (withTenant = BEGIN/COMMIT). Resolve a pendência do
// Item 1: tenants.meta_page_id e tenant_lead_source.entity_id ficam consistentes.
// ---------------------------------------------------------------------------
async function persistConnection({ tenantId, pageId, pageToken, igId }) {
  const enc = encrypt(pageToken);
  if (!enc) { const e = new Error('falha_cifragem'); e.code = 'enc_fail'; throw e; }
  await withTenant(tenantId, async (c) => {
    // (1) credenciais em tenants — lado lido por pageCredsForTenant (ingestão).
    await c.query(
      'UPDATE tenants SET meta_page_id = $2, meta_page_token_enc = $3, meta_ig_id = $4 WHERE id = $1',
      [tenantId, pageId, enc, igId]
    );
    // (2) tenant_lead_source — lado lido pela resolução. Página trocada => desativa a antiga.
    await c.query(
      "UPDATE tenant_lead_source SET active = false, updated_at = now() WHERE tenant_id = $1 AND platform = 'meta' AND entity_kind = 'fb_page' AND entity_id <> $2 AND active",
      [tenantId, pageId]
    );
    await c.query(
      `INSERT INTO tenant_lead_source (tenant_id, platform, entity_kind, entity_id, active)
            VALUES ($1, 'meta', 'fb_page', $2, true)
       ON CONFLICT (platform, entity_id)
       DO UPDATE SET tenant_id = EXCLUDED.tenant_id, entity_kind = 'fb_page', active = true, updated_at = now()`,
      [tenantId, pageId]
    );
    // (3) IG (opcional) — mantém a resolução de IG DM coerente (entry.id = ig_id).
    if (igId) {
      await c.query(
        "UPDATE tenant_lead_source SET active = false, updated_at = now() WHERE tenant_id = $1 AND platform = 'meta' AND entity_kind = 'ig_account' AND entity_id <> $2 AND active",
        [tenantId, igId]
      );
      await c.query(
        `INSERT INTO tenant_lead_source (tenant_id, platform, entity_kind, entity_id, active)
              VALUES ($1, 'meta', 'ig_account', $2, true)
         ON CONFLICT (platform, entity_id)
         DO UPDATE SET tenant_id = EXCLUDED.tenant_id, entity_kind = 'ig_account', active = true, updated_at = now()`,
        [tenantId, igId]
      );
    }
  });
}

// Orquestra o callback inteiro. Retorna o resultado (inclui o estado REAL da inscrição).
async function handleCallback({ code, state }) {
  const { tenantId, returnTo } = await verifyState(state);
  const userToken = await exchangeCode(code);
  const page = await resolveGrantedPage(userToken);
  await persistConnection({ tenantId, pageId: page.pageId, pageToken: page.pageToken, igId: page.igId });

  // Inscrição leadgen — best-effort, mas o status NÃO mente: falha => subscribed=false.
  let subscribed = false;
  try {
    await subscribeLeadgen(page.pageId, page.pageToken);
    subscribed = (await listSubscribedFields(page.pageId, page.pageToken)).has('leadgen');
  } catch (e) {
    logger.error('meta.onboarding.subscribe_failed', { tenant_id: tenantId, page_id: page.pageId, error: e.message, body: e.body });
  }
  logger.info('meta.onboarding.connected', { tenant_id: tenantId, page_id: page.pageId, ig_id: page.igId, leadgen_subscribed: subscribed });
  return { tenantId, returnTo, pageId: page.pageId, pageName: page.pageName, igId: page.igId, subscribed };
}

// Conecta uma unidade colando um TOKEN de System User (permanente) direto — pula o OAuth
// (exchangeCode). Reusa resolveGrantedPage (via /me/accounts) → persistConnection (cifra+grava
// +dupla-escrita) → subscribe (leadgen+messages+messaging_postbacks). Multi-tenant: cada tenant
// cola o token do PRÓPRIO System User. `deps` injeta os helpers p/ o teste (sem Graph/DB).
async function connectByToken(tenantId, token, deps = {}) {
  const resolve = deps.resolveGrantedPage || resolveGrantedPage;
  const persist = deps.persistConnection || persistConnection;
  const subscribe = deps.subscribeLeadgen || subscribeLeadgen;
  const listFields = deps.listSubscribedFields || listSubscribedFields;
  if (!token || String(token).length < 20) { const e = new Error('token_invalido'); e.code = 'bad_token'; throw e; }
  const page = await resolve(String(token).trim());
  await persist({ tenantId, pageId: page.pageId, pageToken: page.pageToken, igId: page.igId });
  let subscribed = { messages: false, leadgen: false };
  try {
    await subscribe(page.pageId, page.pageToken);
    const set = await listFields(page.pageId, page.pageToken);
    subscribed = { messages: set.has('messages'), leadgen: set.has('leadgen'), postbacks: set.has('messaging_postbacks') };
  } catch (e) {
    logger.error('meta.onboarding.subscribe_failed', { tenant_id: tenantId, page_id: page.pageId, error: e.message, body: e.body });
  }
  logger.info('meta.onboarding.connected_by_token', { tenant_id: tenantId, page_id: page.pageId, ig_id: page.igId, messages_subscribed: subscribed.messages });
  return { pageId: page.pageId, pageName: page.pageName, igId: page.igId, subscribed };
}

// Status legível p/ o dashboard. Checagem VIVA contra a Graph (verdade, não flag que pode driftar):
// também valida o token (expirado/revogado => connected=false, "Erro").
async function connectionStatus(tenantId) {
  const creds = await withTenant(tenantId, (c) =>
    c.query('SELECT meta_page_id, meta_page_token_enc, meta_ig_id FROM tenants WHERE id = $1', [tenantId]).then((r) => r.rows[0])
  );
  if (!creds || !creds.meta_page_id || !creds.meta_page_token_enc) return { connected: false };
  const token = decrypt(creds.meta_page_token_enc);
  if (!token) return { connected: false, error: 'token_ilegivel' };
  try {
    const pg = await graphFetch('GET', '/' + encodeURIComponent(creds.meta_page_id), { fields: 'name', access_token: token });
    const fields = await listSubscribedFields(creds.meta_page_id, token);
    return {
      connected: true, page_name: (pg && pg.name) || null,
      messages_subscribed: fields.has('messages'),   // o que importa p/ DM (não confundir com leadgen)
      leadgen_subscribed: fields.has('leadgen'),
      ig_id: creds.meta_ig_id || null,
    };
  } catch (e) {
    logger.warn('meta.onboarding.status_graph_error', { tenant_id: tenantId, error: e.message });
    return { connected: false, error: 'graph_error' };
  }
}

module.exports = {
  buildStartUrl, verifyState, handleCallback, connectByToken, connectionStatus,
  isAllowedReturnTo, returnToFromState,
  // exportados p/ teste do gate:
  exchangeCode, resolveGrantedPage, subscribeLeadgen, listSubscribedFields, persistConnection,
};
