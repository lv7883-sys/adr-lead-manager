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
const grade = require('../resources/grade');
const { faixasDoDia, fromLegacy } = require('../horario'); // expediente do tenant = agenda recorrente da sala
const { isUuid } = require('../validation');

const router = express.Router();
const READ_ROLES = ['TENANT_ADMIN', 'RECEPCAO', 'VISUALIZADOR'];
const WRITE_ROLES = ['TENANT_ADMIN', 'RECEPCAO'];   // VISUALIZADOR não grava

// Timeout CURTO do lock p/ consulta de recepção (humano esperando): se a Extranet está sendo
// usada (diária/scheduler), aquela data volta 'indisponivel' (sistema ocupado) em vez de travar.
const LOCK_TIMEOUT_MS = Number(process.env.RESOURCES_LIVE_LOCK_TIMEOUT_MS ?? 9000);
const GRADE_PATH = (d) => `/mod_agenda/api-salas-grade.php?hoje=${encodeURIComponent(d)}&professor=`;

// GET /tenant/:tenantId/resources/ocupacao-ao-vivo
//   LEGADO  (1 slot, retrocompat 100%):  ?anchor=YYYY-MM-DD&time=HH:MM[&sala=Sala N]
//   MULTI   (até 3 slots, opt-in):        ?slots=YYYY-MM-DD@HH:MM[@HH:MM],...[&sala=Sala N]
//                          ou 1 slot c/ intervalo: ?anchor=&time=&fim=HH:MM
// STREAMING (SSE): 'ocorrencia' por (slot×data) conforme resolve + 'completo' no fim. O multi
// agrupa slots que colapsam nas mesmas datas (1 GET por data distinta); throttle/lock intactos.
router.get('/:tenantId/resources/ocupacao-ao-vivo', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  // MULTI quando vier ?slots= OU ?fim= (opt-in). Senão, caminho LEGADO 1-slot exato.
  const isMulti = req.query.slots !== undefined || req.query.fim !== undefined;

  // VALIDAÇÃO antes do SSE (não dá pra responder 400 depois do event-stream).
  let parsed = null;
  let anchor = '', time = '';
  if (isMulti) {
    parsed = valinhos.parseSlotsInput(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
  } else {
    anchor = String(req.query.anchor || '');
    time = String(req.query.time || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return res.status(400).json({ error: 'anchor inválido (YYYY-MM-DD)' });
    if (!/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'time inválido (HH:MM)' });
  }
  const sala = req.query.sala ? String(req.query.sala) : null;

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

    // IO injetado no adapter (igual nos dois caminhos):
    const getGradeHtml = (d) => withExtranetLock(
      () => extranetClient.fetchAuthed(GRADE_PATH(d), session, { noGap: true }), // lock só no GET
      { timeoutMs: LOCK_TIMEOUT_MS });
    const isException = (d) => withTenant(req.tenantId, (c) => c.query(
      `SELECT count(*)::int n FROM resources.resource_exception
         WHERE tenant_id=$1 AND resource_id IS NULL AND $2::date BETWEEN starts_at::date AND ends_at::date`,
      [req.tenantId, d])).then((r) => r.rows[0].n > 0);
    const throttle = () => extranetClient.throttleGap();                  // gap FORA do lock
    const onOccurrence = (occ) => { if (!closed) sse('ocorrencia', occ); }; // streaming conforme resolve
    const io = { getGradeHtml, isException, throttle, onOccurrence };

    if (isMulti) {
      const result = await valinhos.readSlotsMulti({ slots: parsed.slots, sala: parsed.sala }, io);
      if (!closed) sse('completo', { slots: result.slots, total: result.occurrences.length });
    } else {
      // Caminho LEGADO preservado byte-a-byte (mesma chamada de antes).
      const result = await valinhos.readSlot3Weeks({ anchorDate: anchor, time, sala }, io);
      if (!closed) sse('completo', { anchorDate: result.anchorDate, time: result.time, weekday: result.weekday, sala: result.sala, total: result.occurrences.length });
    }
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

// ---------------------------------------------------------------------------
// VÃOS LIVRES RECORRENTES por capability — leitura barata de banco (sem Extranet).
// Cruza professores↔salas compatíveis + a disponibilidade recorrente e devolve os
// INTERVALOS contínuos livres [inicio,fim) crus (o front é quem fatia/arrasta).
// ---------------------------------------------------------------------------

// GET /tenant/:tenantId/resources/grade-recorrente?capability=cap:xxx[&professores=id1,id2][&salas=id1,id2]
// capability aceita external_ref OU id. Filtros 'professores'/'salas' (CSV de UUID) RESTRINGEM
// o conjunto compatível; ausentes = todos.
router.get('/:tenantId/resources/grade-recorrente', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  const capParam = String(req.query.capability || '').trim();
  if (!capParam) return res.status(400).json({ error: 'capability obrigatória (external_ref ou id)' });

  const parseIds = (s) => String(s).split(',').map((x) => x.trim()).filter(isUuid);
  const profFilter = req.query.professores !== undefined ? parseIds(req.query.professores) : null;
  const salaFilter = req.query.salas !== undefined ? parseIds(req.query.salas) : null;

  try {
    const out = await withTenant(req.tenantId, async (c) => {
      // a. capability por external_ref OU id (RLS confina ao tenant).
      const cap = (await c.query(
        `SELECT id, external_ref, name FROM resources.capability
          WHERE external_ref = $1 OR id = $2::uuid LIMIT 1`,
        [capParam, isUuid(capParam) ? capParam : null])).rows[0];
      if (!cap) return { notFound: true };

      // b. professores compatíveis (TEACHER com a capability).
      const profsCompat = (await c.query(
        `SELECT r.id, r.name AS nome
           FROM resources.resource r
           JOIN resources.resource_capability rc ON rc.resource_id = r.id
          WHERE r.type='TEACHER' AND rc.capability_id = $1
          ORDER BY r.name`, [cap.id])).rows;

      // c. salas compatíveis (ROOM com a capability — vocação que a tela de atribuição alimenta).
      // A sala NÃO tem agenda própria (a Extranet só dá horário de professor): ela conta livre
      // em todo o expediente. Aqui só importa QUANTAS salas compatíveis há (≥1 = lugar físico).
      const salasCompat = (await c.query(
        `SELECT r.id, r.external_ref AS numero, r.attributes
           FROM resources.resource r
           JOIN resources.resource_capability rc ON rc.resource_id = r.id
          WHERE r.type='ROOM' AND rc.capability_id = $1
          ORDER BY r.external_ref`, [cap.id])).rows;

      // seleção: filtro opcional RESTRINGE; null = todos.
      const profIdsSel = profsCompat.filter((p) => !profFilter || profFilter.includes(p.id)).map((p) => p.id);
      const salaIdsSel = salasCompat.filter((s) => !salaFilter || salaFilter.includes(s.id)).map((s) => s.id);

      // d. disponibilidade recorrente dos PROFESSORES selecionados → {id → [{weekday,start,end}]} (min).
      const profAvail = new Map();
      if (profIdsSel.length) {
        const rows = (await c.query(
          `SELECT resource_id, weekday, start_time, end_time
             FROM resources.resource_availability
            WHERE resource_id = ANY($1::uuid[])
            ORDER BY weekday, start_time`, [profIdsSel])).rows;
        for (const r of rows) {
          if (!profAvail.has(r.resource_id)) profAvail.set(r.resource_id, []);
          profAvail.get(r.resource_id).push({ weekday: r.weekday, start: grade.toMin(r.start_time), end: grade.toMin(r.end_time) });
        }
      }

      // e. OCUPAÇÃO vigente (occupation_history) dos PROFESSORES e SALAS selecionados → desconto.
      // Estado vigente por (resource_id, weekday, slot_time) = registro de MAIOR changed_at
      // (DISTINCT ON ... changed_at DESC). occupied=true → intervalo ocupado [slot_time, slot_end).
      // slot_end NULL (legado pré-050) → fallback [slot_time, slot_time+60min) (some na recaptura).
      // capability_id colapsa: occupied/slot_end são do RECURSO (iguais entre as caps no mesmo slot).
      const ocupByResource = new Map();
      const allSelIds = [...profIdsSel, ...salaIdsSel];
      if (allSelIds.length) {
        const rows = (await c.query(
          `SELECT DISTINCT ON (resource_id, weekday, slot_time)
                  resource_id, weekday,
                  to_char(slot_time,'HH24:MI') AS slot_time, to_char(slot_end,'HH24:MI') AS slot_end, occupied
             FROM resources.occupation_history
            WHERE resource_id = ANY($1::uuid[])
            ORDER BY resource_id, weekday, slot_time, changed_at DESC`, [allSelIds])).rows;
        for (const r of rows) {
          if (!r.occupied) continue; // estado vigente LIVRE → não desconta
          const start = grade.toMin(r.slot_time);
          const end = r.slot_end ? grade.toMin(r.slot_end) : start + 60; // legado NULL → fallback 60min
          if (!(end > start)) continue; // defensivo (slot_end <= slot_time)
          if (!ocupByResource.has(r.resource_id)) ocupByResource.set(r.resource_id, []);
          ocupByResource.get(r.resource_id).push({ weekday: r.weekday, start, end });
        }
      }

      // f. EXPEDIENTE do tenant (horário de atendimento por-dia) = agenda recorrente da sala.
      // Multi-tenant: lê do tenant atual (jsonb novo OU colunas legadas como fallback). Nada hardcoded.
      const hrow = (await c.query(
        `SELECT horario_comercial AS jsonb,
                to_char(horario_comercial_inicio, 'HH24:MI') AS inicio,
                to_char(horario_comercial_fim, 'HH24:MI') AS fim,
                horario_comercial_dias AS dias
           FROM tenants WHERE id = $1`, [req.tenantId])).rows[0] || {};
      const horario = hrow.jsonb || fromLegacy(hrow.inicio, hrow.fim, hrow.dias);

      return { cap, profsCompat, salasCompat, profAvail, ocupByResource, profIdsSel, salaIdsSel, horario };
    });

    if (out.notFound) return res.status(404).json({ error: 'capability não encontrada neste tenant' });

    const profSel = new Set(out.profIdsSel);
    const salaSel = new Set(out.salaIdsSel);
    // Professores: disponibilidade + ocupação vigente (desconto). Salas: lista + ocupação vigente.
    const professoresGrid = out.profIdsSel.map((id) => ({
      id, avail: out.profAvail.get(id) || [], ocup: out.ocupByResource.get(id) || [],
    }));
    const salasGrid = out.salaIdsSel.map((id) => ({ id, ocup: out.ocupByResource.get(id) || [] }));
    // Expediente por weekday (ISO 1=seg..7=dom) em minutos — mesma convenção do resource_availability.
    const expediente = new Map();
    for (let weekday = 1; weekday <= 7; weekday++) {
      const faixas = faixasDoDia(out.horario, weekday).map((f) => ({ start: grade.toMin(f.inicio), end: grade.toMin(f.fim) }));
      if (faixas.length) expediente.set(weekday, faixas);
    }
    const { vaos, janela } = grade.computeVaos(professoresGrid, salasGrid, expediente);

    res.json({
      capability: { id: out.cap.id, external_ref: out.cap.external_ref, name: out.cap.name },
      professores: out.profsCompat.map((p) => ({ id: p.id, nome: p.nome, selecionado: profSel.has(p.id) })),
      salas: out.salasCompat.map((s) => ({
        id: s.id, numero: s.numero, apelido: (s.attributes || {}).apelido || null, selecionado: salaSel.has(s.id),
      })),
      vaos,
      janela,
    });
  } catch (err) {
    logger.error('resources.grade_recorrente.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'falha ao montar a grade recorrente' });
  }
});

module.exports = router;
