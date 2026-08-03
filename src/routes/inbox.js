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
const metaDefault = require('../meta');
const gemini = require('../gemini');
const { loadRealHistory } = require('../engine');
const { resolveSystemPrompt } = require('../templates');
const mediaLib = require('../media');
const multer = require('multer');
const logger = require('../logger');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Mesmos papéis do resto do namespace /tenant (tenant.js).
const READ_ROLES = ['TENANT_ADMIN', 'RECEPCAO', 'VISUALIZADOR'];
const WRITE_ROLES = ['TENANT_ADMIN', 'RECEPCAO'];

// Dígitos do telefone/psid — chave de casamento conversa↔lead↔saída (não há FK; D-1 do
// contrato). Igual ao _IDENT usado em tenant.js.
const IDENT_CONV = "regexp_replace(cv.external_id, '[^0-9]', '', 'g')";
const IDENT_LEAD = "regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')";

const VIEWS = new Set(['todas', 'leads', 'nao_lead', 'renovacoes']);

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
  // Renovações: contrato com vencimento na janela (≤ hoje+90d) + rastro de vencidos (≥ hoje-30d).
  // Janela ampla e configurável no futuro (ADR-049 §3.2); por ora fixa. Saída automática = quando
  // renova, MAX(fim_vigencia) vai pra frente e o contrato deixa a janela sozinho.
  else if (v === 'renovacoes') {
    extra.push("venc IS NOT NULL AND venc <= current_date + interval '90 days' AND venc >= current_date - interval '30 days'");
  }

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
             cv.updated_at, cv.conversation_kind, ${IDENT_CONV} AS ident,
             br_phone_key(cv.external_id) AS rkey   -- chave canônica p/ casar contrato (migr. 085)
        FROM conversations cv
       WHERE cv.tenant_id = $1
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
    -- Renovações (ADR-049): vencimento do contrato MAIS RECENTE por telefone (dígitos), lendo o
    -- canônico service_account via account_member→person→contact_point (mesma ponte do
    -- contractConvert.js). MAX(fim_vigencia): se renovou (novo contrato futuro), o vencimento vai
    -- pra frente → a conversa sai da janela sozinha (saída automática). fonte_ausente_em IS NULL =
    -- contrato ainda presente na fonte (o cancelado/substituído é marcado ausente pela sync).
    renov AS (
      SELECT br_phone_key(cp.value_raw) AS rk,
             MAX(sa.fim_vigencia) AS venc
        FROM service_account sa
        JOIN account_member am ON am.account_id = sa.id AND am.tenant_id = $1
        JOIN contact_point cp  ON cp.person_id = am.person_id AND cp.tenant_id = $1
                              AND cp.kind = 'phone'
       WHERE sa.tenant_id = $1
         AND sa.fonte_ausente_em IS NULL
         AND br_phone_key(cp.value_raw) <> ''
       GROUP BY 1
    ),
    -- Nome do CADASTRO (canônico): telefone → person.display_name pela MESMA chave br_phone_key.
    -- O aluno não vira lead, então sem isto a lista mostra o número. min() = 1 nome por telefone.
    pess AS (
      SELECT br_phone_key(cp.value_raw) AS rk, min(p.display_name) AS display_name
        FROM contact_point cp
        JOIN person p ON p.id = cp.person_id AND p.tenant_id = $1
       WHERE cp.tenant_id = $1 AND cp.kind = 'phone'
         AND coalesce(p.display_name, '') <> ''
         AND br_phone_key(cp.value_raw) <> ''
       GROUP BY 1
    ),
    projected AS (
      SELECT
        m.conversation_id, m.channel, m.external_id, m.ident, m.conversation_kind,
        rn.venc AS venc, (rn.venc - current_date)::int AS venc_dias,
        m.lead_id, m.lead_status, m.lead_desfecho,
        -- Nome EMPILHADO (usa ao máximo o canônico): cadastro → lead → pushName do WhatsApp → número.
        COALESCE(pe.display_name, m.lead_name,
                 (SELECT sm.sender FROM messages sm
                   WHERE sm.conversation_id = m.conversation_id AND sm.role = 'USER'
                     AND coalesce(sm.sender, '') <> '' ORDER BY sm.received_at DESC LIMIT 1),
                 m.external_id) AS nome,
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
      LEFT JOIN renov rn ON rn.rk = m.rkey AND m.rkey <> ''
      LEFT JOIN pess pe ON pe.rk = m.rkey AND m.rkey <> ''
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
    is_group: r.conversation_kind === 'GROUP',
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
    // ADR-049: presente quando a pessoa tem contrato com vencimento (renovação). venc = data ISO
    // (YYYY-MM-DD); dias = dias até vencer (negativo = vencido). O estágio (D-45/30/15/7/vencido)
    // é rotulado no dashboard, reusando a lógica da régua.
    renovacao: r.venc ? {
      venc: r.venc instanceof Date ? r.venc.toISOString().slice(0, 10) : String(r.venc).slice(0, 10),
      dias: r.venc_dias == null ? null : Number(r.venc_dias),
    } : null,
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

// Marca a conversa como NÃO-LIDA (igual WhatsApp): recua o cursor p/ 1ms ANTES da última
// mensagem RECEBIDA, de modo que ela (e posteriores) voltem a contar como não-lidas. Se não
// houver mensagem recebida, não há o que marcar. Retorna null se a conversa não é do tenant.
async function markUnread(client, tenantId, conversationId) {
  const last = (await client.query(
    `SELECT received_at FROM messages WHERE conversation_id = $1 AND role = 'USER'
      ORDER BY received_at DESC LIMIT 1`, [conversationId])).rows[0];
  if (!last) {
    const ok = (await client.query('SELECT 1 FROM conversations WHERE id = $1 AND tenant_id = $2', [conversationId, tenantId])).rows[0];
    return ok ? { ok: true, nao_lidas: 0 } : null;
  }
  const upd = await client.query(
    `UPDATE conversations SET last_read_at = $2::timestamptz - interval '1 millisecond'
      WHERE id = $1 AND tenant_id = $3 RETURNING id`,
    [conversationId, last.received_at, tenantId]);
  if (!upd.rows.length) return null;
  const n = (await client.query(
    `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND role = 'USER'
      AND received_at > $2::timestamptz - interval '1 millisecond'`, [conversationId, last.received_at])).rows[0].n;
  return { ok: true, nao_lidas: n };
}

// Abre a thread de UMA conversa (E12-05), ancorada em conversation_id — funciona para
// conversa de NÃO-LEAD (leadId null => timeline sem o ramo IA). Retorna null se a conversa
// não existe no tenant.
async function getConversationThread(client, tenantId, conversationId, usuario) {
  const cv = (await client.query(
    `SELECT id, channel, external_id, last_read_at, conversation_kind,
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

  // Nome EMPILHADO (mesma lógica da lista): cadastro canônico → lead → pushName do WhatsApp → número.
  const cadastroNome = (await client.query(
    `SELECT min(p.display_name) AS nome
       FROM contact_point cp JOIN person p ON p.id = cp.person_id AND p.tenant_id = $1
      WHERE cp.tenant_id = $1 AND cp.kind = 'phone'
        AND coalesce(p.display_name, '') <> '' AND br_phone_key(cp.value_raw) = br_phone_key($2)`,
    [tenantId, cv.external_id])).rows[0]?.nome || null;
  const pushNome = (await client.query(
    `SELECT sender FROM messages WHERE conversation_id = $1 AND role = 'USER'
        AND coalesce(sender, '') <> '' ORDER BY received_at DESC LIMIT 1`,
    [conversationId])).rows[0]?.sender || null;

  const timeline = await fetchTimeline(client, { tenantId, ident: cv.ident, leadId: lead ? lead.id : null });

  // ADR-042 — marca as bolhas FAVORITADAS (estrela) DO USUÁRIO (favorited_by). Cada recepcionista
  // vê só as suas. Sem usuario => nenhuma (favorited_by nunca é null nas linhas gravadas).
  const favSet = new Set((await client.query(
    `SELECT message_id FROM message_favorites WHERE tenant_id = $1 AND conversation_id = $2 AND favorited_by = $3`,
    [tenantId, conversationId, usuario ? String(usuario) : ''])).rows.map((r) => r.message_id));
  if (favSet.size) for (const m of timeline) if (favSet.has(m.id)) m.favorito = true;

  // ADR-042 — ATRIBUIÇÃO DE CAMPANHA (first-touch): se a conversa Meta veio de um anúncio
  // "enviar mensagem", pega o toque mais antigo (ad_id/ref/anúncio). null = DM orgânico.
  let atribuicao = null;
  if (cv.channel === 'facebook_messenger' || cv.channel === 'instagram_dm') {
    const r = (await client.query(
      `SELECT ad_id, ref, source, ref_type, ads_context, received_at
         FROM meta_ad_referral
        WHERE tenant_id = $1 AND channel = $2 AND psid = $3
        ORDER BY received_at ASC LIMIT 1`, [tenantId, cv.channel, cv.external_id])).rows[0];
    if (r) {
      const ctx = r.ads_context || {};
      atribuicao = {
        ad_id: r.ad_id, ref: r.ref, source: r.source, tipo: r.ref_type,
        anuncio_titulo: ctx.ad_title || null, anuncio_foto: ctx.photo_url || null, post_id: ctx.post_id || null,
        em: r.received_at,
      };
    }
  }

  const is_lead = !!lead && lead.status !== 'NOT_LEAD' && lead.status !== 'REVIEW_QUEUE';
  return {
    conversation: {
      conversation_id: cv.id,
      channel: cv.channel,
      external_id: cv.external_id,
      ident: cv.ident,
      fonte: (lead && lead.origem) || cv.channel,
      is_group: cv.conversation_kind === 'GROUP',
      conversation_kind: cv.conversation_kind || 'DIRECT',
      is_lead,
      lead_id: lead ? lead.id : null,
      lead_status: lead ? lead.status : null,
      desfecho: lead ? lead.desfecho : null,
      last_read_at: cv.last_read_at,
      atribuicao,
      contato: {
        nome: cadastroNome || (lead && lead.name) || pushNome || cv.external_id,
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

  // Meta (Instagram DM / Facebook Messenger): envia pela Graph API (meta.sendMessage), pelo PSID
  // (= external_id). Persiste a saída como o WhatsApp (staff_outbound_samples), então aparece na
  // thread. Sem "quoted"/edição (a Graph não expõe o mesmo modelo). Janela de 24h: erro legível.
  if (cv.channel === 'instagram_dm' || cv.channel === 'facebook_messenger') {
    const meta = deps.meta || metaDefault;
    const pageCreds = deps.pageCredsForTenant || meta.pageCredsForTenant;
    const creds = await pageCreds(tenantId);
    if (!creds || !creds.pageId || !creds.token) return { reason: 'tenant_sem_meta' };
    let r;
    try {
      r = await meta.sendMessage({ pageId: creds.pageId, token: creds.token }, cv.external_id, text);
    } catch (e) {
      return { reason: 'meta_falhou', detail: e.message };
    }
    const messageId = (r && (r.message_id || r.mid)) || null;
    await registrarSaida(tenantId, { phone: cv.external_id, externalMessageId: messageId, sender, body: text, replyToMessageId: null });
    return { ok: true, message_id: messageId, channel: cv.channel };
  }

  // Comentários de post (IG/FB): responde PUBLICAMENTE ao ÚLTIMO comentário da conversa (Graph).
  // Persiste a saída como o WhatsApp (staff_outbound_samples) p/ aparecer na thread.
  if (cv.channel === 'instagram_comment' || cv.channel === 'facebook_comment') {
    const meta = deps.meta || metaDefault;
    const pageCreds = deps.pageCredsForTenant || meta.pageCredsForTenant;
    const creds = await pageCreds(tenantId);
    if (!creds || !creds.token) return { reason: 'tenant_sem_meta' };
    const alvo = await withTenant(tenantId, (c) =>
      c.query(`SELECT external_message_id FROM messages
                 WHERE conversation_id = $1 AND role = 'USER' AND external_message_id IS NOT NULL
                 ORDER BY received_at DESC LIMIT 1`, [conversationId]).then((r) => r.rows[0]));
    if (!alvo || !alvo.external_message_id) return { reason: 'sem_comentario_alvo' };
    let r;
    try {
      r = await meta.replyToComment({ commentId: alvo.external_message_id, token: creds.token, channel: cv.channel }, text);
    } catch (e) {
      return { reason: 'meta_falhou', detail: e.message };
    }
    const messageId = (r && r.id) || null;
    await registrarSaida(tenantId, { phone: cv.external_id, externalMessageId: messageId, sender, body: text, replyToMessageId: null });
    return { ok: true, message_id: messageId, channel: cv.channel };
  }

  if (cv.channel !== 'whatsapp') return { unsupported: cv.channel };
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

// ADR-042/Meta — oculta/reexibe um comentário de post (IG/FB). commentId = external_message_id
// da bolha. Resolve o canal pela conversa e o token pelo tenant. Não lança nos casos de negócio.
async function ocultarComentario(tenantId, conversationId, commentId, hidden, deps = {}) {
  const meta = deps.meta || metaDefault;
  const pageCreds = deps.pageCredsForTenant || meta.pageCredsForTenant;
  const cv = await withTenant(tenantId, (c) =>
    c.query('SELECT channel FROM conversations WHERE id = $1 AND tenant_id = $2', [conversationId, tenantId]).then((r) => r.rows[0] || null));
  if (!cv) return { notFound: true };
  if (cv.channel !== 'instagram_comment' && cv.channel !== 'facebook_comment') return { unsupported: cv.channel };
  const creds = await pageCreds(tenantId);
  if (!creds || !creds.token) return { reason: 'tenant_sem_meta' };
  try {
    await meta.hideComment({ commentId, token: creds.token, channel: cv.channel }, hidden);
  } catch (e) {
    return { reason: 'meta_falhou', detail: e.message };
  }
  return { ok: true, hidden: !!hidden };
}

// POST /tenant/:tenantId/inbox/conversations/:conversationId/comentario/ocultar — oculta/reexibe (ADR-042).
router.post('/:tenantId/inbox/conversations/:conversationId/comentario/ocultar', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { conversationId } = req.params;
  if (!isUuid(conversationId)) return res.status(400).json({ error: 'invalid_conversation_id' });
  const commentId = typeof req.body?.comment_id === 'string' ? req.body.comment_id.trim() : '';
  if (!commentId) return res.status(400).json({ error: 'missing_comment_id' });
  const hidden = req.body?.hidden !== false;   // default: ocultar
  try {
    const out = await ocultarComentario(req.tenantId, conversationId, commentId, hidden);
    if (out.notFound) return res.status(404).json({ error: 'conversation_not_found' });
    if (out.unsupported) return res.status(422).json({ error: 'canal_nao_suportado', channel: out.unsupported });
    if (out.reason === 'tenant_sem_meta') return res.status(400).json({ error: 'tenant_sem_meta' });
    if (out.reason === 'meta_falhou') return res.status(502).json({ error: 'meta_falhou', detail: out.detail });
    res.json({ ok: true, hidden: out.hidden });
  } catch (err) {
    logger.error('tenant.inbox.ocultar.error', { tenant_id: req.tenantId, error: err.message });
    res.status(502).json({ error: 'hide_failed', detail: err.message });
  }
});

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
    if (out.reason === 'tenant_sem_meta') return res.status(400).json({ error: 'tenant_sem_meta' });
    if (out.reason === 'meta_falhou') return res.status(502).json({ error: 'meta_falhou', detail: out.detail });
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
  const usuario = typeof req.query.usuario === 'string' ? req.query.usuario : '';
  try {
    const out = await withTenant(req.tenantId, (c) => getConversationThread(c, req.tenantId, conversationId, usuario));
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

// GET /tenant/:tenantId/inbox/nao-lidas — total de mensagens não-lidas (soma), p/ o badge do nav.
router.get('/:tenantId/inbox/nao-lidas', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  try {
    const total = await withTenant(req.tenantId, async (c) => (await c.query(
      `SELECT COALESCE(SUM(n), 0)::int AS total FROM (
         SELECT (SELECT count(*) FROM messages m
                  WHERE m.conversation_id = cv.id AND m.role = 'USER'
                    AND (cv.last_read_at IS NULL OR m.received_at > cv.last_read_at)) AS n
           FROM conversations cv
          WHERE cv.tenant_id = $1 AND coalesce(cv.external_id, '') NOT LIKE '%@g.us'
       ) u`, [req.tenantId])).rows[0].total);
    res.json({ total });
  } catch (err) {
    logger.error('tenant.inbox.nao_lidas.error', { tenant_id: req.tenantId, error: err.message });
    res.json({ total: 0 });
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

// POST /tenant/:tenantId/inbox/conversations/:conversationId/marcar-nao-lido — recua o cursor
// p/ a conversa voltar a aparecer como NÃO-LIDA (igual WhatsApp). Sem body.
router.post('/:tenantId/inbox/conversations/:conversationId/marcar-nao-lido', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { conversationId } = req.params;
  if (!isUuid(conversationId)) return res.status(400).json({ error: 'invalid_conversation_id' });
  try {
    const out = await withTenant(req.tenantId, (c) => markUnread(c, req.tenantId, conversationId));
    if (!out) return res.status(404).json({ error: 'conversation_not_found' });
    res.json(out);
  } catch (err) {
    logger.error('tenant.inbox.marcar_nao_lido.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// Apaga NOSSA mensagem (deleteMessageForEveryone) e reflete "apagada" (E12-07). Só bolhas
// outbound (resolver não casa bolha do lead → notFound). Idempotente. `deps` p/ o itest.
async function deleteInboxMessage(tenantId, mid, deps = {}) {
  const evolution = deps.evolution || evolutionDefault;
  const credsForTenant = deps.credsForTenant || outbound.credsForTenant;
  const resolverKeyMensagem = deps.resolverKeyMensagem || outbound.resolverKeyMensagem;

  const alvo = await withTenant(tenantId, (c) => resolverKeyMensagem(c, tenantId, mid));
  if (!alvo) return { notFound: true };
  if (alvo.deleted_at) return { ok: true, ja_apagada: true };
  const creds = await credsForTenant(tenantId);
  if (!creds.instance || !creds.apikey) return { reason: 'tenant_sem_evolution' };
  const del = await evolution.deleteMessage({ instance: creds.instance, apikey: creds.apikey }, alvo.key);
  if (!del.ok) return { reason: 'nao_apagou', detail: del.error };
  await withTenant(tenantId, (c) => c.query(
    'UPDATE staff_outbound_samples SET deleted_at = COALESCE(deleted_at, now()) WHERE tenant_id = $1 AND id = $2',
    [tenantId, alvo.soId]));
  return { ok: true };
}

// Edita NOSSA mensagem (updateMessage, janela de 15min validada pela Evolution) e reflete o
// texto novo + "editada". Só bolhas outbound. `deps` p/ o itest.
async function editInboxMessage(tenantId, mid, text, deps = {}) {
  const evolution = deps.evolution || evolutionDefault;
  const credsForTenant = deps.credsForTenant || outbound.credsForTenant;
  const resolverKeyMensagem = deps.resolverKeyMensagem || outbound.resolverKeyMensagem;

  const alvo = await withTenant(tenantId, (c) => resolverKeyMensagem(c, tenantId, mid));
  if (!alvo) return { notFound: true };
  const creds = await credsForTenant(tenantId);
  if (!creds.instance || !creds.apikey) return { reason: 'tenant_sem_evolution' };
  const ed = await evolution.editMessage({ instance: creds.instance, apikey: creds.apikey }, alvo.key, alvo.phone, text);
  if (!ed.ok) return { reason: 'nao_editou', detail: ed.error };
  await withTenant(tenantId, async (c) => {
    await c.query(
      `UPDATE staff_outbound_samples SET original_body = COALESCE(original_body, body), body = $3, edited_at = now()
        WHERE tenant_id = $1 AND id = $2`, [tenantId, alvo.soId, text]);
    if (alvo.paId) {
      await c.query('UPDATE pending_approvals SET suggested_response = $3 WHERE tenant_id = $1 AND id = $2',
        [tenantId, alvo.paId, text]);
    }
  });
  return { ok: true, body: text };
}

// Traduz o resultado dos helpers de editar/apagar em status HTTP.
function _respostaAcao(res, out) {
  if (out.notFound) return res.status(404).json({ error: 'nao_encontrada' });   // bloqueia bolha do lead/inbound
  if (out.reason === 'tenant_sem_evolution') return res.status(400).json({ error: 'tenant_sem_evolution' });
  if (out.reason) return res.status(502).json({ error: out.reason, detail: out.detail });
  return res.json(out);
}

// POST /tenant/:tenantId/inbox/conversations/:cid/mensagem/:mid/apagar (E12-07)
router.post('/:tenantId/inbox/conversations/:conversationId/mensagem/:mid/apagar', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  if (!isUuid(req.params.mid)) return res.status(400).json({ error: 'invalid_mid' });
  try {
    _respostaAcao(res, await deleteInboxMessage(req.tenantId, req.params.mid));
  } catch (err) {
    logger.error('tenant.inbox.apagar.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /tenant/:tenantId/inbox/conversations/:cid/mensagem/:mid/editar { text } (E12-07)
router.post('/:tenantId/inbox/conversations/:conversationId/mensagem/:mid/editar', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  if (!isUuid(req.params.mid)) return res.status(400).json({ error: 'invalid_mid' });
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'empty_text' });
  try {
    _respostaAcao(res, await editInboxMessage(req.tenantId, req.params.mid, text));
  } catch (err) {
    logger.error('tenant.inbox.editar.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// ---- #2 REAGIR (curtir etc.) — Fase 1.5 -----------------------------------------------------
// Resolve a key do WhatsApp de QUALQUER bolha (nossa outbound OU inbound do cliente).
async function _keyParaReacao(c, tenantId, mid) {
  const nosso = await outbound.resolverKeyMensagem(c, tenantId, mid);
  if (nosso) return nosso.key;
  const m = (await c.query(
    `SELECT m.external_message_id, m.raw#>'{data,key}' AS wa_key,
            regexp_replace(cv.external_id, '[^0-9]', '', 'g') AS phone
       FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
      WHERE cv.tenant_id = $1 AND m.id = $2`, [tenantId, mid])).rows[0];
  if (!m) return null;
  if (m.wa_key) return m.wa_key;                                            // key crua do webhook
  if (m.external_message_id && m.phone) return { id: m.external_message_id, remoteJid: `${m.phone}@s.whatsapp.net`, fromMe: false };
  return null;
}
async function reactToMessage(tenantId, mid, emoji, deps = {}) {
  const evolution = deps.evolution || evolutionDefault;
  const credsForTenant = deps.credsForTenant || outbound.credsForTenant;
  const key = await withTenant(tenantId, (c) => _keyParaReacao(c, tenantId, mid));
  if (!key) return { notFound: true };
  const creds = await credsForTenant(tenantId);
  if (!creds.instance || !creds.apikey) return { reason: 'tenant_sem_evolution' };
  const rr = await evolution.sendReaction({ instance: creds.instance, apikey: creds.apikey }, key, emoji);
  if (!rr.ok) return { reason: 'nao_reagiu', detail: rr.error };
  return { ok: true };
}
router.post('/:tenantId/inbox/conversations/:conversationId/mensagem/:mid/reagir', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  if (!isUuid(req.params.mid)) return res.status(400).json({ error: 'invalid_mid' });
  const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji : '👍';
  try {
    _respostaAcao(res, await reactToMessage(req.tenantId, req.params.mid, emoji));
  } catch (err) {
    logger.error('tenant.inbox.reagir.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// ---- FAVORITAR (estrela) — ADR-042 ----------------------------------------------------------
// Toggle local (NÃO chama o WhatsApp — favorito é visão interna da recepção). Referencia a bolha
// por (conversation_id, kind, message_id). Existe → desfavorita (DELETE); senão → favorita.
const _FAV_KINDS = new Set(['lead', 'recepcao', 'ia']);
// Favoritas são POR USUÁRIO (favorited_by = id do usuário do dashboard). Toggle escopado ao dono:
// cada recepcionista favorita/desfavorita as SUAS. Índice único (tenant, message, favorited_by).
async function toggleFavorito(tenantId, conversationId, mid, kind, usuario) {
  const dono = usuario ? String(usuario) : '';
  return withTenant(tenantId, async (c) => {
    const del = await c.query(
      'DELETE FROM message_favorites WHERE tenant_id = $1 AND message_id = $2 AND favorited_by = $3 RETURNING id',
      [tenantId, mid, dono]);
    if (del.rows.length) return { ok: true, favorito: false };
    await c.query(
      `INSERT INTO message_favorites (tenant_id, conversation_id, message_kind, message_id, favorited_by)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, message_id, favorited_by) DO NOTHING`,
      [tenantId, conversationId, _FAV_KINDS.has(kind) ? kind : 'lead', mid, dono]);
    return { ok: true, favorito: true };
  });
}
router.post('/:tenantId/inbox/conversations/:conversationId/mensagem/:mid/favoritar', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  if (!isUuid(req.params.conversationId)) return res.status(400).json({ error: 'invalid_conversation_id' });
  if (!isUuid(req.params.mid)) return res.status(400).json({ error: 'invalid_mid' });
  const kind = typeof req.body?.kind === 'string' ? req.body.kind : 'lead';
  const usuario = req.body?.usuario != null ? String(req.body.usuario) : '';
  try {
    const out = await toggleFavorito(req.tenantId, req.params.conversationId, req.params.mid, kind, usuario);
    res.json(out);
  } catch (err) {
    logger.error('tenant.inbox.favoritar.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// ---- #3 ANEXAR ARQUIVO — Fase 1.5 (reusa evolution.sendMedia + outbound.registrarSaida) ------
const _PLACEHOLDER_MIDIA = { audio: '[áudio]', image: '[imagem]', video: '[vídeo]', document: '[documento]' };
async function sendInboxMedia(tenantId, conversationId, file, caption, sender, deps = {}) {
  const evolution = deps.evolution || evolutionDefault;
  const credsForTenant = deps.credsForTenant || outbound.credsForTenant;
  const registrarSaida = deps.registrarSaida || outbound.registrarSaida;
  const saveBuffer = deps.saveBuffer || mediaLib.salvarBuffer;

  const cv = await withTenant(tenantId, (c) =>
    c.query('SELECT channel, external_id FROM conversations WHERE id = $1 AND tenant_id = $2', [conversationId, tenantId]).then((r) => r.rows[0] || null));
  if (!cv) return { notFound: true };
  if (cv.channel !== 'whatsapp') return { unsupported: cv.channel };
  const creds = await credsForTenant(tenantId);
  if (!creds.instance || !creds.apikey) return { reason: 'tenant_sem_evolution' };
  const st = await evolution.status({ instance: creds.instance, apikey: creds.apikey });
  if (st.state !== 'open') return { reason: 'instancia=' + st.state };

  const mimetype = file.mimetype || 'application/octet-stream';
  const filename = file.originalname || 'arquivo';
  const saved = saveBuffer({ tenantId, buffer: file.buffer, mimetype, filename });
  const r = await evolution.sendMedia({ instance: creds.instance, apikey: creds.apikey }, cv.external_id, {
    mediatype: saved.media_type, mimetype, media: saved.base64, fileName: filename, caption: caption || undefined,
  });
  const messageId = evolution.pickMessageId(r);
  const ph = caption || (saved.media_type === 'document' ? `[documento: ${filename}]` : (_PLACEHOLDER_MIDIA[saved.media_type] || '[mídia]'));
  await registrarSaida(tenantId, {
    phone: cv.external_id, externalMessageId: messageId, sender, body: ph,
    media: { url: saved.media_url, type: saved.media_type, filename: saved.media_type === 'document' ? filename : null },
  });
  return { ok: true, message_id: messageId, media_url: saved.media_url, media_type: saved.media_type };
}
router.post('/:tenantId/inbox/conversations/:conversationId/midia', authenticate, requireTenantAccess(WRITE_ROLES), upload.single('file'), async (req, res) => {
  if (!isUuid(req.params.conversationId)) return res.status(400).json({ error: 'invalid_conversation_id' });
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'no_file' });
  const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim() : '';
  try {
    const out = await sendInboxMedia(req.tenantId, req.params.conversationId, req.file, caption, req.tenantRole);
    if (out.notFound) return res.status(404).json({ error: 'conversation_not_found' });
    if (out.unsupported) return res.status(422).json({ error: 'canal_nao_suportado', channel: out.unsupported });
    if (out.reason === 'tenant_sem_evolution') return res.status(400).json({ error: 'tenant_sem_evolution' });
    if (out.reason && out.reason.startsWith('instancia=')) return res.status(409).json({ error: out.reason });
    res.json(out);
  } catch (err) {
    logger.error('tenant.inbox.midia.error', { tenant_id: req.tenantId, error: err.message });
    res.status(502).json({ error: 'send_failed', detail: err.message });
  }
});

// ---- NOTA DE VOZ (ptt) gravada no navegador — ADR-042 ---------------------------------------
// Salva o áudio (p/ a thread exibir o player), envia via evolution.sendWhatsAppAudio (ptt, com
// conversão server-side); se a Evolution não suportar/derrubar o ptt, cai no sendMedia (áudio
// normal). Persiste como saída de mídia 'audio'. `deps` p/ o itest.
async function sendInboxAudio(tenantId, conversationId, file, sender, deps = {}) {
  const evolution = deps.evolution || evolutionDefault;
  const credsForTenant = deps.credsForTenant || outbound.credsForTenant;
  const registrarSaida = deps.registrarSaida || outbound.registrarSaida;
  const saveBuffer = deps.saveBuffer || mediaLib.salvarBuffer;

  const cv = await withTenant(tenantId, (c) =>
    c.query('SELECT channel, external_id FROM conversations WHERE id = $1 AND tenant_id = $2', [conversationId, tenantId]).then((r) => r.rows[0] || null));
  if (!cv) return { notFound: true };
  if (cv.channel !== 'whatsapp') return { unsupported: cv.channel };
  const creds = await credsForTenant(tenantId);
  if (!creds.instance || !creds.apikey) return { reason: 'tenant_sem_evolution' };
  const st = await evolution.status({ instance: creds.instance, apikey: creds.apikey });
  if (st.state !== 'open') return { reason: 'instancia=' + st.state };

  const mimetype = file.mimetype || 'audio/ogg';
  const saved = saveBuffer({ tenantId, buffer: file.buffer, mimetype, filename: file.originalname || 'nota-de-voz.ogg' });
  let r;
  try {
    r = await evolution.sendWhatsAppAudio({ instance: creds.instance, apikey: creds.apikey }, cv.external_id, saved.base64);
  } catch (e) {
    logger.warn('tenant.inbox.audio.ptt_fallback', { tenant_id: tenantId, error: e.message });
    r = await evolution.sendMedia({ instance: creds.instance, apikey: creds.apikey }, cv.external_id, {
      mediatype: 'audio', mimetype, media: saved.base64, fileName: saved.media_filename || 'nota-de-voz.ogg' });
  }
  const messageId = evolution.pickMessageId(r);
  await registrarSaida(tenantId, {
    phone: cv.external_id, externalMessageId: messageId, sender, body: '[áudio]',
    media: { url: saved.media_url, type: 'audio', filename: null },
  });
  return { ok: true, message_id: messageId, media_url: saved.media_url, media_type: 'audio' };
}
router.post('/:tenantId/inbox/conversations/:conversationId/audio', authenticate, requireTenantAccess(WRITE_ROLES), upload.single('file'), async (req, res) => {
  if (!isUuid(req.params.conversationId)) return res.status(400).json({ error: 'invalid_conversation_id' });
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'no_file' });
  try {
    const out = await sendInboxAudio(req.tenantId, req.params.conversationId, req.file, req.tenantRole);
    if (out.notFound) return res.status(404).json({ error: 'conversation_not_found' });
    if (out.unsupported) return res.status(422).json({ error: 'canal_nao_suportado', channel: out.unsupported });
    if (out.reason === 'tenant_sem_evolution') return res.status(400).json({ error: 'tenant_sem_evolution' });
    if (out.reason && out.reason.startsWith('instancia=')) return res.status(409).json({ error: out.reason });
    res.json(out);
  } catch (err) {
    logger.error('tenant.inbox.audio.error', { tenant_id: req.tenantId, error: err.message });
    res.status(502).json({ error: 'send_failed', detail: err.message });
  }
});

// ---- #4 SUGERIR RESPOSTA DA IA (sob demanda, sem persistir) — Fase 1.5 -----------------------
// Reusa loadRealHistory + gemini.generateReply + resolveSystemPrompt (compõe como o
// generateDraftForLead, mas SEM criar pending_approval — só devolve o texto p/ preencher o campo).
async function suggestReply(tenantId, conversationId, deps = {}) {
  const generate = deps.generate || gemini.generateReply;
  const info = await withTenant(tenantId, async (c) => {
    const cv = (await c.query(
      `SELECT id, regexp_replace(external_id, '[^0-9]', '', 'g') AS ident
         FROM conversations WHERE id = $1 AND tenant_id = $2`, [conversationId, tenantId])).rows[0];
    if (!cv) return null;
    const leadRow = (await c.query(
      `SELECT id FROM leads WHERE tenant_id = $1 AND regexp_replace(coalesce(phone, meta_psid, ''), '[^0-9]', '', 'g') = $2
        ORDER BY created_at ASC LIMIT 1`, [tenantId, cv.ident])).rows[0];
    const last = (await c.query(
      `SELECT body FROM messages WHERE conversation_id = $1 AND role = 'USER' ORDER BY received_at DESC LIMIT 1`, [cv.id])).rows[0];
    const cfg = (await c.query(
      `SELECT school_name, system_prompt_override, available_instruments, business_hours, notification_whatsapp
         FROM tenant_lead_config WHERE tenant_id = $1`, [tenantId])).rows[0];
    const tname = (await c.query('SELECT name FROM tenants WHERE id = $1', [tenantId])).rows[0]?.name;
    return {
      convId: cv.id, ident: cv.ident, leadId: (leadRow && leadRow.id) || null, lastBody: (last && last.body) || '',
      config: cfg || { school_name: tname || 'Escola', system_prompt_override: null, available_instruments: [], business_hours: {}, notification_whatsapp: null },
    };
  });
  if (!info) return { notFound: true };
  const history = await loadRealHistory(tenantId, { conversationId: info.convId, ident: info.ident, leadId: info.leadId });
  try {
    const suggestion = await generate({ systemPrompt: resolveSystemPrompt(info.config), history, message: info.lastBody, retomada: history.length > 0 });
    return { ok: true, suggestion };
  } catch (e) {
    return { reason: 'generate_error', detail: e.message };
  }
}
router.post('/:tenantId/inbox/conversations/:conversationId/sugerir', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  if (!isUuid(req.params.conversationId)) return res.status(400).json({ error: 'invalid_conversation_id' });
  try {
    const out = await suggestReply(req.tenantId, req.params.conversationId);
    if (out.notFound) return res.status(404).json({ error: 'conversation_not_found' });
    if (out.reason) return res.status(502).json({ error: out.reason, detail: out.detail });
    res.json(out);
  } catch (err) {
    logger.error('tenant.inbox.sugerir.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// ---- #5 MARCAR COMO LEAD — Fase 1.5 (promove lead casável OU cria a partir da conversa) -------
async function marcarComoLead(tenantId, conversationId, sender) {
  return withTenant(tenantId, async (c) => {
    const cv = (await c.query(
      `SELECT external_id, channel, regexp_replace(external_id, '[^0-9]', '', 'g') AS ident
         FROM conversations WHERE id = $1 AND tenant_id = $2`, [conversationId, tenantId])).rows[0];
    if (!cv) return { notFound: true };
    if (!cv.ident) return { noPhone: true };
    const existing = (await c.query(
      `SELECT id FROM leads WHERE tenant_id = $1 AND regexp_replace(coalesce(phone, meta_psid, ''), '[^0-9]', '', 'g') = $2
        ORDER BY created_at ASC LIMIT 1`, [tenantId, cv.ident])).rows[0];
    if (existing) {
      await c.query(
        `UPDATE leads SET status = 'QUALIFYING', review_queue = false, review_result = 'confirmed_lead',
                          review_em = now(), review_by = $2, updated_at = now()
          WHERE id = $1`, [existing.id, sender || null]);
      return { ok: true, lead_id: existing.id, created: false };
    }
    const nm = (await c.query(
      `SELECT sender FROM messages WHERE conversation_id = $1 AND role = 'USER' AND sender IS NOT NULL
        ORDER BY received_at ASC LIMIT 1`, [conversationId])).rows[0];
    const r = await c.query(
      `INSERT INTO leads (tenant_id, name, phone, status, origem)
       VALUES ($1, $2, $3, 'QUALIFYING', $4) RETURNING id`,
      [tenantId, (nm && nm.sender) || null, cv.external_id, cv.channel]);
    return { ok: true, lead_id: r.rows[0].id, created: true };
  });
}
router.post('/:tenantId/inbox/conversations/:conversationId/marcar-lead', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  if (!isUuid(req.params.conversationId)) return res.status(400).json({ error: 'invalid_conversation_id' });
  try {
    const out = await marcarComoLead(req.tenantId, req.params.conversationId, req.tenantRole);
    if (out.notFound) return res.status(404).json({ error: 'conversation_not_found' });
    if (out.noPhone) return res.status(422).json({ error: 'sem_telefone' });
    res.json(out);
  } catch (err) {
    logger.error('tenant.inbox.marcar_lead.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// ---- MARCAR "NÃO É LEAD" — ADR-042 (inverso de marcarComoLead) -------------------------------
// Reclassifica o contato como NOT_LEAD (ex.: gestora/fornecedor que mandou mensagem e caiu como
// lead). Some da lista de Leads. Se existir lead casável, atualiza; senão cria um registro
// NOT_LEAD (fica explícito e evita recaptura). NÃO confundir com "marcar-nao-lido" (leitura).
async function marcarComoNaoLead(tenantId, conversationId, sender) {
  return withTenant(tenantId, async (c) => {
    const cv = (await c.query(
      `SELECT external_id, channel, regexp_replace(external_id, '[^0-9]', '', 'g') AS ident
         FROM conversations WHERE id = $1 AND tenant_id = $2`, [conversationId, tenantId])).rows[0];
    if (!cv) return { notFound: true };
    if (!cv.ident) return { noPhone: true };
    const existing = (await c.query(
      `SELECT id FROM leads WHERE tenant_id = $1 AND regexp_replace(coalesce(phone, meta_psid, ''), '[^0-9]', '', 'g') = $2
        ORDER BY created_at ASC LIMIT 1`, [tenantId, cv.ident])).rows[0];
    if (existing) {
      await c.query(
        `UPDATE leads SET status = 'NOT_LEAD', review_queue = false, review_result = 'confirmed_not_lead',
                          review_em = now(), review_by = $2, updated_at = now()
          WHERE id = $1`, [existing.id, sender || null]);
      return { ok: true, lead_id: existing.id, created: false };
    }
    const nm = (await c.query(
      `SELECT sender FROM messages WHERE conversation_id = $1 AND role = 'USER' AND sender IS NOT NULL
        ORDER BY received_at ASC LIMIT 1`, [conversationId])).rows[0];
    const r = await c.query(
      `INSERT INTO leads (tenant_id, name, phone, status, origem, review_queue, review_result, review_em, review_by)
       VALUES ($1, $2, $3, 'NOT_LEAD', $4, false, 'confirmed_not_lead', now(), $5) RETURNING id`,
      [tenantId, (nm && nm.sender) || null, cv.external_id, cv.channel, sender || null]);
    return { ok: true, lead_id: r.rows[0].id, created: true };
  });
}
router.post('/:tenantId/inbox/conversations/:conversationId/desmarcar-lead', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  if (!isUuid(req.params.conversationId)) return res.status(400).json({ error: 'invalid_conversation_id' });
  try {
    const out = await marcarComoNaoLead(req.tenantId, req.params.conversationId, req.tenantRole);
    if (out.notFound) return res.status(404).json({ error: 'conversation_not_found' });
    if (out.noPhone) return res.status(422).json({ error: 'sem_telefone' });
    res.json(out);
  } catch (err) {
    logger.error('tenant.inbox.desmarcar_lead.error', { tenant_id: req.tenantId, error: err.message });
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
module.exports.ocultarComentario = ocultarComentario;
module.exports.deleteInboxMessage = deleteInboxMessage;
module.exports.editInboxMessage = editInboxMessage;
module.exports.reactToMessage = reactToMessage;
module.exports.sendInboxMedia = sendInboxMedia;
module.exports.sendInboxAudio = sendInboxAudio;
module.exports.suggestReply = suggestReply;
module.exports.marcarComoLead = marcarComoLead;
module.exports.marcarComoNaoLead = marcarComoNaoLead;
module.exports.toggleFavorito = toggleFavorito;
module.exports.markRead = markRead;
module.exports.markUnread = markUnread;
module.exports.encodeCursor = encodeCursor;
module.exports.decodeCursor = decodeCursor;
module.exports.preview = preview;
