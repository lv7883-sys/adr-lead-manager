'use strict';
// waEventos.js — paridade com o WhatsApp, etapa 6: o que acontece na conversa sem ser mensagem.
//
//  - LIGAÇÃO (evento call): "📞 Chamada de voz perdida" / "Chamada de vídeo" no meio da conversa. Conta como
//    não lida (no WhatsApp também) — é a ligação que a recepção não viu. Nunca aciona a Janis (não passa pelo
//    funil de entrada: é gravada direto).
//  - GRUPO (group-participants.update / groups.update): "Fulano entrou", "X adicionou Y", "Y saiu",
//    "X mudou o nome do grupo para …". Não conta como não lida (marca de sistema, src/reacao.js).
//
// Tudo idempotente pelo external_message_id (o dispatcher pode reenviar o mesmo evento).
const crypto = require('crypto');
const { withTenant } = require('./db');
const logger = require('./logger');
const { textoSistema } = require('./reacao');
const { _garantirConversa } = require('./staffSamples');

const dig = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const h8 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

function formatarTelefone(d) {
  d = String(d || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55')) return `+55 ${d.slice(2, 4)} ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.length === 12 && d.startsWith('55')) return `+55 ${d.slice(2, 4)} ${d.slice(4, 8)}-${d.slice(8)}`;
  return d ? `+${d}` : '';
}

// número (dígitos) de um jid: @s.whatsapp.net direto; @lid pelo par aprendido (wa_lid).
async function _pnDoJid(c, tenantId, jid) {
  const j = String(jid || '');
  if (/@s\.whatsapp\.net$/.test(j)) return dig(j);
  if (/@lid$/.test(j)) {
    const r = (await c.query('SELECT pn, proprio FROM wa_lid WHERE tenant_id = $1 AND lid = $2', [tenantId, j.replace(/:\d+@/, '@')])).rows[0];
    return r ? { pn: r.pn ? dig(r.pn) : null, proprio: !!r.proprio } : null;
  }
  return null;
}

// Nome como a recepção vê: "Você" (a própria escola), o nome do perfil com que a pessoa escreveu em qualquer
// conversa, o nome que a Evolution mandou, ou o telefone formatado.
async function nomeDoJid(c, tenantId, jid, nomeDoEvento) {
  const j = String(jid || '').replace(/:\d+@/, '@');
  if (!j) return 'alguém';
  let pn = null; let proprio = false;
  const r = await _pnDoJid(c, tenantId, j);
  if (typeof r === 'string') pn = r; else if (r) { pn = r.pn; proprio = r.proprio; }
  if (proprio) return 'Você';
  const ids = [j]; if (pn) ids.push(`${pn}@s.whatsapp.net`);
  const s = (await c.query(
    `SELECT m.sender FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
      WHERE cv.tenant_id = $1 AND m.sender IS NOT NULL AND m.sender <> ''
        AND (m.raw#>>'{data,key,participant}' = ANY($2) OR m.raw#>>'{data,key,participantAlt}' = ANY($2))
      ORDER BY m.received_at DESC LIMIT 1`, [tenantId, ids])).rows[0];
  if (s) return s.sender;
  if (nomeDoEvento) return nomeDoEvento;
  return formatarTelefone(pn || (/@s\.whatsapp\.net$/.test(j) ? dig(j) : '')) || 'alguém';
}

async function _gravar(c, { tenantId, conversationId, externalId, body, at, conteudo, raw, sender = null }) {
  return c.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, role, external_message_id, sender, body, raw, received_at, conteudo)
     VALUES ($1, $2, 'inbound', 'USER', $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL
     DO UPDATE SET body = EXCLUDED.body, conteudo = EXCLUDED.conteudo`,
    [tenantId, conversationId, externalId, sender, body, JSON.stringify(raw || {}), at, conteudo ? JSON.stringify(conteudo) : null]);
}

async function _conversaDoGrupo(c, tenantId, groupJid) {
  await _garantirConversa(c, tenantId, groupJid, groupJid, true);
  const r = (await c.query(`SELECT id FROM conversations WHERE tenant_id = $1 AND channel = 'whatsapp' AND external_id = $2`, [tenantId, groupJid])).rows[0];
  return r ? r.id : null;
}

// ------------------------------------------------------------------------------------------ ligação
// Baileys: { id, from, chatId, isVideo, isGroup, status: offer|ringing|timeout|reject|accept|terminate, date }.
const _ESTADO = { offer: 'tocando', ringing: 'tocando', timeout: 'perdida', reject: 'recusada', accept: 'atendida', terminate: 'encerrada' };
function textoChamada(video, estado) {
  const tipo = video ? 'vídeo' : 'voz';
  if (estado === 'perdida') return `📞 Chamada de ${tipo} perdida`;
  if (estado === 'recusada') return `📞 Chamada de ${tipo} recusada`;
  return `📞 Chamada de ${tipo}`;
}

async function registrarChamada(tenantId, data, deps = {}) {
  const run = deps.withTenant || withTenant;
  const lista = Array.isArray(data) ? data : [data];
  const out = [];
  for (const ch of lista) {
    if (!ch || !ch.id || !ch.from) continue;
    if (ch.isGroup) { out.push({ id: ch.id, resultado: 'grupo_ignorado' }); continue; }
    const novo = _ESTADO[String(ch.status || '').toLowerCase()] || 'tocando';
    const r = await run(tenantId, async (c) => {
      const pnR = await _pnDoJid(c, tenantId, ch.from);
      const pn = typeof pnR === 'string' ? pnR : (pnR && pnR.pn);
      let cv = null;
      if (pn && pn.length >= 10 && pn.length <= 15) {
        await _garantirConversa(c, tenantId, `${pn}@s.whatsapp.net`, pn, false);
        cv = (await c.query(`SELECT id FROM conversations WHERE tenant_id = $1 AND channel = 'whatsapp' AND br_key = br_phone_key($2) ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [tenantId, pn])).rows[0];
      } else if (/@lid$/.test(String(ch.from))) {
        // quem liga com @lid e ainda não tem o número aprendido: a conversa em que essa pessoa já escreveu com o mesmo @lid
        cv = (await c.query(
          `SELECT m.conversation_id AS id FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
            WHERE cv.tenant_id = $1 AND cv.conversation_kind IS DISTINCT FROM 'GROUP' AND m.raw#>>'{data,key,remoteJid}' = $2
            ORDER BY m.received_at DESC LIMIT 1`, [tenantId, String(ch.from).replace(/:\d+@/, '@')])).rows[0];
      }
      if (!cv) return { id: ch.id, resultado: 'sem_conversa' };
      const ext = `call:${ch.id}`;
      const ant = (await c.query(`SELECT conteudo->>'estado' AS estado FROM messages WHERE tenant_id = $1 AND external_message_id = $2`, [tenantId, ext])).rows[0];
      // "encerrada" sem ter sido atendida = perdida; estados finais não voltam para "tocando"
      let estado = novo;
      const anterior = ant && ant.estado;
      if (novo === 'encerrada') estado = anterior === 'atendida' ? 'atendida' : (anterior === 'recusada' ? 'recusada' : 'perdida');
      if (novo === 'tocando' && anterior && anterior !== 'tocando') estado = anterior;
      const video = !!ch.isVideo;
      const at = ch.date ? new Date(ch.date) : new Date();
      await _gravar(c, { tenantId, conversationId: cv.id, externalId: ext, body: textoChamada(video, estado), at: isNaN(at) ? new Date() : at,
        conteudo: { tipo: 'chamada', video, perdida: estado === 'perdida', estado }, raw: { event: 'call', data: ch } });
      return { id: ch.id, resultado: estado };
    });
    out.push(r);
  }
  return out;
}

// ------------------------------------------------------------------------------------------ grupo
async function registrarParticipantes(tenantId, data, deps = {}) {
  const run = deps.withTenant || withTenant;
  const d = Array.isArray(data) ? data[0] : data;
  if (!d || !/@g\.us$/.test(String(d.id || '')) || !Array.isArray(d.participants) || !d.participants.length) return [];
  const acao = String(d.action || '').toLowerCase();
  if (!['add', 'remove', 'promote', 'demote'].includes(acao)) return [];
  return run(tenantId, async (c) => {
    const cvId = await _conversaDoGrupo(c, tenantId, d.id);
    if (!cvId) return [];
    const autorJid = d.author ? String(d.author) : null;
    const autor = autorJid ? await nomeDoJid(c, tenantId, autorJid) : null;
    const dados = Array.isArray(d.participantsData) ? d.participantsData : [];
    const at = new Date();
    const minuto = Math.floor(at.getTime() / 60000);
    const feitos = [];
    for (const p of d.participants) {
      const pj = typeof p === 'string' ? p : (p && (p.id || p.jid));
      if (!pj) continue;
      const pd = dados.find((x) => x && (x.jid === pj || x.id === pj)) || {};
      const pnEv = String(pd.phoneNumber || '');
      const jidNome = /@s\.whatsapp\.net$/.test(pnEv) ? pnEv : (/^\d{10,15}$/.test(pnEv) ? `${pnEv}@s.whatsapp.net` : pj);
      const nome = await nomeDoJid(c, tenantId, jidNome, pd.name);
      const mesmo = autorJid && dig(autorJid) === dig(pj);
      let txt;
      if (acao === 'add') txt = autor && !mesmo ? `${autor} adicionou ${nome}` : `${nome} entrou`;
      else if (acao === 'remove') txt = autor && !mesmo ? `${autor} removeu ${nome}` : `${nome} saiu`;
      else if (acao === 'promote') txt = `${nome} agora é admin`;
      else txt = `${nome} não é mais admin`;
      const ext = `sis:grp:${h8(`${d.id}|${acao}|${pj}|${minuto}`)}`;
      await _gravar(c, { tenantId, conversationId: cvId, externalId: ext, body: textoSistema(txt), at,
        conteudo: { tipo: 'sistema', evento: `participante_${acao}` }, raw: { event: 'group-participants.update', data: d } });
      feitos.push(txt);
    }
    return feitos;
  });
}

async function registrarMudancaGrupo(tenantId, data, deps = {}) {
  const run = deps.withTenant || withTenant;
  const lista = Array.isArray(data) ? data : [data];
  const feitos = [];
  for (const g of lista) {
    if (!g || !/@g\.us$/.test(String(g.id || ''))) continue;
    const r = await run(tenantId, async (c) => {
      const cvId = await _conversaDoGrupo(c, tenantId, g.id);
      if (!cvId) return [];
      const autor = g.author ? await nomeDoJid(c, tenantId, g.author) : null;
      const quem = autor || 'Alguém';
      const txts = [];
      if (typeof g.subject === 'string' && g.subject) txts.push(['nome', `${quem} mudou o nome do grupo para "${g.subject}"`]);
      if (typeof g.desc === 'string') txts.push(['descricao', g.desc ? `${quem} mudou a descrição do grupo` : `${quem} apagou a descrição do grupo`]);
      if (typeof g.announce === 'boolean') txts.push(['envio', g.announce ? `${quem} mudou as configurações para que só admins possam enviar mensagens` : `${quem} mudou as configurações para que todos os participantes possam enviar mensagens`]);
      if (typeof g.restrict === 'boolean') txts.push(['edicao', g.restrict ? `${quem} mudou as configurações para que só admins possam editar os dados do grupo` : `${quem} mudou as configurações para que todos os participantes possam editar os dados do grupo`]);
      const at = new Date(); const minuto = Math.floor(at.getTime() / 60000);
      for (const [campo, txt] of txts) {
        await _gravar(c, { tenantId, conversationId: cvId, externalId: `sis:grp:${h8(`${g.id}|${campo}|${txt}|${minuto}`)}`, body: textoSistema(txt), at,
          conteudo: { tipo: 'sistema', evento: `grupo_${campo}` }, raw: { event: 'groups.update', data: g } });
      }
      return txts.map((t) => t[1]);
    });
    feitos.push(...r);
  }
  return feitos;
}

// Roteia o evento do webhook. Devolve true se era um destes eventos (o webhook para aí).
function tratarEvento(tenantId, body, log) {
  const ev = String(body && body.event || '').toLowerCase();
  const data = body && body.data;
  const falhou = (e) => (log || logger).warn('wa_eventos.falhou', { tenant_id: tenantId, evento: ev, error: e.message });
  if (ev === 'call') { registrarChamada(tenantId, data).then((r) => (log || logger).info('wa_eventos.chamada', { r })).catch(falhou); return true; }
  if (ev === 'group-participants.update') { registrarParticipantes(tenantId, data).catch(falhou); return true; }
  if (ev === 'groups.update') { registrarMudancaGrupo(tenantId, data).catch(falhou); return true; }
  return false;
}

module.exports = { registrarChamada, registrarParticipantes, registrarMudancaGrupo, tratarEvento, nomeDoJid, formatarTelefone, textoChamada };
