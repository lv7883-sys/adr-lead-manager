'use strict';

// Namespace self-service da unidade (ADR-004, Decisão 4): /tenant/:tenantId/*.
// Distinto de /admin/* (plataforma). Autorização por (tenant, role).

const express = require('express');
const { withTenant } = require('../db');
const { anonymizeLead } = require('../anonymize');
const { authenticate } = require('../auth');
const { requireTenantRole, requireTenantAccess } = require('../rbac');
const { patchLeadConfig } = require('../leadConfig');
const { isUuid } = require('../validation');
const logger = require('../logger');
const evolution = require('../evolution');   // E4: envio direto via Evolution
const { decrypt } = require('../crypto');     // E4: token Evolution do tenant
const gemini = require('../gemini');          // D: melhorar resposta com IA
const { resolveSystemPrompt } = require('../templates');
const { computeMetrics, computeFunil, computePainel, PERIODS } = require('../metrics');   // G: dashboard de gestão
const { generateDraftForLead } = require('../engine');   // Bloco 2: rascunho ao confirmar lead

// Valida funil_period: '6m' | '12m' | 'year:YYYY' (senão cai no padrão 6m).
function parseFunilPeriod(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return (s === '6m' || s === '12m' || /^year:\d{4}$/.test(s)) ? s : '6m';
}

const router = express.Router();

// Leitura: todos os papéis do tenant (ADR-004 §4b) + serviços internos.
const READ_ROLES = ['TENANT_ADMIN', 'RECEPCAO', 'VISUALIZADOR'];
// Decidir (aprovar/rejeitar) é ação operacional: TENANT_ADMIN/RECEPCAO + serviços.
const WRITE_ROLES = ['TENANT_ADMIN', 'RECEPCAO'];

// Self-service: o TENANT_ADMIN configura o Lead Manager da própria unidade
// (E9-06). PLATFORM_ADMIN também acessa via impersonation (requireTenantRole).
// RECEPCAO/VISUALIZADOR -> 403; outro tenant -> 403.
router.patch(
  '/:tenantId/lead-config',
  authenticate,
  requireTenantRole(['TENANT_ADMIN']),
  patchLeadConfig
);

// GET /tenant/:tid/metrics?period=7d|30d|90d&channel= — agregações do dashboard
// de gestão (G). READ-ONLY. Acesso restrito a gerente/admin é aplicado no Scheduler.
router.get(
  '/:tenantId/metrics',
  authenticate,
  requireTenantAccess(READ_ROLES),
  async (req, res) => {
    const period = PERIODS[req.query.period] ? req.query.period : '30d';
    const channel = typeof req.query.channel === 'string' && req.query.channel.trim()
      ? req.query.channel.trim() : null;
    const funilPeriod = parseFunilPeriod(req.query.funil_period);
    try {
      const data = await computeMetrics(req.tenantId, { period, channel });
      const funil = await computeFunil(req.tenantId, { funilPeriod });
      res.json({ ...data, ...funil });
    } catch (err) {
      logger.error('tenant.metrics.error', { tenant_id: req.tenantId, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// GET /tenant/:tid/funil?funil_period=6m|12m|year:YYYY — só o funil de conversão
// mensal (rota leve pro recarregamento do gráfico sem refazer todas as métricas).
router.get(
  '/:tenantId/funil',
  authenticate,
  requireTenantAccess(READ_ROLES),
  async (req, res) => {
    const funilPeriod = parseFunilPeriod(req.query.funil_period);
    try {
      res.json(await computeFunil(req.tenantId, { funilPeriod }));
    } catch (err) {
      logger.error('tenant.funil.error', { tenant_id: req.tenantId, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// GET /tenant/:tid/painel — fila de ação do turno da recepção (Item 4): leads que
// precisam de atenção + indicadores de hoje + resumo. READ-ONLY.
router.get(
  '/:tenantId/painel',
  authenticate,
  requireTenantAccess(READ_ROLES),
  async (req, res) => {
    try {
      res.json(await computePainel(req.tenantId));
    } catch (err) {
      logger.error('tenant.painel.error', { tenant_id: req.tenantId, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// GET /tenant/:tid/review-queue — Bloco 2: mensagens aguardando revisão humana
// (review_queue=true, ainda não decididas). READ-ONLY.
router.get(
  '/:tenantId/review-queue',
  authenticate,
  requireTenantAccess(READ_ROLES),
  async (req, res) => {
    try {
      const leads = await withTenant(req.tenantId, async (c) => (
        await c.query(
          `SELECT l.id, l.name, l.phone, l.meta_psid, l.status,
                  l.classification_confidence AS confidence,
                  l.classification_reasoning  AS reasoning,
                  l.classification_signals    AS signals,
                  l.created_at,
                  (SELECT cv.channel FROM conversations cv
                    WHERE regexp_replace(cv.external_id, '[^0-9]', '', 'g')
                        = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
                      AND cv.tenant_id = $1
                    ORDER BY cv.updated_at DESC LIMIT 1) AS channel,
                  (SELECT m.body FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
                    WHERE cv.tenant_id = $1
                      AND regexp_replace(cv.external_id, '[^0-9]', '', 'g')
                        = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
                      AND m.role = 'USER'
                    ORDER BY m.received_at ASC LIMIT 1) AS first_message
             FROM leads l
            WHERE l.review_queue = true AND l.review_result IS NULL
            ORDER BY l.classification_confidence DESC NULLS LAST, l.created_at DESC
            LIMIT 200`,
          [req.tenantId]
        )
      ).rows);
      res.json({ tenant_id: req.tenantId, count: leads.length, leads });
    } catch (err) {
      logger.error('tenant.review_queue.error', { tenant_id: req.tenantId, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// POST /tenant/:tid/leads/:id/review — Bloco 2: decide um lead da fila de revisão.
// body { result: 'confirmed_lead' | 'confirmed_not_lead' }. Auth igual a approve.
router.post(
  '/:tenantId/leads/:id/review',
  authenticate,
  requireTenantAccess(WRITE_ROLES),
  async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
    const result = req.body?.result;
    if (result !== 'confirmed_lead' && result !== 'confirmed_not_lead') {
      return res.status(400).json({ error: 'invalid result' });
    }
    try {
      const updated = await withTenant(req.tenantId, async (c) => {
        const isLead = result === 'confirmed_lead';
        const r = await c.query(
          `UPDATE leads
              SET review_result = $2, review_em = now(), review_by = $3,
                  review_queue = false,
                  status = CASE WHEN $4 THEN 'QUALIFYING' ELSE 'NOT_LEAD' END,
                  updated_at = now()
            WHERE id = $1 AND review_queue = true AND review_result IS NULL
            RETURNING id, status`,
          [id, result, req.tenantRole, isLead]
        );
        return r.rows[0] || null;
      });
      if (!updated) return res.status(404).json({ error: 'not in review queue' });

      if (result === 'confirmed_lead') {
        // Processa no funil: gera o rascunho (best-effort; não derruba a confirmação).
        let draft = { ok: false };
        try { draft = await generateDraftForLead(req.tenantId, id); }
        catch (e) { logger.error('tenant.lead.review_draft_error', { tenant_id: req.tenantId, lead_id: id, error: e.message }); }
        logger.info('tenant.lead.review_confirmed', { tenant_id: req.tenantId, lead_id: id, by: req.tenantRole, draft: draft.ok });
        return res.json({ ok: true, result, status: updated.status, draft: draft.ok, approval_id: draft.approvalId || null });
      }
      logger.info('tenant.lead.review_rejected', { tenant_id: req.tenantId, lead_id: id, by: req.tenantRole });
      res.json({ ok: true, result, status: updated.status });
    } catch (err) {
      logger.error('tenant.lead.review_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// ---------------------------------------------------------------------------
// E3 — leads consumidos pela recepção (Scheduler) e pelo painel da unidade.
// ---------------------------------------------------------------------------

// Lista de leads enriquecida: dados do lead + qualificação (instrumento /
// completude) + último contato (max(received_at) da conversa do telefone) +
// flag de aprovação pendente. RLS garante o isolamento por tenant.
router.get(
  '/:tenantId/leads',
  authenticate,
  requireTenantAccess(READ_ROLES),
  async (req, res) => {
    try {
      const result = await withTenant(req.tenantId, async (c) => {
        const leads = (
          await c.query(
            `SELECT l.id, l.name, l.phone, l.status, l.intent,
                    l.created_at, l.updated_at,
                    q.instrument,
                    q.availability,
                    COALESCE(q.qualification_complete, false) AS qualification_complete,
                    (SELECT max(m.received_at)
                       FROM messages m
                       JOIN conversations cv ON cv.id = m.conversation_id
                      WHERE cv.external_id = l.phone) AS last_contact_at,
                    (SELECT cv.channel FROM conversations cv
                      WHERE cv.external_id = l.phone
                      ORDER BY cv.updated_at DESC LIMIT 1) AS channel,
                    EXISTS (SELECT 1 FROM pending_approvals pa
                             WHERE pa.lead_id = l.id AND pa.status = 'PENDING') AS pending_approval
               FROM leads l
               LEFT JOIN lead_qualifications q ON q.lead_id = l.id
              WHERE l.status NOT IN ('NOT_LEAD', 'REVIEW_QUEUE')
              ORDER BY l.created_at DESC
              LIMIT 100`
          )
        ).rows;
        const pendingTotal = (
          await c.query(
            `SELECT count(*)::int AS n FROM pending_approvals WHERE status = 'PENDING'`
          )
        ).rows[0].n;
        // Bloco 2 — contagem da fila de revisão (badge "Para revisar").
        const reviewTotal = (
          await c.query(
            `SELECT count(*)::int AS n FROM leads WHERE review_queue = true AND review_result IS NULL`
          )
        ).rows[0].n;
        return { leads, pendingTotal, reviewTotal };
      });
      res.json({
        tenant_id: req.tenantId,
        role: req.tenantRole,
        impersonation: req.impersonation,
        pending_approvals_count: result.pendingTotal,
        review_queue_count: result.reviewTotal,
        leads: result.leads,
      });
    } catch (err) {
      logger.error('tenant.leads.error', { tenant_id: req.tenantId, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// Detalhe de um lead: dados + qualificação, conversa completa e a aprovação
// pendente mais recente (resposta sugerida pela IA aguardando decisão).
router.get(
  '/:tenantId/leads/:id',
  authenticate,
  requireTenantAccess(READ_ROLES),
  async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
    try {
      const data = await withTenant(req.tenantId, async (c) => {
        const lead = (
          await c.query(
            `SELECT l.id, l.name, l.phone, l.status, l.intent, l.meta_psid,
                    l.created_at, l.updated_at,
                    l.desfecho, l.desfecho_notas, l.desfecho_em,
                    q.name AS qual_name, q.instrument, q.availability,
                    COALESCE(q.qualification_complete, false) AS qualification_complete,
                    q.reasked,
                    (SELECT cv.channel FROM conversations cv
                      WHERE cv.external_id = l.phone
                      ORDER BY cv.updated_at DESC LIMIT 1) AS channel
               FROM leads l
               LEFT JOIN lead_qualifications q ON q.lead_id = l.id
              WHERE l.id = $1`,
            [id]
          )
        ).rows[0];
        if (!lead) return { lead: null };

        const messages = (
          await c.query(
            `SELECT m.id, m.direction, m.role, m.sender, m.body, m.received_at
               FROM messages m
               JOIN conversations cv ON cv.id = m.conversation_id
              WHERE cv.external_id = $1
              ORDER BY m.received_at ASC`,
            [lead.phone]
          )
        ).rows;

        // TIMELINE REAL (C): mescla a conversa que de fato capturamos —
        //  - 'lead'     : mensagens de entrada do lead (messages role USER)
        //  - 'ia'       : mensagens/rascunhos gerados pela IA (messages role ASSISTANT)
        //  - 'recepcao' : respostas REAIS da recepção no WhatsApp/redes (fromMe,
        //                 capturadas em staff_outbound_samples)
        // Casamento por dígitos do external_id (conversations usa "+55..."; o capture
        // de fromMe usa "55..."). Vale pra todos os canais (telefone OU psid).
        const ident = String(lead.phone || lead.meta_psid || '').replace(/\D/g, '');
        const timeline = ident
          ? (
              await c.query(
                `SELECT received_at, kind, sender, body, media_url, media_type, media_filename, media_transcription FROM (
                   -- Entrada do LEAD (USER). Rascunhos da IA (ASSISTANT) NÃO entram na
                   -- conversa: os pendentes pertencem ao bloco "Resposta sugerida".
                   SELECT m.received_at, 'lead' AS kind, m.sender, m.body,
                          m.media_url, m.media_type, m.media_filename, m.media_transcription
                     FROM messages m
                     JOIN conversations cv ON cv.id = m.conversation_id
                    WHERE cv.tenant_id = $1
                      AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = $2
                      AND m.role = 'USER'
                   UNION ALL
                   -- Respostas REAIS da recepção (fromMe). Exclui GRUPOS (@g.us — nunca
                   -- são conversa com o lead) e os textos que a IA já enviou (mostrados
                   -- abaixo como 'ia', pra não duplicar).
                   SELECT s.received_at, 'recepcao' AS kind, s.sender, s.body,
                          NULL AS media_url, NULL AS media_type, NULL AS media_filename, NULL AS media_transcription
                     FROM staff_outbound_samples s
                    WHERE s.tenant_id = $1
                      AND regexp_replace(s.external_id, '[^0-9]', '', 'g') = $2
                      AND coalesce(s.raw->'data'->'key'->>'remoteJid', '') NOT LIKE '%@g.us'
                      AND s.body NOT IN (
                        SELECT pa.suggested_response FROM pending_approvals pa
                         WHERE pa.tenant_id = $1 AND pa.lead_id = $3
                           AND pa.status IN ('APPROVED', 'EDITED')
                           AND pa.suggested_response IS NOT NULL
                      )
                   UNION ALL
                   -- Respostas da IA que foram APROVADAS/ENVIADAS ao cliente (tag "IA").
                   SELECT pa.created_at AS received_at, 'ia' AS kind, NULL AS sender,
                          pa.suggested_response AS body,
                          NULL AS media_url, NULL AS media_type, NULL AS media_filename, NULL AS media_transcription
                     FROM pending_approvals pa
                    WHERE pa.tenant_id = $1 AND pa.lead_id = $3
                      AND pa.status IN ('APPROVED', 'EDITED')
                      AND pa.suggested_response IS NOT NULL
                 ) t
                 ORDER BY received_at ASC`,
                [req.tenantId, ident, id]
              )
            ).rows
          : [];

        const pending = (
          await c.query(
            `SELECT id, suggested_response, status, conversation_id, created_at
               FROM pending_approvals
              WHERE lead_id = $1 AND status = 'PENDING'
              ORDER BY created_at DESC
              LIMIT 1`,
            [id]
          )
        ).rows[0] || null;

        const pendingTotal = (
          await c.query(
            `SELECT count(*)::int AS n FROM pending_approvals WHERE status = 'PENDING'`
          )
        ).rows[0].n;

        return { lead, messages, timeline, pending, pendingTotal };
      });

      if (!data.lead) return res.status(404).json({ error: 'lead not found' });

      // extracted: bloco de dados extraídos pela IA (consumido pela view).
      const l = data.lead;
      res.json({
        tenant_id: req.tenantId,
        role: req.tenantRole,
        pending_approvals_count: data.pendingTotal,
        lead: {
          id: l.id,
          name: l.name,
          phone: l.phone,
          status: l.status,
          intent: l.intent,
          channel: l.channel,
          instrument: l.instrument,
          availability: l.availability,
          qualification_complete: l.qualification_complete,
          created_at: l.created_at,
          updated_at: l.updated_at,
          desfecho: l.desfecho,
          desfecho_notas: l.desfecho_notas,
          desfecho_em: l.desfecho_em,
          extracted: {
            name: l.qual_name,
            instrument: l.instrument,
            availability: l.availability,
          },
        },
        messages: data.messages,
        timeline: data.timeline,
        pending_approval: data.pending,
      });
    } catch (err) {
      logger.error('tenant.lead_detail.error', { tenant_id: req.tenantId, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// Resolve a aprovação pendente mais recente do lead para um status terminal.
// approve: APPROVED (ou EDITED se vier um texto editado != sugerido).
// reject : REJECTED.
async function decidePending(tenantId, leadId, { status, response, decidedBy }) {
  return withTenant(tenantId, async (c) => {
    const pending = (
      await c.query(
        `SELECT id, suggested_response FROM pending_approvals
          WHERE lead_id = $1 AND status = 'PENDING'
          ORDER BY created_at DESC LIMIT 1`,
        [leadId]
      )
    ).rows[0];
    if (!pending) return { notFound: true };

    let finalStatus = status;
    let finalText = pending.suggested_response;
    if (status === 'APPROVED' && response && response !== pending.suggested_response) {
      finalStatus = 'EDITED';
      finalText = response;
    }

    const row = (
      await c.query(
        `UPDATE pending_approvals
            SET status = $2, suggested_response = $3, decided_at = now(), decided_by = $4
          WHERE id = $1
        RETURNING id, status, suggested_response, lead_id, conversation_id, created_at, decided_at`,
        [pending.id, finalStatus, finalText, decidedBy || null]
      )
    ).rows[0];
    return { approval: row };
  });
}

// E4 — Envio HUMAN-IN-THE-LOOP da resposta aprovada ao lead, via Evolution, com a
// credencial DO TENANT. Chamado SÓ no approve (nunca no reject, nunca automático) —
// respeita o guardrail de não-auto-envio: quem decide enviar é a recepcionista.
// Best-effort: devolve { sent, reason?, messageId? } e o chamador trata erro sem
// derrubar o approve (o status da aprovação já está gravado nesse ponto).
async function enviarRespostaAprovada(tenantId, leadId, texto) {
  if (!texto || !texto.trim()) return { sent: false, reason: 'empty_text' };
  // Telefone do lead + credencial Evolution do tenant, na mesma transação (RLS).
  const dados = await withTenant(tenantId, async (c) => {
    const lead = (await c.query('SELECT phone FROM leads WHERE id = $1', [leadId])).rows[0];
    const tnt = (await c.query(
      'SELECT evolution_instance, evolution_token_enc FROM tenants WHERE id = $1', [tenantId]
    )).rows[0];
    return { phone: lead && lead.phone, tnt: tnt || {} };
  });
  if (!dados.phone) return { sent: false, reason: 'no_phone' };
  const instance = dados.tnt.evolution_instance;
  const apikey = decrypt(dados.tnt.evolution_token_enc);
  if (!instance || !apikey) return { sent: false, reason: 'tenant_sem_evolution' };
  // Só envia se a instância estiver conectada (evita gastar a chamada à toa).
  const st = await evolution.status({ instance, apikey });
  if (st.state !== 'open') return { sent: false, reason: 'instancia=' + st.state };
  const res = await evolution.sendText({ instance, apikey }, dados.phone, texto);
  return { sent: true, messageId: evolution.pickMessageId(res) };
}

// POST /tenant/:tid/leads/:id/approve  — body opcional { response }
router.post(
  '/:tenantId/leads/:id/approve',
  authenticate,
  requireTenantAccess(WRITE_ROLES),
  async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
    const response = typeof req.body?.response === 'string' ? req.body.response.trim() : null;
    try {
      const r = await decidePending(req.tenantId, id, { status: 'APPROVED', response, decidedBy: req.tenantRole });
      if (r.notFound) return res.status(404).json({ error: 'no pending approval' });
      // E4 — após gravar o status, envia a resposta aprovada ao lead. Best-effort:
      // falha de envio NÃO derruba o approve (a aprovação já está persistida).
      let envio = { sent: false, reason: 'not_attempted' };
      try {
        envio = await enviarRespostaAprovada(req.tenantId, id, r.approval.suggested_response);
      } catch (sendErr) {
        envio = { sent: false, reason: 'error', error: sendErr.message };
        logger.error('tenant.lead.send_error', { tenant_id: req.tenantId, lead_id: id, error: sendErr.message });
      }
      logger.info('tenant.lead.approved', {
        tenant_id: req.tenantId, lead_id: id,
        approval_id: r.approval.id, status: r.approval.status,
        by: req.tenantRole, sent: envio.sent, send_reason: envio.reason,
      });
      res.json({ ok: true, approval: r.approval, sent: envio.sent, send_reason: envio.reason });
    } catch (err) {
      logger.error('tenant.lead.approve_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// POST /tenant/:tid/leads/:id/improve — melhora um rascunho de resposta com a IA.
// READ-ONLY: não muda status, não envia, não cria nada. Devolve { improved }. Usa o
// system prompt da unidade + o contexto recente da conversa do lead.
router.post(
  '/:tenantId/leads/:id/improve',
  authenticate,
  requireTenantAccess(WRITE_ROLES),
  async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'empty text' });
    try {
      const ctx = await withTenant(req.tenantId, async (c) => {
        const cfg = (
          await c.query(
            `SELECT school_name, system_prompt_override, available_instruments,
                    business_hours, notification_whatsapp
               FROM tenant_lead_config WHERE tenant_id = $1`,
            [req.tenantId]
          )
        ).rows[0];
        const tname = (await c.query('SELECT name FROM tenants WHERE id = $1', [req.tenantId])).rows[0]?.name;
        const lead = (await c.query('SELECT phone, meta_psid FROM leads WHERE id = $1', [id])).rows[0];
        let history = [];
        if (lead) {
          const ext = lead.phone || lead.meta_psid;
          history = (
            await c.query(
              `SELECT m.role, m.body AS content
                 FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
                WHERE cv.tenant_id = $1 AND cv.external_id = $2 AND m.role IS NOT NULL
                ORDER BY m.received_at DESC LIMIT 8`,
              [req.tenantId, ext]
            )
          ).rows.reverse();
        }
        return { config: cfg, tname, history };
      });

      const systemPrompt = resolveSystemPrompt(
        ctx.config || { school_name: ctx.tname || 'Escola', system_prompt_override: null }
      );
      const improved = await gemini.improveReply({ systemPrompt, history: ctx.history, draft: text });
      logger.info('tenant.lead.improved', { tenant_id: req.tenantId, lead_id: id, by: req.tenantRole });
      res.json({ ok: true, improved });
    } catch (err) {
      logger.error('tenant.lead.improve_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// POST /tenant/:tid/leads/:id/reject
router.post(
  '/:tenantId/leads/:id/reject',
  authenticate,
  requireTenantAccess(WRITE_ROLES),
  async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
    try {
      const r = await decidePending(req.tenantId, id, { status: 'REJECTED', decidedBy: req.tenantRole });
      if (r.notFound) return res.status(404).json({ error: 'no pending approval' });
      logger.info('tenant.lead.rejected', {
        tenant_id: req.tenantId, lead_id: id, approval_id: r.approval.id, by: req.tenantRole,
      });
      res.json({ ok: true, approval: r.approval });
    } catch (err) {
      logger.error('tenant.lead.reject_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// ADR-011 Fase 1 — desfechos válidos (mesmo conjunto do CHECK da migration 016).
const DESFECHOS_VALIDOS = [
  'matriculado',
  'nao_matriculado_preco',
  'nao_matriculado_horario',
  'nao_matriculado_concorrente',
  'nao_matriculado_desistiu',
  'nao_compareceu_aula',
  'outro',
];

// POST /tenant/:tid/leads/:id/desfecho — registra o resultado final do lead.
// body { desfecho, notas? }. Auth igual a approve/reject (WRITE_ROLES).
router.post(
  '/:tenantId/leads/:id/desfecho',
  authenticate,
  requireTenantAccess(WRITE_ROLES),
  async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
    const desfecho = typeof req.body?.desfecho === 'string' ? req.body.desfecho.trim() : '';
    if (!DESFECHOS_VALIDOS.includes(desfecho)) {
      return res.status(400).json({ error: 'invalid desfecho' });
    }
    const notas = typeof req.body?.notas === 'string' ? req.body.notas.trim() || null : null;
    try {
      const row = await withTenant(req.tenantId, async (c) => {
        const r = await c.query(
          `UPDATE leads
              SET desfecho = $2, desfecho_notas = $3, desfecho_em = now()
            WHERE id = $1
            RETURNING desfecho, desfecho_notas, desfecho_em`,
          [id, desfecho, notas]
        );
        return r.rows[0] || null;
      });
      if (!row) return res.status(404).json({ error: 'lead not found' });
      logger.info('tenant.lead.desfecho', {
        tenant_id: req.tenantId, lead_id: id, desfecho, by: req.tenantRole,
      });
      res.json({ ok: true, ...row });
    } catch (err) {
      logger.error('tenant.lead.desfecho_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// POST /tenant/:tid/leads/:id/assistant — E1: assistente operacional da recepção DENTRO
// do lead. READ-ONLY (não muda nada, não envia). body { message, history? }. Carrega a
// CONVERSA REAL do lead (timeline mesclada) como contexto pra respostas específicas.
router.post(
  '/:tenantId/leads/:id/assistant',
  authenticate,
  requireTenantAccess(WRITE_ROLES),
  async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'empty message' });
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-12) : [];
    try {
      const ctx = await withTenant(req.tenantId, async (c) => {
        const cfg = (
          await c.query(
            `SELECT school_name, system_prompt_override, available_instruments,
                    business_hours, notification_whatsapp
               FROM tenant_lead_config WHERE tenant_id = $1`,
            [req.tenantId]
          )
        ).rows[0];
        const tname = (await c.query('SELECT name FROM tenants WHERE id = $1', [req.tenantId])).rows[0]?.name;
        const lead = (await c.query('SELECT name, phone, meta_psid FROM leads WHERE id = $1', [id])).rows[0];
        let convo = [];
        if (lead) {
          const ident = String(lead.phone || lead.meta_psid || '').replace(/\D/g, '');
          if (ident) {
            convo = (
              await c.query(
                `SELECT kind, body FROM (
                   SELECT m.received_at,
                          CASE WHEN m.role = 'USER' THEN 'Lead' ELSE 'IA' END AS kind, m.body
                     FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
                    WHERE cv.tenant_id = $1 AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = $2
                   UNION ALL
                   SELECT s.received_at, 'Recepção' AS kind, s.body
                     FROM staff_outbound_samples s
                    WHERE s.tenant_id = $1 AND regexp_replace(s.external_id, '[^0-9]', '', 'g') = $2
                 ) t
                 ORDER BY received_at DESC LIMIT 20`,
                [req.tenantId, ident]
              )
            ).rows.reverse();
          }
        }
        return { config: cfg, tname, leadName: lead?.name, convo };
      });
      const schoolContext = resolveSystemPrompt(
        ctx.config || { school_name: ctx.tname || 'Escola', system_prompt_override: null }
      );
      const leadConversation = ctx.convo.length
        ? ctx.convo.map((m) => `${m.kind}: ${m.body}`).join('\n')
        : null;
      const reply = await gemini.assistantReply({
        schoolContext, leadName: ctx.leadName, leadConversation, history, message,
      });
      logger.info('tenant.assistant.reply', { tenant_id: req.tenantId, lead_id: id, by: req.tenantRole });
      res.json({ ok: true, reply });
    } catch (err) {
      logger.error('tenant.assistant.error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// POST /tenant/:tid/leads/:id/optout — LGPD: marca OPTED_OUT (lead não recebe
// mais nenhuma mensagem). Chamado pelo Scheduler após validar o token do link.
router.post(
  '/:tenantId/leads/:id/optout',
  authenticate,
  requireTenantAccess(WRITE_ROLES),
  async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
    try {
      const r = await withTenant(req.tenantId, (c) =>
        c.query("UPDATE leads SET status = 'OPTED_OUT', updated_at = now() WHERE id = $1 RETURNING id", [id])
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'lead not found' });
      logger.info('tenant.lead.opted_out', { tenant_id: req.tenantId, lead_id: id, by: req.tenantRole });
      res.json({ ok: true });
    } catch (err) {
      logger.error('tenant.lead.optout_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// POST /tenant/:tid/leads/:id/forget — LGPD: direito ao esquecimento.
// Só TENANT_ADMIN (ou PLATFORM_ADMIN por impersonation). Anonimiza PII e apaga
// o conteúdo das mensagens; MANTÉM métricas (status, datas, intent, completude).
router.post(
  '/:tenantId/leads/:id/forget',
  authenticate,
  requireTenantRole(['TENANT_ADMIN']),
  async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
    try {
      const result = await withTenant(req.tenantId, async (c) => {
        const lead = (await c.query('SELECT id, phone FROM leads WHERE id = $1', [id])).rows[0];
        if (!lead) return { notFound: true };
        await anonymizeLead(c, {
          tenantId: req.tenantId, leadId: id, phone: lead.phone,
          actor: req.user?.sub ?? null, action: 'lead.forget',
          details: { role: req.tenantRole, impersonation: !!req.impersonation },
        });
        return { ok: true };
      });
      if (result.notFound) return res.status(404).json({ error: 'lead not found' });
      logger.info('tenant.lead.forgotten', { tenant_id: req.tenantId, lead_id: id, by: req.tenantRole });
      res.json({ ok: true });
    } catch (err) {
      logger.error('tenant.lead.forget_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// Gerenciar membros da unidade — somente TENANT_ADMIN.
router.get(
  '/:tenantId/members',
  authenticate,
  requireTenantRole(['TENANT_ADMIN']),
  async (req, res) => {
    try {
      const members = await withTenant(req.tenantId, (c) =>
        c.query('SELECT user_id, role, created_at FROM tenant_members ORDER BY created_at')
      ).then((r) => r.rows);
      res.json({ tenant_id: req.tenantId, role: req.tenantRole, members });
    } catch (err) {
      logger.error('tenant.members.error', { tenant_id: req.tenantId, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

module.exports = router;
