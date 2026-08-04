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
const { loadRealHistory } = require('./engine');   // mesma timeline usada pela "sugestão de resposta"
const outbound = require('./outbound');
const evolutionDefault = require('./evolution');
const metaDefault = require('./meta');
const horario = require('./horario');   // FONTE ÚNICA do horário de atendimento (aba "Horário de atendimento")
const logger = require('./logger');

// tenants.horario_comercial (jsonb ISO 1=seg..7=dom) → formato do businessState ({mon..sun}).
// Fonte ÚNICA = a aba "Horário de atendimento" (o que o resto do sistema usa). businessState usa
// 1 faixa/dia: colapsa min→max (faixa única na Valinhos; almoço partido viraria "aberto" no vão).
const _ISO_ABBR = { 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat', 7: 'sun' };
function _horarioParaBH(horarioComercial, legacy) {
  let src = horarioComercial;
  if (!src || (typeof src === 'object' && !Array.isArray(src) && !Object.keys(src).length)) {
    src = (legacy && legacy.inicio) ? legacy : null;
  }
  const norm = horario.normaliza(src);
  if (!norm) return {};
  const bh = {};
  for (let d = 1; d <= 7; d++) {
    const fx = norm[d];
    if (fx && fx.length) {
      const ini = Math.min(...fx.map((f) => f.ini)); const fim = Math.max(...fx.map((f) => f.fim));
      bh[_ISO_ABBR[d]] = `${horario.minToHm(ini)}-${horario.minToHm(fim)}`;
    } else bh[_ISO_ABBR[d]] = 'closed';
  }
  return bh;
}

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
async function maybeAutoReply(tenant, { channel, externalId, inboundText, contactName }, deps = {}) {
  if (process.env.AUTOREPLY_PAUSE === '1') return { skipped: 'paused' };
  const tenantId = tenant && tenant.id;
  if (!tenantId || !channel || !externalId) return { skipped: 'args' };
  const ident = String(externalId).replace(/\D/g, '');
  try {
    const info = await withTenant(tenantId, async (c) => {
      const conv = (await c.query(
        `SELECT id, auto_reply_at, conversation_kind FROM conversations
          WHERE tenant_id = $1 AND channel = $2
            AND regexp_replace(external_id, '[^0-9]', '', 'g') = regexp_replace($3, '[^0-9]', '', 'g')
          ORDER BY updated_at DESC LIMIT 1`, [tenantId, channel, String(externalId)])).rows[0];
      const auto = (await c.query('SELECT modo_fora_horario, modo_fds, nome_ia, contexto_ia FROM automacao_config WHERE tenant_id = $1', [tenantId])).rows[0];
      const cfg = (await c.query('SELECT school_name, available_instruments FROM tenant_lead_config WHERE tenant_id = $1', [tenantId])).rows[0];
      // Horário de atendimento = FONTE ÚNICA tenants.horario_comercial (o que a aba grava) + fallback legado.
      const t = (await c.query(
        `SELECT name, horario_comercial,
                to_char(horario_comercial_inicio, 'HH24:MI') AS hc_inicio,
                to_char(horario_comercial_fim, 'HH24:MI') AS hc_fim,
                horario_comercial_dias AS hc_dias
           FROM tenants WHERE id = $1`, [tenantId])).rows[0];
      const lead = ident ? (await c.query(
        `SELECT id, name FROM leads WHERE tenant_id = $1 AND regexp_replace(coalesce(phone, meta_psid, ''), '[^0-9]', '', 'g') = $2
          ORDER BY created_at ASC LIMIT 1`, [tenantId, ident])).rows[0] : null;
      // RECEPÇÃO ATIVA: um HUMANO respondeu pelo painel (source='api', sender != IA) nos últimos
      // min? Então a equipe está presente (chegou cedo / saiu tarde) → a IA não deve atravessar.
      const nomeIaQ = (auto && auto.nome_ia && String(auto.nome_ia).trim()) || 'Atendimento';
      const recepWin = parseInt(process.env.AUTOREPLY_RECEP_WINDOW_MIN || '30', 10) || 30;
      const recep = (await c.query(
        `SELECT 1 FROM staff_outbound_samples
          WHERE tenant_id = $1 AND source = 'api' AND coalesce(sender, '') <> $2
            AND received_at > now() - make_interval(mins => $3) LIMIT 1`,
        [tenantId, nomeIaQ, recepWin])).rows[0];
      return { conv, auto, cfg, tname: t && t.name, hc: t, leadId: lead && lead.id, leadName: lead && lead.name, recepAtiva: !!recep };
    });
    if (!info.conv) return { skipped: 'no_conv' };
    if (info.conv.conversation_kind && info.conv.conversation_kind !== 'DIRECT') return { skipped: 'nao_direct' };
    if (!info.auto) return { skipped: 'sem_automacao_config' };

    // Sem horário de atendimento configurado NÃO respondemos (senão pareceria "sempre fechado" e
    // responderia 24/7). Lê a MESMA aba "Horário de atendimento" (tenants.horario_comercial).
    const bh = _horarioParaBH(info.hc && info.hc.horario_comercial,
      info.hc && { inicio: info.hc.hc_inicio, fim: info.hc.hc_fim, dias: info.hc.hc_dias });
    if (!bh || Object.keys(bh).length === 0) return { skipped: 'sem_horario' };

    const now = deps.now || new Date();
    const st = businessState(bh, now);
    if (st.open) return { skipped: 'aberto' };

    // BORDAS: a recepção costuma chegar um pouco antes e sair um pouco depois. Perto das bordas do
    // horário a IA NÃO responde (evita atravessar a recepção). Buffer configurável (min; default 30).
    const BUF_MS = (parseInt(process.env.AUTOREPLY_BUFFER_MIN || '30', 10) || 0) * 60000;
    if (BUF_MS > 0) {
      if (st.nextOpen && st.nextOpen.getTime() - now.getTime() <= BUF_MS) return { skipped: 'quase_abrindo' };
      if (st.closedSince && now.getTime() - st.closedSince.getTime() <= BUF_MS) return { skipped: 'recem_fechou' };
    }

    const fimDeSemana = ([0, 6].includes(_local(now).dow));
    const modo = fimDeSemana ? info.auto.modo_fds : info.auto.modo_fora_horario;
    if (modo !== 'auto') return { skipped: 'modo=' + modo };

    // Recepção ativa agora (humano respondeu pelo painel recentemente) → não atravessa a recepção.
    if (info.recepAtiva) return { skipped: 'recepcao_ativa' };

    // ANTI-DUPLICADO ATÔMICO: reserva o cooldown ANTES de gerar/enviar. Se outra mensagem quase
    // simultânea já reservou nesta janela fechada, pula (evita 2 respostas — o bug da Michele).
    const cs = st.closedSince || new Date(now.getTime() - 12 * 3600000);
    const reserva = await withTenant(tenantId, (c) => c.query(
      'UPDATE conversations SET auto_reply_at = $4 WHERE id = $1 AND tenant_id = $2 AND (auto_reply_at IS NULL OR auto_reply_at < $3)',
      [info.conv.id, tenantId, cs, now]));
    if (!reserva.rowCount) return { skipped: 'cooldown' };

    const nomeIa = (info.auto.nome_ia && info.auto.nome_ia.trim()) || 'Atendimento';
    const escola = (info.cfg && info.cfg.school_name) || info.tname || 'a escola';
    const proxima = formatNextOpen(st.nextOpen, now);

    // LÊ a conversa (mesma timeline da "sugestão de resposta") p/ responder no contexto — como
    // um humano faria. Best-effort: sem histórico se falhar.
    const loadHist = deps.loadRealHistory || loadRealHistory;
    let history = [];
    try { history = await loadHist(tenantId, { conversationId: info.conv.id, ident, leadId: info.leadId || null }); }
    catch (e) { logger.warn('autoreply.history_failed', { tenant_id: tenantId, error: e.message }); }

    const instrs = (info.cfg && Array.isArray(info.cfg.available_instruments) && info.cfg.available_instruments.length)
      ? ` A escola oferece aulas de: ${info.cfg.available_instruments.join(', ')}.` : '';
    // Nome do contato: prioriza o que veio do WhatsApp/Meta (pushName), cai p/ o nome do lead.
    const contato = (contactName && String(contactName).trim()) || (info.leadName && String(info.leadName).trim()) || null;
    const primeiroNome = contato ? contato.split(/\s+/)[0] : null;
    // Base de conhecimento que a escola preencheu (endereço, como funcionam as aulas, eventos…).
    const contexto = (info.auto && info.auto.contexto_ia && String(info.auto.contexto_ia).trim()) || '';

    const blocoNome = contato
      ? `Você JÁ SABE, pelo WhatsApp, que está falando com ${contato} — trate pelo primeiro nome (${primeiroNome}) e NÃO pergunte o nome dela. Se a conversa for sobre aula, pergunte de forma natural PARA QUEM seria a aula: se é para ${primeiroNome} ou para outra pessoa (e, se for outra, o nome e a idade). `
      : `Se ainda não souber o nome e a conversa for sobre aula, pergunte para quem seria a aula (a própria pessoa ou outra) — sem soar burocrática. `;
    const blocoContexto = contexto
      ? `INFORMAÇÕES DA ESCOLA que você PODE usar para responder (ex.: endereço, como funcionam as aulas, eventos): """${contexto}""" `
      : '';
    const proximaFrase = proxima || 'no próximo horário de atendimento';
    const retorno = proxima ? `quando a equipe abrir (${proxima})` : 'no próximo horário de atendimento';
    const regraHorario = `REGRA DE HORÁRIO (obrigatória): ao dizer quando a equipe retorna/abre, escreva EXATAMENTE «${proximaFrase}» — NÃO troque o dia da semana nem a hora, NÃO invente outro dia (ex.: não diga "segunda-feira" se a frase for "hoje às 9h"). `;
    const systemPrompt =
      `Você é ${nomeIa}, do atendimento de ${escola} — fale como um atendente HUMANO real, caloroso e natural (nada robótico, nada genérico).${instrs} ` +
      blocoNome + blocoContexto +
      `AGORA é FORA do horário de atendimento. LEIA o histórico da conversa e responda de forma PERSONALIZADA e curta (1 a 3 frases), em português do Brasil, reconhecendo o assunto. ` +
      `REGRA DE OURO (obrigatória): você SÓ pode afirmar fatos que estejam ESCRITOS EXPLICITAMENTE nas "INFORMAÇÕES DA ESCOLA" acima. É TERMINANTEMENTE PROIBIDO inventar, deduzir, supor ou completar qualquer informação. ` +
      `Você PODE — só se estiver nas informações acima — dar o ENDEREÇO e explicar COMO FUNCIONAM as aulas (individuais, projetos de banda, eventos). ` +
      `Se a pessoa perguntar OU mencionar QUALQUER coisa que não esteja explícita nas informações acima (ex.: um workshop, um evento específico, nome de professor, promoção, data, valor, horário de aula): NÃO confirme, NÃO detalhe e NÃO invente — diga com sinceridade que a recepção confirma esse detalhe ${retorno}. Mesmo que apareça no histórico da conversa, trate como NÃO confirmado (use o histórico só p/ entender o assunto e o tom, NUNCA como fonte de fatos). ` +
      `NUNCA informe PREÇOS/valores nem AGENDE/confirme HORÁRIO de aula experimental — exclusivo da recepção. ` +
      regraHorario +
      `NÃO assine nem repita seu nome no final — o nome já aparece no topo.`;

    const generate = deps.generate || gemini.generateReply;
    let corpo;
    try {
      corpo = await generate({ systemPrompt, history, message: inboundText || '', retomada: history.length > 0 });
    } catch (e) {
      logger.warn('autoreply.generate_failed', { tenant_id: tenantId, error: e.message });
      corpo = `Oi! Recebemos sua mensagem 🙌 No momento estamos fora do horário de atendimento; a equipe humana retorna ${proxima || 'assim que abrirmos'}. Já anotei por aqui!`;
    }
    if (!corpo || !String(corpo).trim()) return { skipped: 'vazio' };
    // Cabeçalho com o nome em NEGRITO (WhatsApp: *nome*), igual às recepcionistas (ex.: *Rafa*).
    const texto = `*${nomeIa}*\n${String(corpo).trim()}`;

    const sent = await _send(tenantId, channel, externalId, texto, deps);
    if (!sent.ok) {
      // Envio falhou: devolve o cooldown (restaura o valor anterior) p/ permitir retry na próxima msg.
      await withTenant(tenantId, (c) => c.query('UPDATE conversations SET auto_reply_at = $2 WHERE id = $1', [info.conv.id, info.conv.auto_reply_at || null])).catch(() => {});
      return { skipped: 'send_' + sent.reason };
    }
    // cooldown já reservado ANTES de gerar (anti-duplicado) — não seta de novo aqui.
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
