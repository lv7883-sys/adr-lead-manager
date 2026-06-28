'use strict';

// resources.js — rotas do domínio de recursos (ADR-025/026). Namespace /tenant/:tenantId/resources/*,
// mesma autenticação/escopo de tenant das demais rotas do LM (authenticate + requireTenantAccess →
// req.tenantId; aceita role service). Tudo específico da Extranet fica no ADAPTER (anti-vazamento);
// esta rota só ORQUESTRA: injeta o IO real no readSlot3Weeks do adapter.

const express = require('express');
const { withTenant } = require('../db');
const { authenticate } = require('../auth');
const { requireTenantAccess } = require('../rbac');
const { decrypt } = require('../crypto');
const logger = require('../logger');
const valinhos = require('../resources/adapters/valinhos');
const extranetClient = require('../resources/adapters/extranet-client');
const { withExtranetLock } = require('../resources/extranet-lock');

const router = express.Router();
const READ_ROLES = ['TENANT_ADMIN', 'RECEPCAO', 'VISUALIZADOR'];

// Timeout CURTO do lock p/ consulta de recepção (humano esperando): se a Extranet está sendo
// usada (diária/scheduler), aquela data volta 'indisponivel' (sistema ocupado) em vez de travar.
const LOCK_TIMEOUT_MS = Number(process.env.RESOURCES_LIVE_LOCK_TIMEOUT_MS ?? 9000);
const GRADE_PATH = (d) => `/mod_agenda/api-salas-grade.php?hoje=${encodeURIComponent(d)}&professor=`;

// GET /tenant/:tenantId/resources/ocupacao-ao-vivo?anchor=YYYY-MM-DD&time=HH:MM[&sala=Sala N]
// STREAMING (SSE): um evento 'ocorrencia' por data conforme resolve (regra das 3 semanas) +
// 'completo' no fim. Lê ocupação AO VIVO (não cacheada) e desconta exceção.
router.get('/:tenantId/resources/ocupacao-ao-vivo', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  const anchor = String(req.query.anchor || '');
  const time = String(req.query.time || '');
  const sala = req.query.sala ? String(req.query.sala) : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return res.status(400).json({ error: 'anchor inválido (YYYY-MM-DD)' });
  if (!/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'time inválido (HH:MM)' });

  // SSE
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const sse = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  let closed = false;
  req.on('close', () => { closed = true; });

  try {
    // binding de ocupação ativo do tenant (SCRAPE_EXTRANET) — sob RLS do tenant.
    const binding = (await withTenant(req.tenantId, (c) => c.query(
      `SELECT id, config FROM resources.resource_source_binding
        WHERE status='ACTIVE' AND kind='SCRAPE_EXTRANET' ORDER BY created_at LIMIT 1`))).rows[0];
    if (!binding) { sse('error', { message: 'sem binding de ocupação ativo' }); return res.end(); }

    const cfg = binding.config || {};
    const senha = decrypt(cfg.credential_enc);
    if (!senha) { sse('error', { message: 'credencial indisponível' }); return res.end(); }
    const creds = { email: cfg.email, senha, perfil: cfg.perfil, unidade: cfg.unidade };
    const session = await extranetClient.getSession(creds); // reusa sessão do disco

    // IO injetado no adapter:
    const getGradeHtml = (d) => withExtranetLock(
      () => extranetClient.fetchAuthed(GRADE_PATH(d), session, { noGap: true }), // lock só no GET
      { timeoutMs: LOCK_TIMEOUT_MS });
    const isException = (d) => withTenant(req.tenantId, (c) => c.query(
      `SELECT count(*)::int n FROM resources.resource_exception
         WHERE tenant_id=$1 AND resource_id IS NULL AND $2::date BETWEEN starts_at::date AND ends_at::date`,
      [req.tenantId, d])).then((r) => r.rows[0].n > 0);
    const throttle = () => extranetClient.throttleGap();                  // gap FORA do lock
    const onOccurrence = (occ) => { if (!closed) sse('ocorrencia', occ); }; // streaming por data

    const result = await valinhos.readSlot3Weeks({ anchorDate: anchor, time, sala }, { getGradeHtml, isException, throttle, onOccurrence });

    if (!closed) sse('completo', { anchorDate: result.anchorDate, time: result.time, weekday: result.weekday, sala: result.sala, total: result.occurrences.length });
    res.end();
  } catch (e) {
    logger.error('resources.ocupacao_ao_vivo.error', { tenant_id: req.tenantId, error: e.message });
    try { sse('error', { message: 'falha na consulta de ocupação' }); } catch (_e) { /* já fechado */ }
    res.end();
  }
});

module.exports = router;
