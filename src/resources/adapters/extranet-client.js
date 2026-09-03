'use strict';

// extranet-client.js — CLIENTE da plataforma Extranet (ADR-026). ESPECÍFICO da fonte
// SCRAPE_EXTRANET: login, sessão de vida longa e fetch autenticado sob throttle. Porta a
// disciplina comprovada do scheduler (dashboard/lib/extranet.js) — UA Chrome/147 (forma
// que evita o 429 do WAF), gap serial entre requisições, cooldown de 10min em 403/429,
// sessão reusada de disco — mas é AUTÔNOMO do scheduler (Opção A): arquivo de sessão e
// chave de cifra próprios, sem require cross-repo.
//
// FRONTEIRA (ADR-026 §2.6): isto é camada de ADAPTER (conhece a Extranet). O core
// (sync.js) não importa nada daqui. As unidades habilitadas p/ scrape são deliberadas por
// env (UNIDADES_PERMITIDAS, default Valinhos); outras fontes entram por adapters API/NATIVE.
//
// SERIALIZAÇÃO entre apps (429): NÃO é responsabilidade deste módulo — quem segura o
// pg_advisory_lock (extranet-lock.js) é o RUNNER, em volta de todo o acesso do binding.

const fs = require('fs');
const path = require('path');

const EXTRANET = 'https://dash.academiadorock.com.br';
// UA da receita ADR-BI (Windows Chrome 147): a forma que volta 200; o UA antigo tomava 429.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36';
// Unidades da Extranet HABILITADAS (rollout deliberado por unidade). Default '13' (Valinhos) —
// retrocompatível: sem env, o comportamento é o de antes. Para ligar outra unidade, setar
// EXTRANET_UNIDADES_PERMITIDAS='13,14' (env), SEM tocar em código. A unidade é server-side pela
// CONTA (email/senha); este guard evita usar credenciais de uma unidade ainda não validada.
const UNIDADES_PERMITIDAS = String(process.env.EXTRANET_UNIDADES_PERMITIDAS || '13')
  .split(',').map((s) => Number(String(s).trim())).filter((n) => Number.isInteger(n) && n > 0);
// A extranet migrou o login p/ SSO/Keycloak (OIDC): dois hosts distintos, cada um com
// cookies próprios → o login usa cookie jar POR HOST (ver login() abaixo).
const DASH_HOST = new URL(EXTRANET).host;         // dash.academiadorock.com.br
const AUTH_HOST = 'auth.academiadorock.com.br';   // Keycloak (realm "academia")

const MIN_GAP_MS       = Math.max(10000, Number(process.env.EXTRANET_MIN_GAP_MS ?? 25000)); // gap serial (default 25s)
const GAP_JITTER_MS    = 4000;
const COOLDOWN_MS      = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.EXTRANET_FETCH_TIMEOUT_MS ?? 25000));
const SESSION_TTL_MS   = Number(process.env.EXTRANET_SESSION_TTL_MIN ?? 720) * 60 * 1000; // 12h
// Arquivo de sessão PRÓPRIO do LM (autônomo). Default em /app/uploads (único mount
// persistente do container → sobrevive a rebuild). Só guarda cookie (nunca a senha).
const SESSION_FILE     = process.env.RESOURCES_EXTRANET_SESSION_FILE || '/app/uploads/.resources/extranet-session.json';

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _stats = { logins: 0, reqs: 0, reusedFromDisk: 0 };

// Tipagem de erro na FONTE (ADR-026 Passo 4): o runner classifica por err.code sem
// conhecer a Extranet. CREDENTIAL = humano resolve (login rejeitado); BLOCK/TIMEOUT/
// SESSION_EXPIRED = transitório (se auto-resolve).
const tag = (err, code) => { err.code = code; return err; };

// ---- cookie jar ----
function mergeSetCookies(headers, jar) {
  const list = (typeof headers.getSetCookie === 'function') ? headers.getSetCookie() : [];
  for (const sc of list) {
    const head = sc.split(';', 1)[0];
    const eq = head.indexOf('=');
    if (eq < 0) continue;
    const k = head.slice(0, eq).trim();
    const v = head.slice(eq + 1).trim();
    if (k) jar[k] = v;
  }
  return jar;
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
// cookie jar POR HOST (o login SSO cruza dash ↔ Keycloak; cada um seta cookies próprios).
function _mergeSetCookiesHost(jars, host, headers) { mergeSetCookies(headers, (jars[host] = jars[host] || {})); }
function _cookieHeaderHost(jars, host) { return cookieHeader(jars[host] || {}); }

// ---- persistência de sessão + cooldown (mesmo arquivo, chave reservada) ----
function _readFile() { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return {}; } }
function _writeFile(all) {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(all), { mode: 0o600 });
  } catch (_e) { /* best-effort; nunca derruba o fluxo */ }
}
let _blockedUntil = Number(_readFile().__blockedUntil || 0); // boot: respeita cooldown remanescente
function _saveBlockedUntil(ts) { const all = _readFile(); all.__blockedUntil = ts; _writeFile(all); }
function emCooldown() { return Date.now() < _blockedUntil ? Math.ceil((_blockedUntil - Date.now()) / 1000) : 0; }

// ---- throttle serial + timeout duro ----
let _lastReqAt = 0;
async function _fetchComTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const body = await r.text();              // corpo TAMBÉM sob o abort
    return { status: r.status, url: r.url || url, ok: r.ok, body, headers: r.headers };
  } catch (e) {
    if (e && e.name === 'AbortError') throw tag(new Error(`extranet: timeout de ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`), 'TIMEOUT');
    throw tag(e, e.code || 'NETWORK'); // fetch failed/ENOTFOUND/ECONNREFUSED → transitório
  } finally { clearTimeout(timer); }
}

function detectBlock(status, body, { expectCap = false } = {}) {
  if (status === 403 || status === 429) return true;
  if (expectCap && status === 200 && !/name="cap"/.test(body || '')) return true; // desafio LiteSpeed
  return false;
}

// throttleGap() — espera o gap serial DESDE a última requisição, SEM disparar requisição
// e SEM segurar nada. Usado pela leitura ao vivo (recepção) p/ espaçar as chamadas com o
// gap FORA do pg_advisory_lock — o lock fica retido só durante o GET (~0,5s), não durante
// a espera. A varredura diária segue com o gap embutido no _request (noGap=false).
async function throttleGap() {
  const gap = MIN_GAP_MS + Math.floor(Math.random() * GAP_JITTER_MS);
  const espera = _lastReqAt + gap - Date.now();
  if (espera > 0) await _sleep(espera);
}

async function _request(url, opts = {}, { expectCap = false, noGap = false } = {}) {
  const restante = emCooldown();
  if (restante) throw tag(new Error(`extranet: em cooldown de rate-limit (~${restante}s) — pulando requisição`), 'BLOCK');
  if (!noGap) {                                   // noGap: o chamador já espaçou (throttleGap) FORA do lock
    const gap = MIN_GAP_MS + Math.floor(Math.random() * GAP_JITTER_MS);
    const espera = _lastReqAt + gap - Date.now();
    if (espera > 0) await _sleep(espera);
  }
  _lastReqAt = Date.now();
  _stats.reqs++;
  const r = await _fetchComTimeout(url, opts);
  if (detectBlock(r.status, r.body, { expectCap })) {
    _blockedUntil = Date.now() + COOLDOWN_MS;
    _saveBlockedUntil(_blockedUntil);
    throw tag(new Error(`extranet: bloqueio detectado (HTTP ${r.status}) — cooldown de 10min`), 'BLOCK');
  }
  return r;
}

// ---- Guard de unidade habilitada (parametrizável por env; ver UNIDADES_PERMITIDAS) ----
function _assertUnidadePermitida(unidade, ctx) {
  if (!UNIDADES_PERMITIDAS.includes(Number(unidade))) {
    throw new Error(`extranet[LOCK]: unidade id_unidade=${JSON.stringify(unidade)} não habilitada${ctx ? ' (' + ctx + ')' : ''}. Habilite em EXTRANET_UNIDADES_PERMITIDAS (atuais: ${UNIDADES_PERMITIDAS.join(',') || 'nenhuma'}).`);
  }
}

// Caminha os redirects À MÃO acumulando cookies POR HOST. Manual porque o fetch nativo
// não tem cookie jar e o redirect:'follow' descartaria o PHPSESSID (setado no 1º hop) que
// carrega o code_verifier PKCE necessário pro callback. Cada hop passa por _request →
// herda gap serial + cooldown + timeout + detectBlock (403/429). Para no 1º não-3xx.
async function _walk(jars, method, url, { body, headers = {} } = {}, maxHops = 8) {
  let curMethod = method, curUrl = url, curBody = body, curHeaders = headers;
  for (let i = 0; i < maxHops; i++) {
    const host = new URL(curUrl).host;
    const h = { 'User-Agent': UA, ...curHeaders };
    const ck = _cookieHeaderHost(jars, host);
    if (ck) h['Cookie'] = ck;
    const r = await _request(curUrl, { method: curMethod, headers: h, body: curBody, redirect: 'manual' });
    _mergeSetCookiesHost(jars, host, r.headers);
    const loc = (r.headers && typeof r.headers.get === 'function') ? (r.headers.get('location') || '') : '';
    if (r.status >= 300 && r.status < 400 && loc) {
      curUrl = new URL(loc, curUrl).toString();
      curMethod = 'GET'; curBody = undefined; curHeaders = {};
      continue;
    }
    return { status: r.status, url: curUrl, ok: r.ok, body: r.body, headers: r.headers, location: loc };
  }
  throw tag(new Error('login: excesso de redirects'), 'BLOCK');
}

// ---- LOGIN via SSO/Keycloak (OIDC Authorization Code + PKCE) ----
// A extranet aposentou o form próprio (cap + send_login.php). Fluxo (mesmo do scheduler,
// dashboard/lib/extranet.js): 1) GET / → cadeia até o form do Keycloak (PHPSESSID do 1º
// hop guarda o code_verifier PKCE); 2) POST username/senha no login-actions/authenticate
// → 302 callback.php?code=…; 3) GET callback.php (com o PHPSESSID) → o dash troca
// code→token → /logon.php autenticado. Retorna { cookie } com os cookies do DASH.
// A senha decifrada chega só aqui, vai no corpo do POST ao Keycloak e nunca toca log/disco.
async function login(creds) {
  if (!creds || !creds.email || !creds.senha) throw tag(new Error('login: email/senha obrigatórios'), 'CREDENTIAL');
  _assertUnidadePermitida(creds.unidade, 'login');
  const jars = {};

  // 1) GET / → segue até o form do Keycloak.
  const form = await _walk(jars, 'GET', `${EXTRANET}/`);
  if (form.status !== 200 || new URL(form.url).host !== AUTH_HOST) {
    throw tag(new Error(`login: não chegou ao form do Keycloak (status ${form.status})`), 'BLOCK');
  }
  const actionM = form.body.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/i)
             || form.body.match(/<form[^>]*action="([^"]*login-actions\/authenticate[^"]*)"/i);
  if (!actionM) throw tag(new Error('login: form do Keycloak (kc-form-login) não encontrado'), 'BLOCK');
  const action = new URL(actionM[1].replace(/&amp;/g, '&'), form.url).toString();
  const authHost = new URL(action).host;

  // 2) POST credenciais no Keycloak. Sucesso → 302 callback.php?code=… ; 200 = recusa.
  const body = new URLSearchParams({ username: creds.email, password: creds.senha, credentialId: '' }).toString();
  const r2 = await _request(action, {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Cookie': _cookieHeaderHost(jars, authHost), 'Origin': `https://${authHost}`,
      'Referer': form.url, 'Content-Type': 'application/x-www-form-urlencoded',
    },
    body, redirect: 'manual',
  });
  _mergeSetCookiesHost(jars, authHost, r2.headers);
  const loc2 = (r2.headers && typeof r2.headers.get === 'function') ? (r2.headers.get('location') || '') : '';
  if (r2.status === 200) throw tag(new Error('login: falha na autenticação (Keycloak recusou email/senha)'), 'CREDENTIAL');
  if (!(r2.status >= 300 && r2.status < 400) || !/\/auth\/callback\.php/.test(loc2)) {
    throw tag(new Error(`login: resposta inesperada do Keycloak (status ${r2.status})`), 'BLOCK');
  }

  // 3) GET callback.php (com o PHPSESSID do passo 1) → dash conclui o PKCE e autentica.
  const cb = await _walk(jars, 'GET', new URL(loc2, action).toString());
  const cbUrl = new URL(cb.url);
  const voltouLogin = cbUrl.host === AUTH_HOST || /\/(sso|auth)\//.test(cbUrl.pathname) || /kc-form-login|send_login/.test(cb.body || '');
  const dashCookie = _cookieHeaderHost(jars, DASH_HOST);
  if (voltouLogin || !dashCookie) throw tag(new Error('login: sessão não autenticada após callback'), 'BLOCK');
  _stats.logins++;
  return { cookie: dashCookie };
}

// ---- SESSÃO de vida longa: memória → disco → login (último recurso) ----
const _mem = new Map();
const _key = (c) => `${c.email || ''}|${c.unidade ?? ''}|${c.perfil ?? ''}`;

async function getSession(creds, { force = false } = {}) {
  _assertUnidadePermitida(creds && creds.unidade, 'getSession');
  const k = _key(creds);
  if (!force) {
    const mem = _mem.get(k);
    if (mem && (Date.now() - mem.ts) < SESSION_TTL_MS) return mem.session;
    const disk = _readFile()[k];
    if (disk && disk.session && (Date.now() - disk.ts) < SESSION_TTL_MS) {
      _mem.set(k, disk);
      _stats.reusedFromDisk++;
      return disk.session;
    }
  }
  const session = await login(creds);
  const entry = { session, ts: Date.now() };
  _mem.set(k, entry);
  const all = _readFile(); all[k] = entry; _writeFile(all);   // só o cookie vai a disco
  return session;
}

function invalidateSession(creds) {
  const k = _key(creds);
  _mem.delete(k);
  const all = _readFile(); delete all[k]; _writeFile(all);
}

// ---- fetch autenticado: detecta sessão caída (redirect/conteúdo de login) ----
async function fetchAuthed(p, session, { noGap = false } = {}) {
  const r = await _request(`${EXTRANET}${p}`, {
    headers: { 'User-Agent': UA, 'Cookie': session.cookie, 'X-Requested-With': 'fetch' },
    redirect: 'follow',
  }, { noGap });
  // Sessão caída agora redireciona p/ o SSO/Keycloak (não mais p/ logon.php, que virou a
  // HOME autenticada). Detecta por host/caminho do SSO e por conteudo do form do Keycloak.
  let hostFinal = ''; try { hostFinal = new URL(r.url).host; } catch { /* url atípica */ }
  const urlLogin = hostFinal === AUTH_HOST || /\/(sso|auth)\//.test(r.url);
  const conteudoLogin = /send_login\.php|kc-form-login|login-actions\/authenticate/.test(r.body);
  if (urlLogin || conteudoLogin) throw tag(new Error('fetchAuthed: sessão expirada (redirect/conteúdo de login)'), 'SESSION_EXPIRED');
  return r.body;
}

// transportFor(creds) → transport(path)→html p/ o adapter.fetch(). Resolve sessão
// (disco/login) e, se a sessão cair no meio, re-loga UMA vez e tenta de novo.
function transportFor(creds) {
  return async function transport(p) {
    let session = await getSession(creds);
    try {
      return await fetchAuthed(p, session);
    } catch (e) {
      if (!/sessão expirada/.test(e.message)) throw e;
      invalidateSession(creds);
      session = await getSession(creds, { force: true });
      return await fetchAuthed(p, session);
    }
  };
}

function stats() { return { ..._stats, cooldownSec: emCooldown(), sessionFile: SESSION_FILE }; }

module.exports = {
  login, getSession, invalidateSession, fetchAuthed, transportFor, throttleGap,
  EXTRANET, UA, UNIDADES_PERMITIDAS, SESSION_FILE, stats,
};
