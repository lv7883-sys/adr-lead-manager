'use strict';

// extranet-client.js — CLIENTE da plataforma Extranet (ADR-026). ESPECÍFICO da fonte
// SCRAPE_EXTRANET: login, sessão de vida longa e fetch autenticado sob throttle. Porta a
// disciplina comprovada do scheduler (dashboard/lib/extranet.js) — UA Chrome/147 (forma
// que evita o 429 do WAF), gap serial entre requisições, cooldown de 10min em 403/429,
// sessão reusada de disco — mas é AUTÔNOMO do scheduler (Opção A): arquivo de sessão e
// chave de cifra próprios, sem require cross-repo.
//
// FRONTEIRA (ADR-026 §2.6): isto é camada de ADAPTER (conhece a Extranet). O core
// (sync.js) não importa nada daqui. _assertValinhos fica: scraping é Valinhos-only por
// desenho (momento 0); outras fontes entram por adapters API/NATIVE.
//
// SERIALIZAÇÃO entre apps (429): NÃO é responsabilidade deste módulo — quem segura o
// pg_advisory_lock (extranet-lock.js) é o RUNNER, em volta de todo o acesso do binding.

const fs = require('fs');
const path = require('path');

const EXTRANET = 'https://dash.academiadorock.com.br';
// UA da receita ADR-BI (Windows Chrome 147): a forma que volta 200; o UA antigo tomava 429.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36';
const VALINHOS_ID_UNIDADE = 13;

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

async function _request(url, opts = {}, { expectCap = false } = {}) {
  const restante = emCooldown();
  if (restante) throw tag(new Error(`extranet: em cooldown de rate-limit (~${restante}s) — pulando requisição`), 'BLOCK');
  const gap = MIN_GAP_MS + Math.floor(Math.random() * GAP_JITTER_MS);
  const espera = _lastReqAt + gap - Date.now();
  if (espera > 0) await _sleep(espera);
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

// ---- LOCK-DOWN Valinhos-only (momento 0) ----
function _assertValinhos(unidade, ctx) {
  if (Number(unidade) !== VALINHOS_ID_UNIDADE) {
    throw new Error(`extranet[LOCK]: só Valinhos (id_unidade=${VALINHOS_ID_UNIDADE}) permitido; recebido ${JSON.stringify(unidade)}${ctx ? ' (' + ctx + ')' : ''}`);
  }
}

// ---- LOGIN: GET / (cap) → POST send_login (302 c/ cookie de unidade) ----
// A senha decifrada chega só aqui, vai no corpo do POST e nunca toca log/disco.
async function login(creds) {
  if (!creds || !creds.email || !creds.senha) throw tag(new Error('login: email/senha obrigatórios'), 'CREDENTIAL');
  _assertValinhos(creds.unidade, 'login');
  const jar = {};

  const r1 = await _request(`${EXTRANET}/`, { headers: { 'User-Agent': UA }, redirect: 'follow' }, { expectCap: true });
  mergeSetCookies(r1.headers, jar);
  const capMatch = r1.body.match(/name="cap"[^>]*value="([^"]+)"/);
  if (!capMatch) throw tag(new Error('login: campo `cap` não encontrado (provável desafio/bloqueio)'), 'BLOCK');
  const cap = capMatch[1];

  const body = new URLSearchParams({
    email:      creds.email,
    senha:      creds.senha,
    perfil:     String(creds.perfil ?? 1),
    id_unidade: String(creds.unidade ?? ''),
    cap,
  }).toString();
  const nAntes = Object.keys(jar).length;
  const r2 = await _request(`${EXTRANET}/send_login.php`, {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Cookie': cookieHeader(jar), 'Origin': EXTRANET,
      'Referer': `${EXTRANET}/`, 'Content-Type': 'application/x-www-form-urlencoded',
    },
    body, redirect: 'manual',
  });
  mergeSetCookies(r2.headers, jar);
  const loc2 = (r2.headers && typeof r2.headers.get === 'function') ? (r2.headers.get('location') || '') : '';
  if (/\/erro_login\.php(\?|$)/.test(loc2) || /\/erro_login\.php(\?|$)/.test(r2.url)) {
    throw tag(new Error('login: falha na autenticação (credenciais ou unidade incorretas)'), 'CREDENTIAL');
  }
  if (/\/sair\.php(\?|$)/.test(loc2)) throw tag(new Error('login: sessão inválida (redirect p/ /sair.php)'), 'CREDENTIAL');
  if (Object.keys(jar).length <= nAntes) throw tag(new Error('login: sessão não autenticada (sem cookie de unidade)'), 'CREDENTIAL');
  _stats.logins++;
  return { cookie: cookieHeader(jar) };
}

// ---- SESSÃO de vida longa: memória → disco → login (último recurso) ----
const _mem = new Map();
const _key = (c) => `${c.email || ''}|${c.unidade ?? ''}|${c.perfil ?? ''}`;

async function getSession(creds, { force = false } = {}) {
  _assertValinhos(creds && creds.unidade, 'getSession');
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
async function fetchAuthed(p, session) {
  const r = await _request(`${EXTRANET}${p}`, {
    headers: { 'User-Agent': UA, 'Cookie': session.cookie, 'X-Requested-With': 'fetch' },
    redirect: 'follow',
  });
  const urlLogin = /\/(index|logon)\.php(\?|$)/.test(r.url) && !/api-salas-grade|monta_lista/.test(p);
  if (urlLogin || /send_login\.php/.test(r.body)) throw tag(new Error('fetchAuthed: sessão expirada (redirect/conteúdo de login)'), 'SESSION_EXPIRED');
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
  login, getSession, invalidateSession, fetchAuthed, transportFor,
  EXTRANET, UA, VALINHOS_ID_UNIDADE, SESSION_FILE, stats,
};
