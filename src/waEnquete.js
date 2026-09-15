'use strict';
//
// waEnquete.js — VOTO DE ENQUETE do WhatsApp (pollUpdateMessage). Paridade com o WhatsApp, etapa 3.
//
// O voto chega cifrado com o segredo da enquete (mesmo esquema "message secret" da edição, mas COM AAD —
// é o que o Baileys faz em decryptPollVote):
//   chave = HKDF-SHA256(ikm = messageSecret da ENQUETE, salt = 32 zeros, info = idEnquete + criador + votante + "Poll Vote")
//   texto = AES-256-GCM(chave, encIv, encPayload, AAD = idEnquete + "\0" + votante)
// O resultado é PollVoteMessage { selectedOptions(1): SHA-256 do nome de cada opção escolhida }.
// Cada novo voto de uma pessoa SUBSTITUI o anterior (como no WhatsApp). Nunca vira bolha.
//
const crypto = require('crypto');
const { withTenant } = require('./db');
const logger = require('./logger');
const { bytes, _lerProto } = require('./waEdicao');

const _jid = (j) => String(j || '').replace(/:\d+@/, '@');
const _ehLid = (j) => /@lid$/.test(String(j || ''));
const _ehNumero = (j) => /@s\.whatsapp\.net$/.test(String(j || ''));

function ehVoto(message) {
  const u = message && message.pollUpdateMessage;
  return !!(u && u.pollCreationMessageKey && u.pollCreationMessageKey.id && u.vote);
}

function _chave(segredo, id, criador, votante) {
  const prk = crypto.createHmac('sha256', Buffer.alloc(32)).update(segredo).digest();
  const info = Buffer.concat([Buffer.from(id), Buffer.from(criador), Buffer.from(votante), Buffer.from('Poll Vote'), Buffer.from([1])]);
  return crypto.createHmac('sha256', prk).update(info).digest();
}

function decifrarVoto({ segredo, encIv, encPayload, enqueteId, criador, votante }) {
  const s = bytes(segredo); const iv = bytes(encIv); const p = bytes(encPayload);
  if (!s || s.length !== 32 || !iv || !p || p.length <= 16) throw new Error('dados_incompletos');
  const d = crypto.createDecipheriv('aes-256-gcm', _chave(s, enqueteId, criador, votante), iv);
  d.setAAD(Buffer.from(`${enqueteId}\0${votante}`));
  d.setAuthTag(p.subarray(p.length - 16));
  return Buffer.concat([d.update(p.subarray(0, p.length - 16)), d.final()]);
}

function _cifrarVotoParaTeste({ segredo, enqueteId, criador, votante, claro }) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', _chave(bytes(segredo), enqueteId, criador, votante), iv);
  c.setAAD(Buffer.from(`${enqueteId}\0${votante}`));
  return { encIv: iv, encPayload: Buffer.concat([c.update(claro), c.final(), c.getAuthTag()]) };
}

// PollVoteMessage -> nomes das opções escolhidas (casando o SHA-256 de cada opção)
function opcoesDoVoto(claro, opcoes) {
  const porHash = new Map((opcoes || []).map((o) => [crypto.createHash('sha256').update(Buffer.from(o, 'utf8')).digest('hex'), o]));
  let campos = [];
  try { campos = _lerProto(claro); } catch { return []; }
  return campos.filter((c) => c.f === 1 && Buffer.isBuffer(c.v)).map((c) => porHash.get(c.v.toString('hex'))).filter(Boolean);
}

async function _variantes(c, tenantId, jid) {
  const j = _jid(jid); const out = new Set([j].filter(Boolean));
  if (_ehNumero(j)) (await c.query('SELECT lid FROM wa_lid WHERE tenant_id = $1 AND pn = $2', [tenantId, j])).rows.forEach((r) => out.add(r.lid));
  if (_ehLid(j)) (await c.query('SELECT pn FROM wa_lid WHERE tenant_id = $1 AND lid = $2 AND pn IS NOT NULL', [tenantId, j])).rows.forEach((r) => out.add(r.pn));
  return [...out];
}

// evento = { key, message, pushName } do payload (data). Resultado: 'votou' | 'nao_abriu' | 'enquete_ausente'.
async function aplicarVoto(tenantId, evento) {
  const key = (evento && evento.key) || {};
  const up = evento.message.pollUpdateMessage;
  const enqKey = up.pollCreationMessageKey;
  const r = await withTenant(tenantId, async (c) => {
    const alvo = (await c.query(
      `SELECT 'messages' AS tabela, id, conteudo, raw FROM messages WHERE tenant_id = $1 AND external_message_id = $2
       UNION ALL
       SELECT 'staff_outbound_samples', id, conteudo, raw FROM staff_outbound_samples WHERE tenant_id = $1 AND external_message_id = $2
       LIMIT 1`, [tenantId, String(enqKey.id)])).rows[0];
    if (!alvo) return { resultado: 'enquete_ausente' };
    const opcoes = (alvo.conteudo && alvo.conteudo.opcoes) || [];
    const mci = alvo.raw && alvo.raw.data && alvo.raw.data.message && alvo.raw.data.message.messageContextInfo;
    const segredo = mci && mci.messageSecret;
    if (!segredo) return { resultado: 'nao_abriu', motivo: 'sem_segredo' };
    // criador: quem mandou a enquete (participante no grupo; o chat no 1:1; a escola se fromMe)
    const ak = (alvo.raw.data && alvo.raw.data.key) || {};
    const criadorBase = enqKey.participant || ak.participant || (ak.fromMe ? null : ak.remoteJid);
    const criadores = criadorBase ? await _variantes(c, tenantId, criadorBase)
      : (await c.query('SELECT lid FROM wa_lid WHERE tenant_id = $1 AND proprio', [tenantId])).rows.map((x) => x.lid);
    const votanteBase = /@g\.us$/.test(key.remoteJid || '') ? (key.participantAlt || key.participant) : (key.remoteJidAlt || key.remoteJid);
    const votantes = [...new Set([...(await _variantes(c, tenantId, votanteBase)), ...(await _variantes(c, tenantId, key.participant))])].filter(Boolean);
    let escolhidas = null;
    for (const criador of criadores) {
      for (const votante of votantes) {
        try { escolhidas = opcoesDoVoto(decifrarVoto({ segredo, encIv: up.vote.encIv, encPayload: up.vote.encPayload, enqueteId: String(enqKey.id), criador, votante }), opcoes); break; } catch { /* outra combinação */ }
      }
      if (escolhidas) break;
    }
    if (!escolhidas) return { resultado: 'nao_abriu', motivo: 'sem_chave' };
    const quem = String(votanteBase || key.participant || '').split('@')[0].replace(/\D/g, '') || 'desconhecido';
    await c.query(
      `UPDATE ${alvo.tabela}
          SET conteudo = jsonb_set(coalesce(conteudo, '{}'::jsonb), ARRAY['votos', $2::text], $3::jsonb, true)
        WHERE id = $1`,
      [alvo.id, quem, JSON.stringify({ nome: evento.pushName || null, opcoes: escolhidas, em: Date.now() })]);
    return { resultado: 'votou', escolhidas: escolhidas.length };
  });
  logger.info('wa_enquete.voto', { tenant_id: tenantId, resultado: r.resultado, motivo: r.motivo || null });
  return r;
}

module.exports = { ehVoto, aplicarVoto, decifrarVoto, opcoesDoVoto, _cifrarVotoParaTeste };
