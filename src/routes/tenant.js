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
              ORDER BY l.created_at DESC
              LIMIT 100`
          )
        ).rows;
        const pendingTotal = (
          await c.query(
            `SELECT count(*)::int AS n FROM pending_approvals WHERE status = 'PENDING'`
          )
        ).rows[0].n;
        return { leads, pendingTotal };
      });
      res.json({
        tenant_id: req.tenantId,
        role: req.tenantRole,
        impersonation: req.impersonation,
        pending_approvals_count: result.pendingTotal,
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
            `SELECT l.id, l.name, l.phone, l.status, l.intent,
                    l.created_at, l.updated_at,
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

        return { lead, messages, pending, pendingTotal };
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
          extracted: {
            name: l.qual_name,
            instrument: l.instrument,
            availability: l.availability,
          },
        },
        messages: data.messages,
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
async function decidePending(tenantId, leadId, { status, response }) {
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
            SET status = $2, suggested_response = $3
          WHERE id = $1
        RETURNING id, status, suggested_response, lead_id, conversation_id, created_at`,
        [pending.id, finalStatus, finalText]
      )
    ).rows[0];
    return { approval: row };
  });
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
      const r = await decidePending(req.tenantId, id, { status: 'APPROVED', response });
      if (r.notFound) return res.status(404).json({ error: 'no pending approval' });
      logger.info('tenant.lead.approved', {
        tenant_id: req.tenantId, lead_id: id,
        approval_id: r.approval.id, status: r.approval.status,
        by: req.tenantRole,
      });
      res.json({ ok: true, approval: r.approval });
    } catch (err) {
      logger.error('tenant.lead.approve_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
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
      const r = await decidePending(req.tenantId, id, { status: 'REJECTED' });
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
