'use strict';
//
// waEdicao.js — EDIÇÃO CIFRADA do WhatsApp (secretEncryptedMessage). Paridade com o WhatsApp, etapa 2.
//
// O QUE ACONTECIA. O WhatsApp passou a mandar edição de mensagem cifrada: em vez do texto novo chega um
// secretEncryptedMessage (tipo 2 = MESSAGE_EDIT) apontando para a mensagem original. A biblioteca da API
// (Baileys 7) não decifra; o Regente gravava isso como uma BOLHA NOVA "[mensagem de visualização única]"
// e a mensagem original ficava com o texto velho — 785 bolhas falsas até 15/09/2026.
//
// COMO DECIFRAR (confirmado em edição real). Esquema "message secret" do WhatsApp:
//   chave = HKDF-SHA256(ikm = messageSecret da ORIGINAL, salt = 32 zeros,
//                       info = idOriginal + autor + autor + "Message Edit")   ("Event Edit" p/ evento)
//   texto = AES-256-GCM(chave, encIv, encPayload[0..-16], tag = últimos 16 bytes)   — SEM AAD
//   autor = o @lid de quem editou (identificador de privacidade novo), não o número.
// O resultado é um protobuf Message → protocolMessage(12) → editedMessage(14) → texto.
//
// O QUE NÃO DÁ. Mensagem que a ESCOLA enviou pelo WhatsApp Web/celular chega ao Regente sem o
// messageSecret (a API não repassa nem guarda), então a edição dela não é legível: a original fica
// marcada como editada, com o texto que temos. Edição feita pela própria Caixa de Entrada já grava o
// texto novo (routes/inbox.js).
//
const crypto = require('crypto');
const { withTenant } = require('./db');
const logger = require('./logger');

// secretEncType: 1 = EVENT_EDIT, 2 = MESSAGE_EDIT (chega como número ou como nome, conforme a versão)
const USO = { 1: 'Event Edit', 2: 'Message Edit', EVENT_EDIT: 'Event Edit', MESSAGE_EDIT: 'Message Edit' };

function ehEdicaoCifrada(message) {
  const s = message && message.secretEncryptedMessage;
  return !!(s && s.targetMessageKey && s.targetMessageKey.id && (s.secretEncType == null || USO[s.secretEncType]));
}

// Buffer a partir das formas em que bytes aparecem no JSON da API ({"0":12,...}, base64, {type:'Buffer'}).
function bytes(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v, 'base64');
  if (Array.isArray(v)) return Buffer.from(v);
  if (typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
  if (typeof v === 'object') return Buffer.from(Object.keys(v).sort((a, b) => a - b).map((k) => v[k]));
  return null;
}

function _chave(segredo, alvoId, autor, uso) {
  const prk = crypto.createHmac('sha256', Buffer.alloc(32)).update(segredo).digest();
  const info = Buffer.concat([Buffer.from(String(alvoId)), Buffer.from(autor), Buffer.from(autor), Buffer.from(uso)]);
  return crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
}

// Lança se a chave não fecha (tag GCM) — o chamador tenta o próximo candidato.
function decifrar({ segredo, encIv, encPayload, alvoId, autor, uso = 'Message Edit' }) {
  const s = bytes(segredo); const iv = bytes(encIv); const p = bytes(encPayload);
  if (!s || s.length !== 32 || !iv || !p || p.length <= 16) throw new Error('dados_incompletos');
  const d = crypto.createDecipheriv('aes-256-gcm', _chave(s, alvoId, autor, uso), iv);
  d.setAuthTag(p.subarray(p.length - 16));
  return Buffer.concat([d.update(p.subarray(0, p.length - 16)), d.final()]);
}

// Só p/ teste (gera uma edição cifrada como o WhatsApp faria).
function _cifrarParaTeste({ segredo, alvoId, autor, claro, uso = 'Message Edit' }) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', _chave(bytes(segredo), alvoId, autor, uso), iv);
  const enc = Buffer.concat([c.update(claro), c.final(), c.getAuthTag()]);
  return { encIv: iv, encPayload: enc };
}

// ---- leitor protobuf mínimo (só wire format; os números de campo vêm do WAProto) ----
function _lerProto(buf) {
  const out = []; let i = 0;
  const varint = () => {
    let r = 0; let s = 0; let b;
    do { if (i >= buf.length) throw new Error('proto_truncado'); b = buf[i++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80);
    return r;
  };
  while (i < buf.length) {
    const tag = varint(); const f = Math.floor(tag / 8); const wt = tag & 7;
    if (wt === 0) out.push({ f, v: varint() });
    else if (wt === 2) { const n = varint(); if (i + n > buf.length) throw new Error('proto_truncado'); out.push({ f, v: buf.subarray(i, i + n) }); i += n; }
    else if (wt === 5) { out.push({ f, v: buf.subarray(i, i + 4) }); i += 4; }
    else if (wt === 1) { out.push({ f, v: buf.subarray(i, i + 8) }); i += 8; }
    else throw new Error('proto_wire_' + wt);
  }
  return out;
}
const _campo = (buf, n) => { try { const c = _lerProto(buf).find((x) => x.f === n && Buffer.isBuffer(x.v)); return c ? c.v : null; } catch { return null; } };

// Message.conversation(1) | extendedTextMessage(6).text(1) | imageMessage(3).caption(3) | videoMessage(9).caption(7)
function _textoDaMensagem(msg) {
  if (!msg) return null;
  const conv = _campo(msg, 1); if (conv) return conv.toString('utf8');
  const ext = _campo(msg, 6); if (ext) { const t = _campo(ext, 1); if (t) return t.toString('utf8'); }
  const img = _campo(msg, 3); if (img) { const t = _campo(img, 3); if (t) return t.toString('utf8'); }
  const vid = _campo(msg, 9); if (vid) { const t = _campo(vid, 7); if (t) return t.toString('utf8'); }
  return null;
}

// Texto novo de uma edição decifrada: Message → protocolMessage(12) → editedMessage(14) → Message.
function textoDaEdicao(claro) {
  const proto = _campo(claro, 12);
  if (proto) return _textoDaMensagem(_campo(proto, 14));
  return _textoDaMensagem(claro);   // algumas edições vêm já como o Message editado
}

// Mantém o marcador de mídia que o Regente guarda no body ("[imagem] legenda"): editar a legenda de
// uma foto troca só a legenda.
function _comMarcador(novo, antigo) {
  const m = /^\[(imagem|v[íi]deo)\]\s*/i.exec(String(antigo || ''));
  return m ? `${m[0].trim()} ${novo}` : novo;
}

// ---- mapa número <-> @lid ----
const _jid = (j) => String(j || '').replace(/:\d+@/, '@');
const _ehLid = (j) => /@lid$/.test(String(j || ''));
const _ehNumero = (j) => /@s\.whatsapp\.net$/.test(String(j || ''));
const _vistos = new Set();   // evita regravar o mesmo par a cada mensagem

// Pares vistos numa key do payload (participant/participantAlt; remoteJid/remoteJidAlt, em qualquer ordem).
function paresDaKey(key) {
  const k = key || {}; const pares = [];
  for (const [a, b] of [[k.participant, k.participantAlt], [k.remoteJid, k.remoteJidAlt]]) {
    const x = _jid(a); const y = _jid(b);
    if (_ehLid(x) && _ehNumero(y)) pares.push({ lid: x, pn: y });
    else if (_ehLid(y) && _ehNumero(x)) pares.push({ lid: y, pn: x });
  }
  return pares;
}

async function gravarPares(c, tenantId, pares, { proprio = false } = {}) {
  for (const p of pares) {
    const chave = `${tenantId}|${p.lid}|${p.pn || ''}|${proprio}`;
    if (_vistos.has(chave)) continue;
    await c.query(
      `INSERT INTO wa_lid (tenant_id, lid, pn, proprio) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, lid) DO UPDATE SET pn = COALESCE(EXCLUDED.pn, wa_lid.pn),
         proprio = wa_lid.proprio OR EXCLUDED.proprio, visto_em = now()`,
      [tenantId, p.lid, p.pn || null, proprio]);
    _vistos.add(chave);
  }
}

// Chamado pelo webhook em toda mensagem: aprende os pares que o payload traz. Barato (cache em memória).
async function aprenderLids(tenantId, key) {
  const pares = paresDaKey(key);
  if (!pares.length || pares.every((p) => _vistos.has(`${tenantId}|${p.lid}|${p.pn}|false`))) return;
  await withTenant(tenantId, (c) => gravarPares(c, tenantId, pares));
}

// Lista de conversas da API: cada chat @lid traz o número na key da última mensagem. Throttle por tenant.
const _ultimaAtualizacao = new Map();
async function atualizarLidsDaApi(tenantId, deps = {}) {
  const agora = Date.now();
  const ult = _ultimaAtualizacao.get(tenantId) || 0;
  if (agora - ult < (deps.intervaloMs ?? 30 * 60 * 1000)) return 0;
  _ultimaAtualizacao.set(tenantId, agora);
  const outbound = deps.outbound || require('./outbound');
  const evolution = deps.evolution || require('./evolution');
  const cr = await outbound.credsForTenant(tenantId);
  if (!cr.instance || !cr.apikey) return 0;
  const chats = await evolution.findChats({ instance: cr.instance, apikey: cr.apikey });
  const pares = [];
  for (const ch of chats) {
    const key = (ch.lastMessage && ch.lastMessage.key) || {};
    pares.push(...paresDaKey({ remoteJid: ch.remoteJid, remoteJidAlt: key.remoteJidAlt }), ...paresDaKey(key));
  }
  if (pares.length) await withTenant(tenantId, (c) => gravarPares(c, tenantId, pares));
  return pares.length;
}

// @lid candidatos de quem editou.
async function _candidatos(c, tenantId, key, fromMe) {
  const k = key || {};
  const cands = new Set([k.participant, k.remoteJid].filter(_ehLid).map(_jid));
  if (fromMe) {
    const r = await c.query('SELECT lid FROM wa_lid WHERE tenant_id = $1 AND proprio', [tenantId]);
    r.rows.forEach((x) => cands.add(x.lid));
  } else {
    const numero = _jid(/@g\.us$/.test(k.remoteJid || '') ? (_ehNumero(k.participantAlt) ? k.participantAlt : k.participant)
      : (_ehNumero(k.remoteJidAlt) ? k.remoteJidAlt : k.remoteJid));
    if (_ehNumero(numero)) {
      const r = await c.query('SELECT lid FROM wa_lid WHERE tenant_id = $1 AND pn = $2', [tenantId, numero]);
      r.rows.forEach((x) => cands.add(x.lid));
    }
  }
  return [...cands];
}

// Aplica uma edição cifrada na mensagem original. `evento` = { key, message } do payload (data).
// NUNCA cria linha. Resultado: 'editada' (texto novo aplicado) | 'marcada' (sem texto legível: só a
// marca de editada) | 'alvo_ausente'.
async function aplicarEdicaoCifrada(tenantId, evento, deps = {}) {
  const key = (evento && evento.key) || {};
  const sem = evento && evento.message && evento.message.secretEncryptedMessage;
  if (!sem || !sem.targetMessageKey || !sem.targetMessageKey.id) return { resultado: 'invalida' };
  const alvoId = String(sem.targetMessageKey.id);
  const uso = USO[sem.secretEncType] || 'Message Edit';
  const fromMe = key.fromMe === true || key.fromMe === 'true';

  const tentar = async () => withTenant(tenantId, async (c) => {
    await gravarPares(c, tenantId, paresDaKey(key));
    // o @lid da ESCOLA aparece quando um cliente edita numa conversa 1:1: é o chat do ponto de vista dele
    const alvoKey = sem.targetMessageKey;
    if (!fromMe && _ehNumero(key.remoteJid) && _ehLid(alvoKey.remoteJid) && (alvoKey.fromMe === true || alvoKey.fromMe === 'true')) {
      await gravarPares(c, tenantId, [{ lid: _jid(alvoKey.remoteJid), pn: null }], { proprio: true });
    }
    const alvo = (await c.query(
      `SELECT 'messages' AS tabela, id, body, raw FROM messages WHERE tenant_id = $1 AND external_message_id = $2
       UNION ALL
       SELECT 'staff_outbound_samples', id, body, raw FROM staff_outbound_samples WHERE tenant_id = $1 AND external_message_id = $2
       LIMIT 1`, [tenantId, alvoId])).rows[0];
    if (!alvo) return { resultado: 'alvo_ausente' };
    const mci = alvo.raw && ((alvo.raw.data && alvo.raw.data.message && alvo.raw.data.message.messageContextInfo)
      || (alvo.raw.message && alvo.raw.message.messageContextInfo));
    const segredo = mci && mci.messageSecret;
    const cands = segredo ? await _candidatos(c, tenantId, key, fromMe) : [];
    let novo = null;
    for (const autor of cands) {
      try {
        const claro = decifrar({ segredo, encIv: sem.encIv, encPayload: sem.encPayload, alvoId, autor, uso });
        novo = textoDaEdicao(claro);
        if (novo != null) break;
      } catch { /* não é este @lid */ }
    }
    if (novo != null) {
      await c.query(
        `UPDATE ${alvo.tabela} SET original_body = COALESCE(original_body, body), body = $2, edited_at = now() WHERE id = $1`,
        [alvo.id, _comMarcador(novo, alvo.body)]);
      return { resultado: 'editada', tabela: alvo.tabela };
    }
    await c.query(`UPDATE ${alvo.tabela} SET edited_at = COALESCE(edited_at, now()) WHERE id = $1`, [alvo.id]);
    return { resultado: 'marcada', tabela: alvo.tabela, motivo: !segredo ? 'sem_segredo' : (cands.length ? 'nao_abriu' : 'sem_lid'), faltaLid: !!segredo && !cands.length };
  });

  let r = await tentar();
  // faltou o @lid de um cliente: atualiza o mapa pela lista de conversas da API e tenta de novo (uma vez)
  if (r.resultado === 'marcada' && r.faltaLid && !fromMe) {
    try {
      const novos = await atualizarLidsDaApi(tenantId, deps);
      if (novos) r = await tentar();
    } catch (e) { logger.warn('wa_edicao.lids_api_falhou', { tenant_id: tenantId, error: e.message }); }
  }
  logger.info('wa_edicao.aplicada', { tenant_id: tenantId, resultado: r.resultado, motivo: r.motivo || null, tabela: r.tabela || null });
  return r;
}

module.exports = {
  ehEdicaoCifrada, decifrar, textoDaEdicao, aplicarEdicaoCifrada, aprenderLids, atualizarLidsDaApi, paresDaKey, bytes,
  _cifrarParaTeste, _lerProto, _comMarcador,
};
