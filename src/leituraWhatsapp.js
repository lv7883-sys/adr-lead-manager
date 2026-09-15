'use strict';
// leituraWhatsapp.js — paridade com o WhatsApp, etapa 4: o estado de LEITURA vai do Regente para o WhatsApp.
//
// No WhatsApp Web, abrir a conversa marca as mensagens como lidas em TODOS os aparelhos (some o contador do
// celular e o cliente vê os tiques azuis, se a escola não desligou a confirmação de leitura — o próprio
// WhatsApp respeita essa privacidade). "Marcar como não lida" também vale para todos. No Regente, abrir a
// conversa só mexia no cursor local: o celular continuava com a conversa não lida e o cliente sem tique azul.
//
// Sentido contrário (celular/Web -> Regente): a leitura já chega pelo recibo (webhook marcarLidoPorRecibo).
// "Marcar como não lida" feito no CELULAR não chega: a Evolution 2.3.7 manda chats.update só com o id do
// chat (sem contador) — limite da Evolution, não do Regente.
const { withTenant } = require('./db');
const logger = require('./logger');
const { naoEhReacaoSql } = require('./reacao');

const LIMITE = 100;   // o WhatsApp Web também manda um recibo por mensagem; 100 cobre qualquer conversa real

// Jid que a Evolution aceita para ler: número (@s.whatsapp.net) ou grupo (@g.us). Quem escreve com @lid
// chega com o número em remoteJidAlt; sem ele, o par aprendido em wa_lid; por fim o número da conversa.
function _jidLegivel(k, pnDoLid, externalId, ehGrupo) {
  if (ehGrupo) return /@g\.us$/.test(String(k.remoteJid || '')) ? k.remoteJid : (String(externalId).includes('@g.us') ? externalId : null);
  const rj = String(k.remoteJid || '');
  if (/@s\.whatsapp\.net$/.test(rj)) return rj;
  if (/@s\.whatsapp\.net$/.test(String(k.remoteJidAlt || ''))) return k.remoteJidAlt;
  if (/@lid$/.test(rj) && pnDoLid[rj]) return `${pnDoLid[rj]}@s.whatsapp.net`;
  const dig = String(externalId || '').replace(/\D/g, '');
  return dig.length >= 10 && dig.length <= 15 ? `${dig}@s.whatsapp.net` : null;
}

// Chaves das mensagens RECEBIDAS que ficaram lidas agora: recebidas depois do cursor anterior e até o novo.
async function chavesParaLer(c, tenantId, conversationId, desde, ate) {
  const rows = (await c.query(
    `SELECT m.external_message_id AS id, m.raw#>'{data,key}' AS k, cv.external_id, cv.conversation_kind
       FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
      WHERE m.conversation_id = $1 AND cv.tenant_id = $2 AND m.role = 'USER'
        AND m.external_message_id IS NOT NULL AND m.deleted_at IS NULL AND ${naoEhReacaoSql('m')}
        AND ($3::timestamptz IS NULL OR m.received_at > $3::timestamptz) AND m.received_at <= $4::timestamptz
      ORDER BY m.received_at DESC LIMIT ${LIMITE}`,
    [conversationId, tenantId, desde || null, ate])).rows;
  if (!rows.length) return [];
  const lids = [...new Set(rows.map((r) => r.k && r.k.remoteJid).filter((j) => /@lid$/.test(String(j || ''))))];
  const pnDoLid = {};
  if (lids.length) {
    for (const r of (await c.query(`SELECT lid, pn FROM wa_lid WHERE tenant_id = $1 AND lid = ANY($2::text[]) AND pn IS NOT NULL`, [tenantId, lids])).rows) {
      pnDoLid[r.lid] = String(r.pn).replace(/\D/g, '');
    }
  }
  const vistos = new Set();
  const out = [];
  for (const r of rows) {
    if (vistos.has(r.id)) continue;
    vistos.add(r.id);
    const k = r.k || {};
    const ehGrupo = r.conversation_kind === 'GROUP' || String(r.external_id).includes('@g.us');
    const remoteJid = _jidLegivel(k, pnDoLid, r.external_id, ehGrupo);
    if (remoteJid) out.push({ remoteJid, fromMe: false, id: String(r.id) });
  }
  return out;
}

// Depois que o cursor do Regente avançou: manda a leitura para o WhatsApp. Best-effort (nunca derruba a tela).
async function lerNoWhatsapp(tenantId, conversationId, desde, ate, deps = {}) {
  try {
    const run = deps.withTenant || withTenant;
    const chaves = await run(tenantId, (c) => chavesParaLer(c, tenantId, conversationId, desde, ate));
    if (!chaves.length) return { enviadas: 0 };
    const creds = await (deps.credsForTenant || require('./outbound').credsForTenant)(tenantId);
    if (!creds || !creds.instance || !creds.apikey) return { enviadas: 0, reason: 'tenant_sem_evolution' };
    await (deps.evolution || require('./evolution')).markMessageAsRead(creds, chaves);
    return { enviadas: chaves.length };
  } catch (e) {
    logger.warn('inbox.leitura_whatsapp_falhou', { tenant_id: tenantId, conversation_id: conversationId, error: e.message });
    return { enviadas: 0, erro: e.message };
  }
}

// "Marcar como não lida" no Regente -> a conversa volta a ficar não lida no celular e no Web.
async function marcarNaoLidaNoWhatsapp(tenantId, conversationId, deps = {}) {
  try {
    const run = deps.withTenant || withTenant;
    const ult = await run(tenantId, async (c) => (await c.query(
      `SELECT m.external_message_id AS id, m.raw#>'{data,key}' AS k, m.received_at, cv.external_id, cv.conversation_kind
         FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
        WHERE m.conversation_id = $1 AND cv.tenant_id = $2 AND m.role = 'USER' AND m.external_message_id IS NOT NULL
          AND ${naoEhReacaoSql('m')}
        ORDER BY m.received_at DESC LIMIT 1`, [conversationId, tenantId])).rows[0]);
    if (!ult) return { ok: false, reason: 'sem_mensagem_recebida' };
    const k = ult.k || {};
    const ehGrupo = ult.conversation_kind === 'GROUP' || String(ult.external_id).includes('@g.us');
    // o chat é o do próprio WhatsApp (pode ser @lid): é a mesma chave que o celular usa na lista de conversas
    const remoteJid = k.remoteJid || _jidLegivel(k, {}, ult.external_id, ehGrupo);
    if (!remoteJid) return { ok: false, reason: 'sem_jid' };
    const key = { remoteJid, fromMe: false, id: String(ult.id) };
    if (ehGrupo && k.participant) key.participant = k.participant;
    const creds = await (deps.credsForTenant || require('./outbound').credsForTenant)(tenantId);
    if (!creds || !creds.instance || !creds.apikey) return { ok: false, reason: 'tenant_sem_evolution' };
    await (deps.evolution || require('./evolution')).markChatUnread(creds, {
      lastMessage: { key, messageTimestamp: Math.floor(new Date(ult.received_at).getTime() / 1000) }, chat: remoteJid });
    return { ok: true };
  } catch (e) {
    logger.warn('inbox.nao_lida_whatsapp_falhou', { tenant_id: tenantId, conversation_id: conversationId, error: e.message });
    return { ok: false, erro: e.message };
  }
}

module.exports = { chavesParaLer, lerNoWhatsapp, marcarNaoLidaNoWhatsapp, _jidLegivel };
