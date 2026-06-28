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
const adapters = require('../resources/adapters');     // registry por kind (anti-vazamento)
const extranetClient = require('../resources/adapters/extranet-client');
const { withExtranetLock } = require('../resources/extranet-lock');
const { isUuid } = require('../validation');

const router = express.Router();
const READ_ROLES = ['TENANT_ADMIN', 'RECEPCAO', 'VISUALIZADOR'];
const WRITE_ROLES = ['TENANT_ADMIN', 'RECEPCAO'];   // VISUALIZADOR não grava

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

// ---------------------------------------------------------------------------
// Tela de atribuição SALA ↔ CAPABILITY (vocação da sala). Modelo de 3 ESTADOS, sem
// migration: ATRIBUIDA (tem vínculo confirmado) > SUGERIDA (sem vínculo, mas o de-para
// da fonte sugere) > EM_BRANCO. O de-para vocação→caps é específico da fonte e vem pelo
// registry de adapters (despacho por kind do binding) — nunca importado direto aqui.
// ---------------------------------------------------------------------------

// Estado da sala a partir das listas já resolvidas.
function estadoSala(atribuidas, sugeridas) {
  if (atribuidas.length > 0) return 'ATRIBUIDA';
  if (sugeridas.length > 0) return 'SUGERIDA';
  return 'EM_BRANCO';
}

// kind do binding ATIVO do tenant (define qual de-para de vocação usar). Sem binding → null
// (suggestRoomCaps cai no default []). Roda no client `c` já dentro do withTenant.
async function kindBindingAtivo(c) {
  const b = (await c.query(
    `SELECT kind FROM resources.resource_source_binding
      WHERE status='ACTIVE' ORDER BY created_at LIMIT 1`)).rows[0];
  return b ? b.kind : null;
}

// GET /tenant/:tenantId/resources/salas — lista as salas (ROOM) com caps atribuídas +
// sugeridas + estado, e o catálogo de capabilities (chips). READ-ONLY.
router.get('/:tenantId/resources/salas', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  try {
    const data = await withTenant(req.tenantId, async (c) => {
      const rooms = (await c.query(
        `SELECT id, external_ref, name, attributes FROM resources.resource
          WHERE type='ROOM' ORDER BY external_ref::int`)).rows;
      const caps = (await c.query(
        `SELECT id, external_ref, name FROM resources.capability`)).rows;
      const roomIds = rooms.map((r) => r.id);
      const links = roomIds.length
        ? (await c.query(
            `SELECT resource_id, capability_id FROM resources.resource_capability
              WHERE resource_id = ANY($1::uuid[])`, [roomIds])).rows
        : [];
      const kind = await kindBindingAtivo(c);
      return { rooms, caps, links, kind };
    });

    // Índices de resolução id→cap e ref→cap (shape estável {id, external_ref, name}).
    const capView = (cp) => ({ id: cp.id, external_ref: cp.external_ref, name: cp.name });
    const capById = new Map(data.caps.map((cp) => [cp.id, cp]));
    const capByRef = new Map(data.caps.map((cp) => [cp.external_ref, cp]));
    const linksByRoom = new Map();
    for (const l of data.links) {
      if (!linksByRoom.has(l.resource_id)) linksByRoom.set(l.resource_id, []);
      linksByRoom.get(l.resource_id).push(l.capability_id);
    }

    const salas = data.rooms.map((room) => {
      const attrs = room.attributes || {};
      const vocacao = attrs.vocacao || null;
      const atribuidas = (linksByRoom.get(room.id) || [])
        .map((capId) => capById.get(capId)).filter(Boolean).map(capView);
      // sugeridas: refs do adapter resolvidas p/ caps do tenant (ignora ref inexistente).
      const sugeridas = adapters.suggestRoomCaps(data.kind, vocacao)
        .map((ref) => capByRef.get(ref)).filter(Boolean).map(capView);
      return {
        id: room.id,
        numero: room.external_ref,
        apelido: attrs.apelido || null,
        vocacao_extranet: vocacao,
        nome: room.name,
        atribuidas,
        sugeridas,
        estado: estadoSala(atribuidas, sugeridas),
      };
    });

    res.json({ salas, capabilities: data.caps.map(capView) });
  } catch (err) {
    logger.error('resources.salas.list.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'falha ao listar salas' });
  }
});

// PUT /tenant/:tenantId/resources/salas/:resourceId/capabilities — substitui (replace) o
// conjunto de capabilities de uma sala. Body { capability_ids: string[] } (vazio = limpa).
router.put('/:tenantId/resources/salas/:resourceId/capabilities', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { resourceId } = req.params;
  if (!isUuid(resourceId)) return res.status(400).json({ error: 'resourceId inválido' });
  const capIds = req.body && req.body.capability_ids;
  if (!Array.isArray(capIds)) return res.status(400).json({ error: 'capability_ids deve ser um array' });
  if (!capIds.every((id) => typeof id === 'string' && isUuid(id))) {
    return res.status(400).json({ error: 'capability_id inválido (esperado UUID)' });
  }
  const uniq = [...new Set(capIds)];

  try {
    const out = await withTenant(req.tenantId, async (c) => {
      // ROOM do tenant (RLS confina). attributes p/ recomputar estado (SUGERIDA).
      const room = (await c.query(
        `SELECT attributes FROM resources.resource WHERE id=$1 AND type='ROOM'`, [resourceId])).rows[0];
      if (!room) return { notFound: true };

      // todas as caps têm de ser do tenant (RLS já filtra → count != length = inválida/alheia).
      if (uniq.length) {
        const { n } = (await c.query(
          `SELECT count(*)::int n FROM resources.capability WHERE id = ANY($1::uuid[])`, [uniq])).rows[0];
        if (n !== uniq.length) return { invalidCap: true };
      }

      // REPLACE: zera e reinsere. tenant_id EXPLÍCITO p/ a RLS WITH CHECK; UNIQUE protege dup.
      await c.query(`DELETE FROM resources.resource_capability WHERE resource_id=$1`, [resourceId]);
      for (const capId of uniq) {
        await c.query(
          `INSERT INTO resources.resource_capability (tenant_id, resource_id, capability_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, resource_id, capability_id) DO NOTHING`,
          [req.tenantId, resourceId, capId]);
      }

      // recomputa atribuidas (do banco) + estado (inclui SUGERIDA via de-para da fonte).
      const atribuidas = (await c.query(
        `SELECT cap.id, cap.external_ref, cap.name
           FROM resources.resource_capability rc
           JOIN resources.capability cap ON cap.id = rc.capability_id
          WHERE rc.resource_id = $1
          ORDER BY cap.external_ref`, [resourceId])).rows;
      const sugeridasRefs = adapters.suggestRoomCaps(await kindBindingAtivo(c), (room.attributes || {}).vocacao || null);
      return { atribuidas, sugeridasCount: sugeridasRefs.length };
    });

    if (out.notFound) return res.status(404).json({ error: 'sala não encontrada (resource ROOM inexistente neste tenant)' });
    if (out.invalidCap) return res.status(400).json({ error: 'capability inválida ou de outro tenant' });

    const estado = out.atribuidas.length > 0 ? 'ATRIBUIDA' : (out.sugeridasCount > 0 ? 'SUGERIDA' : 'EM_BRANCO');
    logger.info('resources.salas.capabilities_set', { tenant_id: req.tenantId, resource_id: resourceId, n: out.atribuidas.length });
    res.json({ atribuidas: out.atribuidas, estado });
  } catch (err) {
    logger.error('resources.salas.put.error', { tenant_id: req.tenantId, resource_id: resourceId, error: err.message });
    res.status(500).json({ error: 'falha ao gravar capabilities da sala' });
  }
});

module.exports = router;
