'use strict';

// ADR-042 — Central de Mensagens ("Regente"). Inbox omnichannel conversation-centric.
// Fase 1 (E12): conversas DIRETAS (1:1) — lead E não-lead no mesmo fluxo, com filtros.
//
// Diferença central vs. o resto de tenant.js: aqui a ÂNCORA é a CONVERSA
// (conversations.id), não o lead. Isso permite listar/abrir conversa de NÃO-LEAD
// (contato conhecido, staff, etc.), que não tem linha em `leads`.
//
// Contrato: docs/adr/ARC-042-contrato-inbox-fase1.md
//   - is_lead      = gate (lead vs não-lead) — acende o pill "LEAD"
//   - is_lead_ativo = régua canônica ADR-041 (lifecycle.js): STATUS_VIVO ∧ ¬TERMINAL ∧ não-dormente
//   - fonte        = COALESCE(leads.origem, conversations.channel)
//   - last_activity_at = max(received_at) sobre messages(USER) ∪ staff_outbound_samples
//   - nao_lidas    = count(inbound received_at > conversations.last_read_at)  [migr. 080]
//
// A LÓGICA (SQL + projeção) fica em funções puras/exportadas p/ o itest exercitar contra
// um Postgres real (test/inbox.itest.js) — os handlers HTTP só orquestram parse + withTenant.

const express = require('express');
const { withTenant } = require('../db');
const { authenticate } = require('../auth');
const { requireTenantAccess } = require('../rbac');
const { isUuid } = require('../validation');
const { terminalSql, statusVivoSql } = require('../lifecycle');
const { fetchTimeline } = require('../timeline');
const outbound = require('../outbound');
const evolutionDefault = require('../evolution');
const logger = require('../logger');

const router = express.Router();

// Mesmos papéis do resto do namespace /tenant (tenant.js).
const READ_ROLES = ['TENANT_ADMIN', 'RECEPCAO', 'VISUALIZADOR'];
const WRITE_ROLES = ['TENANT_ADMIN', 'RECEPCAO'];

// Dígitos do telefone/psid — chave de casamento conversa↔lead↔saída (não há FK; D-1 do
// contrato). Igual ao _IDENT usado em tenant.js.
const IDENT_CONV = "regexp_replace(cv.external_id, '[^0-9]', '', 'g')";
const IDENT_LEAD = "regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')";

const VIEWS = new Set(['todas', 'leads', 'nao_lead']);

// Cursor keyset opaco = base64("<ISO last_activity_at>|<conversation_id>"). Keyset (não
// offset) porque a lista muda em tempo real — offset duplica/pula sob inserção concorrente.
function encodeCursor(lastActivityAt, conversationId) {
  const iso = lastActivityAt instanceof Date ? lastActivityAt.toISOString() : String(lastActivityAt);
  return Buffer.from(`${iso}|${conversationId}`, 'utf8').toString('base64');
}
function decodeCursor(cursor) {
  try {
    const raw = Buffer.from(String(cursor), 'base64').toString('utf8');
    const sep = raw.lastIndexOf('|');
    if (sep < 0) return null;
    const ts = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    if (Number.isNaN(Date.parse(ts)) || !isUuid(id)) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

// Prévia da última mensagem: apagada > mídia > texto truncado (~80 chars).
function preview(body, mediaType, deletedAt) {
  if (deletedAt) return '🚫 Mensagem apagada';
  if (!body || !String(body).trim()) return mediaType ? '[mídia]' : '';
  const t = String(body).trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

// Monta { sql, params } da listagem (E12-03). `cursor` = objeto decodificado {ts,id} | null.
// FONTE ÚNICA da query — usada pelo handler (sob withTenant/RLS) e pelo itest (como postgres).
function buildConversationsSql(tenantId, { view = 'todas', fonte = null, q = null, limit = 30, cursor = null } = {}) {
  const v = VIEWS.has(view) ? view : 'todas';
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 50);

  const params = [tenantId];
  const extra = [];

  if (fonte) { params.push(fonte); extra.push(`fonte = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`); const pNome = params.length;
    params.push(`%${String(q).replace(/\D/g, '')}%`); const pDig = params.length;
    extra.push(`(nome ILIKE $${pNome} OR (ident <> '' AND ident LIKE $${pDig}))`);
  }
  if (v === 'leads') extra.push('is_lead = true');
  else if (v === 'nao_lead') extra.push('is_lead = false');

  // Keyset entra como MAIS UM predicado do WHERE (não como cláusula solta — senão vira
  // "FROM projected AND ..." quando não há filtros).
  if (cursor) {
    params.push(cursor.ts); const pTs = params.length;
    params.push(cursor.id); const pId = params.length;
    extra.push(`(last_activity_at, conversation_id) < ($${pTs}::timestamptz, $${pId}::uuid)`);
  }

  params.push(lim + 1); // +1 sonda p/ saber se há próxima página
  const pLimit = params.length;
  const where = extra.length ? `WHERE ${extra.join(' AND ')}` : '';

  const sql = `
    WITH cfg AS (
      SELECT COALESCE(MAX(dormancy_days), 7) AS dormancy_days
        FROM tenant_lead_config WHERE tenant_id = $1
    ),
    conv AS (
      SELECT cv.id AS conversation_id, cv.channel, cv.external_id, cv.last_read_at,
             cv.updated_at, ${IDENT_CONV} AS ident
        FROM conversations cv
       WHERE cv.tenant_id = $1
         AND coalesce(cv.external_id, '') NOT LIKE '%@g.us'
    ),
    matched AS (
      SELECT c.*, l.id AS lead_id, l.name AS lead_name, l.phone AS lead_phone,
             l.meta_psid AS lead_psid, l.status AS lead_status, l.desfecho AS lead_desfecho,
             l.origem AS lead_origem
        FROM conv c
        LEFT JOIN LATERAL (
          SELECT l.id, l.name, l.phone, l.meta_psid, l.status, l.desfecho, l.origem
            FROM leads l
           WHERE c.ident <> '' AND ${IDENT_LEAD} = c.ident
           ORDER BY l.created_at ASC
           LIMIT 1
        ) l ON true
    ),
    -- Atividade = entrada do lead (messages USER) + saida da recepcao (staff_outbound).
    -- (conversations.updated_at = ultimo INBOUND apenas; nao confiar nele p/ ordenar - D-7.)
    act AS (
      SELECT c.conversation_id, m.received_at, 'lead'::text AS kind, m.body,
             m.media_type, m.edited_at, m.deleted_at
        FROM conv c
        JOIN messages m ON m.conversation_id = c.conversation_id AND m.role = 'USER'
      UNION ALL
      SELECT c.conversation_id, s.received_at, 'recepcao'::text AS kind, s.body,
             s.media_type, s.edited_at, s.deleted_at
        FROM conv c
        JOIN staff_outbound_samples s
          ON s.tenant_id = $1
         AND c.ident <> ''
         AND regexp_replace(s.external_id, '[^0-9]', '', 'g') = c.ident
         AND coalesce(s.raw->'data'->'key'->>'remoteJid', '') NOT LIKE '%@g.us'
    ),
    last_act AS (
      SELECT DISTINCT ON (a.conversation_id)
             a.conversation_id, a.received_at, a.kind, a.body,
             a.media_type, a.edited_at, a.deleted_at
        FROM act a
       ORDER BY a.conversation_id, a.received_at DESC
    ),
    projected AS (
      SELECT
        m.conversation_id, m.channel, m.external_id, m.ident,
        m.lead_id, m.lead_status, m.lead_desfecho,
        COALESCE(m.lead_name, m.external_id) AS nome,
        m.lead_phone, m.lead_psid,
        COALESCE(m.lead_origem, m.channel) AS fonte,
        (m.lead_id IS NOT NULL
           AND m.lead_status IS DISTINCT FROM 'NOT_LEAD'
           AND m.lead_status IS DISTINCT FROM 'REVIEW_QUEUE') AS is_lead,
        CASE WHEN m.lead_id IS NOT NULL
                  AND m.lead_status IS DISTINCT FROM 'NOT_LEAD'
                  AND m.lead_status IS DISTINCT FROM 'REVIEW_QUEUE'
             THEN (${statusVivoSql('m2')} AND NOT ${terminalSql('m2')}
                   AND la.received_at >= now() - (cfg.dormancy_days || ' days')::interval)
        END AS is_lead_ativo,
        COALESCE(la.received_at, m.updated_at) AS last_activity_at,
        la.kind AS ultima_kind, la.body AS ultima_body, la.media_type AS ultima_media_type,
        la.edited_at AS ultima_edited_at, la.deleted_at AS ultima_deleted_at,
        (SELECT count(*) FROM messages um
          WHERE um.conversation_id = m.conversation_id AND um.role = 'USER'
            AND (m.last_read_at IS NULL OR um.received_at > m.last_read_at)) AS nao_lidas
      FROM matched m
      CROSS JOIN cfg
      LEFT JOIN last_act la ON la.conversation_id = m.conversation_id
      -- alias m2 = a MESMA linha de lead, so p/ os fragmentos SQL do lifecycle.js (que
      -- esperam colunas status/desfecho num alias). LATERAL de 1 linha, sem custo.
      LEFT JOIN LATERAL (SELECT m.lead_status AS status, m.lead_desfecho AS desfecho) m2 ON true
    )
    SELECT * FROM projected
    ${where}
    ORDER BY last_activity_at DESC, conversation_id DESC
    LIMIT $${pLimit}
  `;

  return { sql, params, limit: lim };
}

// Projeta uma linha do SELECT no shape ConversationListItem do contrato.
function mapConversationRow(r) {
  return {
    conversation_id: r.conversation_id,
    channel: r.channel,
    external_id: r.external_id,
    ident: r.ident,
    fonte: r.fonte,
    is_lead: r.is_lead === true,
    is_lead_ativo: r.is_lead_ativo === null || r.is_lead_ativo === undefined ? null : r.is_lead_ativo === true,
    lead_id: r.lead_id || null,
    lead_status: r.lead_status || null,
    desfecho: r.lead_desfecho || null,
    contato: { nome: r.nome, phone: r.lead_phone || null, meta_psid: r.lead_psid || null },
    ultima_mensagem: r.last_activity_at ? {
      preview: preview(r.ultima_body, r.ultima_media_type, r.ultima_deleted_at),
      kind: r.ultima_kind || null,
      received_at: r.last_activity_at,
      media_type: r.ultima_media_type || null,
      edited_at: r.ultima_edited_at || null,
      deleted_at: r.ultima_deleted_at || null,
    } : null,
    last_activity_at: r.last_activity_at,
    nao_lidas: Number(r.nao_lidas) || 0,
  };
}

// Executa a listagem com um client já no contexto (RLS no handler; postgres no itest).
async function listConversations(client, tenantId, opts = {}) {
  const { sql, params, limit } = buildConversationsSql(tenantId, opts);
  const rows = (await client.query(sql, params)).rows;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(mapConversationRow);
  const last = page[page.length - 1];
  const next_cursor = hasMore && last ? encodeCursor(last.last_activity_at, last.conversation_id) : null;
  return { items, next_cursor };
}

// Move o cursor de leitura (compartilhado por tenant — migr. 080) e recalcula não-lidas.
async function markRead(client, tenantId, conversationId, upTo = null) {
  const upd = await client.query(
    `UPDATE conversations
        SET last_read_at = GREATEST(COALESCE(last_read_at, 'epoch'::timestamptz), COALESCE($2::timestamptz, now()))
      WHERE id = $1 AND tenant_id = $3
    RETURNING last_read_at`,
    [conversationId, upTo || null, tenantId]
  );
  if (!upd.rows.length) return null;
  const n = await client.query(
    `SELECT count(*)::int AS n FROM messages
      WHERE conversation_id = $1 AND role = 'USER' AND received_at > $2`,
    [conversationId, upd.rows[0].last_read_at]
  );
  return { last_read_at: upd.rows[0].last_read_at, nao_lidas: n.rows[0].n };
}

// Abre a thread de UMA conversa (E12-05), ancorada em conversation_id — funciona para
// conversa de NÃO-LEAD (leadId null => timeline sem o ramo IA). Retorna null se a conversa
// não existe no tenant.
async function getConversationThread(client, tenantId, conversationId) {
  const cv = (await client.query(
    `SELECT id, channel, external_id, last_read_at,
            regexp_replace(external_id, '[^0-9]', '', 'g') AS ident
       FROM conversations WHERE id = $1 AND tenant_id = $2`,
    [conversationId, tenantId]
  )).rows[0];
  if (!cv) return null;

  const lead = (await client.query(
    `SELECT id, name, phone, meta_psid, status, desfecho, origem
       FROM leads
      WHERE tenant_id = $1 AND $2 <> '' AND regexp_replace(coalesce(phone, meta_psid, ''), '[^0-9]', '', 'g') = $2
      ORDER BY created_at ASC LIMIT 1`,
    [tenantId, cv.ident]
  )).rows[0] || null;

  const timeline = await fetchTimeline(client, { tenantId, ident: cv.ident, leadId: lead ? lead.id : null });

  const is_lead = !!lead && lead.status !== 'NOT_LEAD' && lead.status !== 'REVIEW_QUEUE';
  return {
    conversation: {
      conversation_id: cv.id,
      channel: cv.channel,
      external_id: cv.external_id,
      ident: cv.ident,
      fonte: (lead && lead.origem) || cv.channel,
      is_lead,
      lead_id: lead ? lead.id : null,
      lead_status: lead ? lead.status : null,
      desfecho: lead ? lead.desfecho : null,
      last_read_at: cv.last_read_at,
      contato: {
        nome: (lead && lead.name) || cv.external_id,
        phone: lead ? lead.phone : null,
        meta_psid: lead ? lead.meta_psid : null,
      },
    },
    timeline,
  };
}

// Envia mensagem humana (E12-06) numa conversa, via Z-API/Evolution, e persiste a saída.
// Reusa o MESMO caminho da rota /leads/:id/mensagem (evolution.sendText + outbound.registrarSaida),
// mas ancorado em conversation_id (telefone = conversations.external_id) — serve não-lead também.
// `deps` injeta evolution/creds/registrar p/ o itest (mock da API externa). Retorna um objeto
// de resultado que o handler traduz em status HTTP (não lança nos casos de negócio).
async function sendMessage(tenantId, conversationId, { text, replyToMessageId = null, sender = null }, deps = {}) {
  const evolution = deps.evolution || evolutionDefault;
  const credsForTenant = deps.credsForTenant || outbound.credsForTenant;
  const registrarSaida = deps.registrarSaida || outbound.registrarSaida;
  const msgCitada = deps.msgCitada || outbound.msgCitada;

  const cv = await withTenant(tenantId, (c) =>
    c.query('SELECT channel, external_id FROM conversations WHERE id = $1 AND tenant_id = $2',
      [conversationId, tenantId]).then((r) => r.rows[0] || null));
  if (!cv) return { notFound: true };
  if (cv.channel !== 'whatsapp') return { unsupported: cv.channel };   // Fase 1: só WhatsApp
  const phone = cv.external_id;

  const creds = await credsForTenant(tenantId);
  if (!creds.instance || !creds.apikey) return { reason: 'tenant_sem_evolution' };
  const st = await evolution.status({ instance: creds.instance, apikey: creds.apikey });
  if (st.state !== 'open') return { reason: 'instancia=' + st.state };

  // Citação: quoted só quando a citada tem a key do WhatsApp; senão envia sem quoted mas
  // persiste reply_to_message_id p/ a citação visual (mesmo comportamento de /leads/:id).
  const citada = await msgCitada(tenantId, replyToMessageId);
  const quoted = citada && citada.wa_key ? { key: citada.wa_key } : undefined;
  const r = await evolution.sendText({ instance: creds.instance, apikey: creds.apikey }, phone, text, quoted);
  const messageId = evolution.pickMessageId(r);
  await registrarSaida(tenantId, {
    phone, externalMessageId: messageId, sender, body: text,
    replyToMessageId: citada ? citada.id : null,
  });
  return { ok: true, message_id: messageId, quoted: !!quoted };
}

// POST /tenant/:tenantId/inbox/conversations/:conversationId/mensagem — envio humano (E12-06).
router.post('/:tenantId/inbox/conversations/:conversationId/mensagem', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { conversationId } = req.params;
  if (!isUuid(conversationId)) return res.status(400).json({ error: 'invalid_conversation_id' });
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'empty_text' });
  const replyTo = typeof req.body?.reply_to_message_id === 'string' ? req.body.reply_to_message_id : null;
  try {
    const out = await sendMessage(req.tenantId, conversationId, { text, replyToMessageId: replyTo, sender: req.tenantRole });
    if (out.notFound) return res.status(404).json({ error: 'conversation_not_found' });
    if (out.unsupported) return res.status(422).json({ error: 'canal_nao_suportado', channel: out.unsupported });
    if (out.reason === 'tenant_sem_evolution') return res.status(400).json({ error: 'tenant_sem_evolution' });
    if (out.reason && out.reason.startsWith('instancia=')) return res.status(409).json({ error: out.reason });
    res.json({ ok: true, message_id: out.message_id, quoted: out.quoted });
  } catch (err) {
    logger.error('tenant.inbox.mensagem.error', { tenant_id: req.tenantId, error: err.message });
    res.status(502).json({ error: 'send_failed', detail: err.message });
  }
});

// GET /tenant/:tenantId/inbox/conversations/:conversationId — thread da conversa (E12-05).
router.get('/:tenantId/inbox/conversations/:conversationId', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  const { conversationId } = req.params;
  if (!isUuid(conversationId)) return res.status(400).json({ error: 'invalid_conversation_id' });
  try {
    const out = await withTenant(req.tenantId, (c) => getConversationThread(c, req.tenantId, conversationId));
    if (!out) return res.status(404).json({ error: 'conversation_not_found' });
    res.json({ tenant_id: req.tenantId, ...out });
  } catch (err) {
    logger.error('tenant.inbox.thread.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /tenant/:tenantId/inbox/conversations — listagem unificada (E12-03). CAMINHO CRÍTICO.
router.get('/:tenantId/inbox/conversations', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  const view = VIEWS.has(req.query.view) ? req.query.view : 'todas';
  const fonte = typeof req.query.fonte === 'string' && req.query.fonte.trim() ? req.query.fonte.trim() : null;
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null;
  const cursor = req.query.cursor ? decodeCursor(req.query.cursor) : null;
  if (req.query.cursor && !cursor) return res.status(400).json({ error: 'invalid_cursor' });

  try {
    const { items, next_cursor } = await withTenant(req.tenantId, (c) =>
      listConversations(c, req.tenantId, { view, fonte, q, limit: req.query.limit, cursor }));
    res.json({ tenant_id: req.tenantId, view, count: items.length, items, next_cursor });
  } catch (err) {
    logger.error('tenant.inbox.conversations.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /tenant/:tenantId/inbox/conversations/:conversationId/marcar-lido
//   body: { up_to?: timestamptz }  — default now(). Cursor compartilhado por tenant (migr. 080).
router.post('/:tenantId/inbox/conversations/:conversationId/marcar-lido', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { conversationId } = req.params;
  if (!isUuid(conversationId)) return res.status(400).json({ error: 'invalid_conversation_id' });
  let upTo = null;
  if (req.body && req.body.up_to) {
    const d = new Date(req.body.up_to);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'invalid_up_to' });
    upTo = d.toISOString();
  }
  try {
    const out = await withTenant(req.tenantId, (c) => markRead(c, req.tenantId, conversationId, upTo));
    if (!out) return res.status(404).json({ error: 'conversation_not_found' });
    res.json({ ok: true, ...out });
  } catch (err) {
    logger.error('tenant.inbox.marcar_lido.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
// Superfície testável (itest exercita a lógica SQL contra Postgres real).
module.exports.buildConversationsSql = buildConversationsSql;
module.exports.mapConversationRow = mapConversationRow;
module.exports.listConversations = listConversations;
module.exports.getConversationThread = getConversationThread;
module.exports.sendMessage = sendMessage;
module.exports.markRead = markRead;
module.exports.encodeCursor = encodeCursor;
module.exports.decodeCursor = decodeCursor;
module.exports.preview = preview;
