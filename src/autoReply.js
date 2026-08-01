'use strict';
//
// autoReply.js — ADR-006+: resposta automática FORA DO HORÁRIO ("a Janis"). Quando chega uma
// mensagem 1:1 (WhatsApp/Messenger/Instagram) fora do horário de atendimento do tenant E a
// automação está LIGADA (automacao_config.modo_fora_horario/modo_fds = 'auto'), a IA responde
// curtinho reconhecendo a mensagem e avisando quando a equipe retorna — assinando com o nome
// configurado (nunca o de uma recepcionista real). Anti-spam: 1x por janela fechada.
//
// Fuso: America/Sao_Paulo é UTC-3 FIXO desde 2019 (Brasil aboliu o horário de verão) — por isso
// usamos offset fixo, sem depender do TZ do processo e sem bugs de DST.
//
// Best-effort: NUNCA lança para a ingestão (chamado fire-and-forget após persistir o inbound).
//
const { withTenant } = require('./db');
const gemini = require('./gemini');
const outbound = require('./outbound');
const evolutionDefault = require('./evolution');
const metaDefault = require('./meta');
const logger = require('./logger');

const OFFSET_MS = 3 * 3600 * 1000;              // UTC-3 (São Paulo, sem DST)
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];   // getUTCDay() 0..6

// Componentes locais (São Paulo) de um instante UTC.
function _local(date) {
  const d = new Date(date.getTime() - OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), da: d.getUTCDate(), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
// Instante UTC de um horário LOCAL (ano/mês/dia + minutos do dia) em São Paulo.
function _utcOf(y, mo, da, minutes) {
  return new Date(Date.UTC(y, mo, da, 0, 0, 0, 0) + (minutes * 60000) + OFFSET_MS);
}
// "HH:MM-HH:MM" -> [iniMin, fimMin]; "closed"/vazio/ inválido -> null.
function _parseInterval(v) {
  if (!v || v === 'closed') return null;
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(String(v).trim());
  if (!m) return null;
  const ini = (+m[1]) * 60 + (+m[2]); const fim = (+m[3]) * 60 + (+m[4]);
  return fim > ini ? [ini, fim] : null;
}

// Estado do atendimento AGORA: { open, closedSince, nextOpen }.
//  - open: dentro de algum intervalo aberto hoje;
//  - closedSince: instante em que a janela fechada ATUAL começou (fim do último aberto) — p/ cooldown;
//  - nextOpen: próximo instante de abertura (Date) — p/ a mensagem ("retornamos ...").
function businessState(businessHours, now = new Date()) {
  const bh = businessHours || {};
  const L = _local(now);
  const hoje = _parseInterval(bh[DAYS[L.dow]]);
  const open = !!hoje && L.min >= hoje[0] && L.min < hoje[1];
  if (open) return { open: true, closedSince: null, nextOpen: null };

  let closedSince = null;
  for (let off = 0; off <= 7 && !closedSince; off++) {
    const d = new Date(now.getTime() - OFFSET_MS - off * 86400000);
    const iv = _parseInterval(bh[DAYS[d.getUTCDay()]]);
    if (!iv) continue;
    const fim = _utcOf(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), iv[1]);
    if (fim.getTime() <= now.getTime()) closedSince = fim;
  }
  let nextOpen = null;
  for (let off = 0; off <= 7 && !nextOpen; off++) {
    const d = new Date(now.getTime() - OFFSET_MS + off * 86400000);
    const iv = _parseInterval(bh[DAYS[d.getUTCDay()]]);
    if (!iv) continue;
    const ini = _utcOf(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), iv[0]);
    if (ini.getTime() > now.getTime()) nextOpen = ini;
  }
  return { open: false, closedSince, nextOpen };
}

const _DIA_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
// "hoje às 14h", "amanhã às 9h", "na segunda-feira às 9h".
function formatNextOpen(nextOpen, now = new Date()) {
  if (!nextOpen) return null;
  const N = _local(now); const O = _local(nextOpen);
  const hh = Math.floor(O.min / 60); const mm = O.min % 60;
  const hora = mm ? `${hh}h${String(mm).padStart(2, '0')}` : `${hh}h`;
  const diffDias = Math.round((Date.UTC(O.y, O.mo, O.da) - Date.UTC(N.y, N.mo, N.da)) / 86400000);
  if (diffDias <= 0) return `hoje às ${hora}`;
  if (diffDias === 1) return `amanhã às ${hora}`;
  return `na ${_DIA_PT[O.dow]} às ${hora}`;
}

async function _send(tenantId, channel, externalId, text, deps) {
  if (channel === 'whatsapp') {
    const evolution = deps.evolution || evolutionDefault;
    const credsForTenant = deps.credsForTenant || outbound.credsForTenant;
    const creds = await credsForTenant(tenantId);
    if (!creds.instance || !creds.apikey) return { ok: false, reason: 'sem_evolution' };
    const st = await evolution.status({ instance: creds.instance, apikey: creds.apikey });
    if (st.state !== 'open') return { ok: false, reason: 'instancia' };
    const r = await evolution.sendText({ instance: creds.instance, apikey: creds.apikey }, externalId, text);
    return { ok: true, messageId: evolution.pickMessageId(r) };
  }
  if (channel === 'facebook_messenger' || channel === 'instagram_dm') {
    const meta = deps.meta || metaDefault;
    const pageCreds = deps.pageCredsForTenant || meta.pageCredsForTenant;
    const creds = await pageCreds(tenantId);
    if (!creds || !creds.pageId || !creds.token) return { ok: false, reason: 'sem_meta' };
    const r = await meta.sendMessage({ pageId: creds.pageId, token: creds.token }, externalId, text);
    return { ok: true, messageId: (r && (r.message_id || r.mid)) || null };
  }
  return { ok: false, reason: 'canal' };
}

// Núcleo. tenant = { id }. Resolve a conversa por (channel, dígitos do external_id). Só DIRECT.
// deps injeta now/generate/evolution/meta/creds/registrar p/ o teste. Retorna {ok} ou {skipped}.
async function maybeAutoReply(tenant, { channel, externalId, inboundText }, deps = {}) {
  if (process.env.AUTOREPLY_PAUSE === '1') return { skipped: 'paused' };
  const tenantId = tenant && tenant.id;
  if (!tenantId || !channel || !externalId) return { skipped: 'args' };
  try {
    const info = await withTenant(tenantId, async (c) => {
      const conv = (await c.query(
        `SELECT id, auto_reply_at, conversation_kind FROM conversations
          WHERE tenant_id = $1 AND channel = $2
            AND regexp_replace(external_id, '[^0-9]', '', 'g') = regexp_replace($3, '[^0-9]', '', 'g')
          ORDER BY updated_at DESC LIMIT 1`, [tenantId, channel, String(externalId)])).rows[0];
      const auto = (await c.query('SELECT modo_fora_horario, modo_fds, nome_ia FROM automacao_config WHERE tenant_id = $1', [tenantId])).rows[0];
      const cfg = (await c.query('SELECT school_name, business_hours FROM tenant_lead_config WHERE tenant_id = $1', [tenantId])).rows[0];
      const tname = (await c.query('SELECT name FROM tenants WHERE id = $1', [tenantId])).rows[0];
      return { conv, auto, cfg, tname: tname && tname.name };
    });
    if (!info.conv) return { skipped: 'no_conv' };
    if (info.conv.conversation_kind && info.conv.conversation_kind !== 'DIRECT') return { skipped: 'nao_direct' };
    if (!info.auto) return { skipped: 'sem_automacao_config' };

    const now = deps.now || new Date();
    const st = businessState((info.cfg && info.cfg.business_hours) || {}, now);
    if (st.open) return { skipped: 'aberto' };

    const fimDeSemana = ([0, 6].includes(_local(now).dow));
    const modo = fimDeSemana ? info.auto.modo_fds : info.auto.modo_fora_horario;
    if (modo !== 'auto') return { skipped: 'modo=' + modo };

    // Anti-spam: já respondeu automaticamente nesta janela fechada? (auto_reply_at >= closedSince)
    if (info.conv.auto_reply_at && st.closedSince && new Date(info.conv.auto_reply_at) >= st.closedSince) {
      return { skipped: 'cooldown' };
    }

    const nomeIa = (info.auto.nome_ia && info.auto.nome_ia.trim()) || 'Atendimento';
    const escola = (info.cfg && info.cfg.school_name) || info.tname || 'a escola';
    const proxima = formatNextOpen(st.nextOpen, now);
    const systemPrompt =
      `Você é ${nomeIa}, atendente virtual de ${escola}. AGORA é FORA do horário de atendimento. ` +
      `Responda em português do Brasil, cordial e curto (1 a 2 frases): reconheça brevemente a mensagem da pessoa, ` +
      `diga que a equipe retorna ${proxima || 'no próximo horário de atendimento'} e que a mensagem foi anotada. ` +
      `NÃO invente preços, NÃO agende, NÃO prometa nada específico. Pode assinar como ${nomeIa}.`;

    const generate = deps.generate || gemini.generateReply;
    let texto;
    try {
      texto = await generate({ systemPrompt, history: [], message: inboundText || '', retomada: false });
    } catch (e) {
      logger.warn('autoreply.generate_failed', { tenant_id: tenantId, error: e.message });
      texto = `Oi! Aqui é a ${nomeIa}, de ${escola}. Recebemos sua mensagem 🙌 No momento estamos fora do horário de atendimento; a equipe retorna ${proxima || 'assim que abrirmos'}. Já anotamos por aqui!`;
    }
    if (!texto || !String(texto).trim()) return { skipped: 'vazio' };
    texto = String(texto).trim();

    const sent = await _send(tenantId, channel, externalId, texto, deps);
    if (!sent.ok) return { skipped: 'send_' + sent.reason };

    await withTenant(tenantId, (c) => c.query('UPDATE conversations SET auto_reply_at = now() WHERE id = $1 AND tenant_id = $2', [info.conv.id, tenantId]));
    const registrar = deps.registrarSaida || outbound.registrarSaida;
    await registrar(tenantId, { phone: externalId, externalMessageId: sent.messageId, sender: nomeIa, body: texto });
    logger.info('autoreply.sent', { tenant_id: tenantId, channel, nome_ia: nomeIa });
    return { ok: true, message_id: sent.messageId };
  } catch (e) {
    logger.warn('autoreply.error', { tenant_id: tenantId, error: e.message });
    return { skipped: 'error' };
  }
}

module.exports = { maybeAutoReply, businessState, formatNextOpen };
