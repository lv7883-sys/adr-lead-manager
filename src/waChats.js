'use strict';
// waChats.js — paridade com o WhatsApp: o que se faz na LISTA de conversas do celular/WhatsApp Web vale no Regente.
//
// Evento chats.update (a Evolution foi corrigida em 15/09/2026 para repassar o payload completo do Baileys):
//   unreadCount -1  -> "marcar como não lida"   -> a conversa volta a ficar não lida no Regente
//   unreadCount  0  -> "marcar como lida"        -> lida no Regente
//   unreadCount >0  -> mensagens novas (o Regente já conta sozinho) -> ignorado
//   archived        -> arquivada / desarquivada
//   pinned          -> fixada (timestamp) / desafixada (null)
//   muteEndTime     -> silenciada até (ms; -1 = sempre) / null = não silenciada
// Só grava estado local — nunca chama a Evolution de volta (sem laço com o que o Regente manda para o celular).
const { withTenant } = require('./db');
const logger = require('./logger');

const dig = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');

async function conversaDoJid(c, tenantId, jid) {
  const j = String(jid || '').replace(/:\d+@/, '@');
  if (/@g\.us$/.test(j)) {
    const r = (await c.query(`SELECT id FROM conversations WHERE tenant_id = $1 AND channel = 'whatsapp' AND external_id = $2`, [tenantId, j])).rows[0];
    return r ? r.id : null;
  }
  let pn = /@s\.whatsapp\.net$/.test(j) ? dig(j) : null;
  if (!pn && /@lid$/.test(j)) {
    const l = (await c.query('SELECT pn FROM wa_lid WHERE tenant_id = $1 AND lid = $2', [tenantId, j])).rows[0];
    if (l && l.pn) pn = dig(l.pn);
    if (!pn) {
      const m = (await c.query(
        `SELECT m.conversation_id AS id FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
          WHERE cv.tenant_id = $1 AND cv.conversation_kind IS DISTINCT FROM 'GROUP' AND m.raw#>>'{data,key,remoteJid}' = $2
          ORDER BY m.received_at DESC LIMIT 1`, [tenantId, j])).rows[0];
      return m ? m.id : null;
    }
  }
  if (!pn || pn.length < 10 || pn.length > 15) return null;
  const r = (await c.query(
    `SELECT id FROM conversations WHERE tenant_id = $1 AND channel = 'whatsapp' AND conversation_kind IS DISTINCT FROM 'GROUP'
        AND br_key = br_phone_key($2) ORDER BY last_activity_at DESC NULLS LAST LIMIT 1`, [tenantId, pn])).rows[0];
  return r ? r.id : null;
}

function _momento(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 'infinity';
  if (n === 0) return null;
  return new Date(n > 1e12 ? n : n * 1000).toISOString();   // WhatsApp usa ms; segundos por garantia
}

async function aplicarChatsUpdate(tenantId, data, deps = {}) {
  const run = deps.withTenant || withTenant;
  const inbox = deps.inbox || require('./routes/inbox');
  const lista = Array.isArray(data) ? data : [data];
  const feitos = [];
  for (const ch of lista) {
    if (!ch || typeof ch !== 'object') continue;
    const jid = ch.id || ch.remoteJid;
    const temLeitura = ch.unreadCount === -1 || ch.unreadCount === 0;
    const temArq = typeof ch.archived === 'boolean';
    const temFix = Object.prototype.hasOwnProperty.call(ch, 'pinned');
    const temMute = Object.prototype.hasOwnProperty.call(ch, 'muteEndTime');
    if (!jid || !(temLeitura || temArq || temFix || temMute)) continue;
    const r = await run(tenantId, async (c) => {
      const cv = await conversaDoJid(c, tenantId, jid);
      if (!cv) return { jid, resultado: 'sem_conversa' };
      const acoes = [];
      if (ch.unreadCount === -1) { await inbox.markUnread(c, tenantId, cv); acoes.push('nao_lida'); }
      else if (ch.unreadCount === 0) { await inbox.markRead(c, tenantId, cv, null); acoes.push('lida'); }
      if (temArq) {
        await c.query('UPDATE conversations SET arquivada_em = CASE WHEN $3 THEN COALESCE(arquivada_em, now()) ELSE NULL END WHERE id = $1 AND tenant_id = $2', [cv, tenantId, ch.archived]);
        acoes.push(ch.archived ? 'arquivada' : 'desarquivada');
      }
      if (temFix) {
        const quando = ch.pinned ? (_momento(ch.pinned) || new Date().toISOString()) : null;
        await c.query('UPDATE conversations SET fixada_em = $3 WHERE id = $1 AND tenant_id = $2', [cv, tenantId, quando]);
        acoes.push(quando ? 'fixada' : 'desafixada');
      }
      if (temMute) {
        const ate = ch.muteEndTime == null ? null : _momento(ch.muteEndTime);
        await c.query('UPDATE conversations SET silenciada_ate = $3::timestamptz WHERE id = $1 AND tenant_id = $2', [cv, tenantId, ate]);
        acoes.push(ate ? 'silenciada' : 'som_ligado');
      }
      return { jid, conversation_id: cv, acoes };
    });
    feitos.push(r);
  }
  return feitos;
}

function tratarEvento(tenantId, body, log) {
  if (String(body && body.event || '').toLowerCase() !== 'chats.update') return false;
  aplicarChatsUpdate(tenantId, body.data)
    .then((r) => { const uteis = r.filter((x) => x.acoes && x.acoes.length); if (uteis.length) (log || logger).info('wa_chats.update', { aplicados: uteis }); })
    .catch((e) => (log || logger).warn('wa_chats.falhou', { tenant_id: tenantId, error: e.message }));
  return true;
}

module.exports = { aplicarChatsUpdate, conversaDoJid, tratarEvento, _momento };
