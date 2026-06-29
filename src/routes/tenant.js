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
const { fromLegacy, canonicaliza, validaHorarioJson, normaliza, minToHm } = require('../horario'); // H1: horário por-dia
const logger = require('../logger');
const evolution = require('../evolution');   // E4: envio direto via Evolution
const meta = require('../meta');              // E6: envio outbound via Messenger/IG
const { decrypt } = require('../crypto');     // E4: token Evolution do tenant
const gemini = require('../gemini');          // D: melhorar resposta com IA
const { resolveSystemPrompt } = require('../templates');
const { computeMetrics, computeFunil, computePainel, computeKanban, kanbanColuna, KANBAN_TRANSICOES, PERDIDO_DESFECHOS, PERIODS, classificarEngajamento } = require('../metrics');   // G: dashboard de gestão
const { generateDraftForLead } = require('../engine');   // Bloco 2: rascunho ao confirmar lead
const { notificarRecepcao } = require('../notificacao'); // ADR-006: warning de mudança de automação
const redisClient = require('../redisClient');           // PARTE 3: cache 24h da sugestão
const multer = require('multer');                        // ADR-016 P1: upload de mídia
const mediaLib = require('../media');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Motivos de "não é lead" — fallback usado quando o tenant não configurou
// `tenant_lead_config.nao_lead_motivos` (migration 035). Tópicos, nunca identidade.
// O motivo escolhido vira rótulo em classification_feedback.correction_context.
const DEFAULT_NAO_LEAD_MOTIVOS = [
  { value: 'renovacao_cobranca', label: 'Renovação / cobrança' },
  { value: 'remarcacao_agenda', label: 'Remarcação / reposição / agenda' },
  { value: 'aviso_ausencia', label: 'Aviso de ausência' },
  { value: 'assunto_interno', label: 'Assunto interno' },
  { value: 'fornecedor', label: 'Fornecedor' },
  { value: 'sem_intencao_matricula', label: 'Sem intenção de matrícula' },
  { value: 'spam', label: 'Spam' },
];

// Lê os motivos do tenant (config) com fallback pro default. Roda dentro de um client `c`.
async function _naoLeadMotivos(c, tenantId) {
  try {
    const r = await c.query('SELECT nao_lead_motivos FROM tenant_lead_config WHERE tenant_id = $1', [tenantId]);
    const m = r.rows[0] && r.rows[0].nao_lead_motivos;
    return Array.isArray(m) && m.length ? m : DEFAULT_NAO_LEAD_MOTIVOS;
  } catch { return DEFAULT_NAO_LEAD_MOTIVOS; }
}

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

// Início do dia de hoje em America/Sao_Paulo (expressão SQL). Igual ao metrics.js.
const SP_HOJE = `date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`;

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

// GET /tenant/:tid/leads/kanban?period=30d|90d — ADR-010: leads agrupados por coluna
// do ciclo de vida (novo/qualificando/qualificado/convertido/perdido). READ-ONLY.
router.get('/:tenantId/leads/kanban', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  const period = ['30d', '90d'].includes(String(req.query.period)) ? String(req.query.period) : '30d';
  try {
    res.json(await computeKanban(req.tenantId, { period }));
  } catch (err) {
    logger.error('tenant.kanban.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// PUT /tenant/:tid/leads/:id/mover-kanban — body { destino, desfecho? }. Valida a
// transição e atualiza status/desfecho (PERDIDO preserva o status — só grava desfecho).
const _KANBAN_DEST_COL = { QUALIFYING: 'qualificando', QUALIFIED: 'qualificado', EXPERIMENTAL_AGENDADA: 'experimental', CONVERTED: 'convertido', PERDIDO: 'perdido' };
// stages.js (dashboard) manda `destino` como STATUS; o inverso (key da coluna → status)
// é usado quando o destino já vem como key da etapa (ex.: confirmar sugestão da IA).
const _COL_TO_STATUS = Object.fromEntries(Object.entries(_KANBAN_DEST_COL).map(([s, k]) => [k, s]));

// Move um lead pela mesma lógica do drag/dropdown — FONTE ÚNICA de movimentação de etapa
// (mover-kanban E confirmação de sugestão da IA caem aqui). Roda dentro de uma transação
// `withTenant` (recebe o client `c`). `conteudoEtapa` permite sobrescrever a descrição do
// evento (ex.: "sugestão da IA confirmada"). Retorna {row, origem} | {notFound} | {invalid}.
async function _aplicarMoverEtapa(c, { tenantId, id, destCol, desfecho, autor, nota, conteudoEtapa, limparSugestao }) {
  const lead = (await c.query('SELECT status, desfecho FROM leads WHERE id = $1', [id])).rows[0];
  if (!lead) return { notFound: true };
  const origem = kanbanColuna(lead.status, lead.desfecho);
  if (!(KANBAN_TRANSICOES[origem] || []).includes(destCol)) return { invalid: true, origem };
  let r;
  // Destinos NÃO-terminais limpam o desfecho (e desfecho_em): reativar um lead
  // convertido/perdido tem de tirar o 'matriculado'/desfecho de perda, senão
  // kanbanColuna() re-deriva a coluna terminal e o card "volta" sozinho.
  if (destCol === 'qualificando') r = await c.query("UPDATE leads SET status='QUALIFYING', desfecho=NULL, desfecho_em=NULL, updated_at=now() WHERE id=$1 RETURNING status, desfecho", [id]);
  else if (destCol === 'qualificado') r = await c.query("UPDATE leads SET status='QUALIFIED', desfecho=NULL, desfecho_em=NULL, updated_at=now() WHERE id=$1 RETURNING status, desfecho", [id]);
  else if (destCol === 'experimental') r = await c.query("UPDATE leads SET status='EXPERIMENTAL_AGENDADA', desfecho=NULL, desfecho_em=NULL, updated_at=now() WHERE id=$1 RETURNING status, desfecho", [id]);
  else if (destCol === 'convertido') r = await c.query("UPDATE leads SET status='CONVERTED', desfecho='matriculado', desfecho_em=now(), updated_at=now() WHERE id=$1 RETURNING status, desfecho", [id]);
  else r = await c.query('UPDATE leads SET desfecho=$2, desfecho_em=now(), updated_at=now() WHERE id=$1 RETURNING status, desfecho', [id, desfecho]);
  // HISTÓRICO: registra a mudança de etapa (drag E dropdown caem aqui). Reativação
  // (terminal→não-terminal) guarda o desfecho ANTERIOR — limpar não é perda de dado.
  if (origem !== destCol || conteudoEtapa) {
    const conteudo = conteudoEtapa || (['convertido', 'perdido'].includes(origem)
      ? `reativado de ${origem}${lead.desfecho ? ` [${lead.desfecho}]` : ''} → ${destCol}`
      : (destCol === 'perdido' ? `${origem} → perdido [${desfecho}]` : `${origem} → ${destCol}`));
    await c.query(
      `INSERT INTO lead_eventos (tenant_id, lead_id, tipo, autor, conteudo, etapa_key)
       VALUES ($1, $2, 'mudanca_etapa', $3, $4, $5)`,
      [tenantId, id, autor || null, conteudo, destCol]
    );
  }
  // Anotação opcional junto da mudança (o botão "Registrar" pode mandar as duas).
  if (nota) {
    await c.query(
      `INSERT INTO lead_eventos (tenant_id, lead_id, tipo, autor, conteudo) VALUES ($1, $2, 'nota', $3, $4)`,
      [tenantId, id, autor || null, nota]
    );
  }
  // Mover (por qualquer via) zera a sugestão de etapa pendente — ela já foi resolvida.
  if (limparSugestao) {
    await c.query(
      'UPDATE leads SET suggested_stage = NULL, stage_reasoning = NULL, stage_suggested_at = NULL WHERE id = $1', [id]);
  }
  return { row: r.rows[0], origem };
}

router.put('/:tenantId/leads/:id/mover-kanban', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
  const destCol = _KANBAN_DEST_COL[String(req.body?.destino || '').trim()];
  if (!destCol) return res.status(400).json({ error: 'destino inválido' });
  const desfecho = typeof req.body?.desfecho === 'string' ? req.body.desfecho.trim() : '';
  if (destCol === 'perdido' && !PERDIDO_DESFECHOS.includes(desfecho)) {
    return res.status(400).json({ error: 'desfecho de perda inválido' });
  }
  const nota = typeof req.body?.nota === 'string' ? req.body.nota.trim().slice(0, 2000) : '';
  try {
    const out = await withTenant(req.tenantId, (c) => _aplicarMoverEtapa(c, {
      tenantId: req.tenantId, id, destCol, desfecho, autor: req.tenantRole, nota, limparSugestao: true,
    }));
    if (out.notFound) return res.status(404).json({ error: 'lead not found' });
    if (out.invalid) return res.status(409).json({ error: `transição inválida (${out.origem} → ${destCol})` });
    logger.info('tenant.lead.kanban_movido', { tenant_id: req.tenantId, lead_id: id, origem: out.origem, destino: destCol, by: req.tenantRole });
    res.json({ ok: true, coluna: destCol, ...out.row });
  } catch (err) {
    logger.error('tenant.lead.kanban_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// ADR sugestão-de-etapa — CONFIRMAR a sugestão da IA (1-clique): move pela MESMA lógica
// do drag (_aplicarMoverEtapa) e loga em lead_eventos como confirmação da IA. O destino é
// a suggested_stage gravada no lead (não vem do body — o cliente só confirma). 'perdido'
// nunca é sugerido, então a confirmação não precisa de desfecho/motivo.
router.post('/:tenantId/leads/:id/sugestao-etapa/confirmar', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
  try {
    const out = await withTenant(req.tenantId, async (c) => {
      const lead = (await c.query('SELECT suggested_stage FROM leads WHERE id = $1', [id])).rows[0];
      if (!lead) return { notFound: true };
      const destCol = lead.suggested_stage;
      if (!destCol || !_COL_TO_STATUS[destCol]) return { semSugestao: true };
      const conteudo = `movido para ${destCol} — sugestão da IA confirmada${req.tenantRole ? ` por ${req.tenantRole}` : ''}`;
      const r = await _aplicarMoverEtapa(c, {
        tenantId: req.tenantId, id, destCol, autor: req.tenantRole, conteudoEtapa: conteudo, limparSugestao: true,
      });
      return { ...r, destCol };
    });
    if (out.notFound) return res.status(404).json({ error: 'lead not found' });
    if (out.semSugestao) return res.status(409).json({ error: 'sem sugestão de etapa pendente' });
    if (out.invalid) return res.status(409).json({ error: `transição inválida (${out.origem} → ${out.destCol})` });
    logger.info('tenant.lead.sugestao_confirmada', { tenant_id: req.tenantId, lead_id: id, destino: out.destCol, by: req.tenantRole });
    res.json({ ok: true, coluna: out.destCol, ...out.row });
  } catch (err) {
    logger.error('tenant.lead.sugestao_confirmar_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// ADR sugestão-de-etapa — DISPENSAR a sugestão: limpa a sugestão e registra a etapa
// dispensada (suggested_stage_dismissed) para o detector NÃO re-sugerir o mesmo evento.
// Loga uma nota (rótulo negativo) na timeline. NÃO move o lead.
router.post('/:tenantId/leads/:id/sugestao-etapa/dispensar', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
  try {
    const out = await withTenant(req.tenantId, async (c) => {
      const lead = (await c.query('SELECT suggested_stage FROM leads WHERE id = $1', [id])).rows[0];
      if (!lead) return { notFound: true };
      const dispensada = lead.suggested_stage;
      await c.query(
        `UPDATE leads SET suggested_stage = NULL, stage_reasoning = NULL, stage_suggested_at = NULL,
                          suggested_stage_dismissed = COALESCE($2, suggested_stage_dismissed) WHERE id = $1`,
        [id, dispensada || null]
      );
      if (dispensada) {
        await c.query(
          `INSERT INTO lead_eventos (tenant_id, lead_id, tipo, autor, conteudo)
           VALUES ($1, $2, 'nota', $3, $4)`,
          [req.tenantId, id, req.tenantRole || null, `sugestão de etapa dispensada (${dispensada})`]
        );
      }
      return { ok: true, dispensada };
    });
    if (out.notFound) return res.status(404).json({ error: 'lead not found' });
    logger.info('tenant.lead.sugestao_dispensada', { tenant_id: req.tenantId, lead_id: id, etapa: out.dispensada, by: req.tenantRole });
    res.json({ ok: true });
  } catch (err) {
    logger.error('tenant.lead.sugestao_dispensar_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /tenant/:tid/leads/:id/eventos — timeline do lead (mudança de etapa + notas).
router.get('/:tenantId/leads/:id/eventos', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
  try {
    const eventos = await withTenant(req.tenantId, (c) => c.query(
      `SELECT id, tipo, autor, conteudo, etapa_key, created_at
         FROM lead_eventos WHERE tenant_id = $1 AND lead_id = $2
        ORDER BY created_at DESC LIMIT 200`, [req.tenantId, id]).then((r) => r.rows));
    res.json({ ok: true, eventos });
  } catch (err) {
    logger.error('tenant.lead.eventos_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /tenant/:tid/leads/:id/nota — anotação avulsa (sem mudar etapa). Append-only.
router.post('/:tenantId/leads/:id/nota', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
  const nota = typeof req.body?.nota === 'string' ? req.body.nota.trim().slice(0, 2000) : '';
  if (!nota) return res.status(400).json({ error: 'nota vazia' });
  try {
    const ok = await withTenant(req.tenantId, async (c) => {
      if ((await c.query('SELECT 1 FROM leads WHERE id = $1', [id])).rowCount === 0) return false;
      await c.query(
        `INSERT INTO lead_eventos (tenant_id, lead_id, tipo, autor, conteudo) VALUES ($1, $2, 'nota', $3, $4)`,
        [req.tenantId, id, req.tenantRole || null, nota]);
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'lead not found' });
    res.json({ ok: true });
  } catch (err) {
    logger.error('tenant.lead.nota_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /tenant/:tid/review-queue — Bloco 2: mensagens aguardando revisão humana
// (review_queue=true, ainda não decididas). READ-ONLY.
router.get(
  '/:tenantId/review-queue',
  authenticate,
  requireTenantAccess(READ_ROLES),
  async (req, res) => {
    try {
      const { leads, motivos } = await withTenant(req.tenantId, async (c) => ({
        motivos: await _naoLeadMotivos(c, req.tenantId),
        leads: (
        await c.query(
          `SELECT l.id, l.name, l.phone, l.meta_psid, l.status, l.intent,
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
            WHERE l.review_queue = true AND l.review_result IS NULL AND l.status = 'REVIEW_QUEUE'
            ORDER BY l.classification_confidence DESC NULLS LAST, l.created_at DESC
            LIMIT 200`,
          [req.tenantId]
        )
      ).rows,
      }));
      res.json({ tenant_id: req.tenantId, count: leads.length, leads, motivos });
    } catch (err) {
      logger.error('tenant.review_queue.error', { tenant_id: req.tenantId, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// GET /tenant/:tid/unclassified — ADR-019: rede de resgate. POR-CONTATO: só leads
// NOT_LEAD auto-descartados (<0.40, ainda não resolvidos) = 1 linha por lead. A parte
// "mensagens de contatos internos descartadas" foi removida (era 1 linha por MENSAGEM,
// inflava o contato — ex.: Daniele 40×). O Gate 0 segue descartando internos; as msgs
// históricas continuam no banco, só deixam de ser listadas aqui.
const _IDENT = "regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')";
router.get('/:tenantId/unclassified', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  try {
    const { items, motivos } = await withTenant(req.tenantId, async (c) => ({
      motivos: await _naoLeadMotivos(c, req.tenantId),
      items: (
      await c.query(
        `SELECT 'lead' AS kind, l.id::text AS id, coalesce(l.phone, l.meta_psid) AS phone, l.name,
                 l.classification_confidence AS confidence, 'low_confidence' AS reason,
                 l.classification_reasoning AS reasoning, l.intent,
                 l.conversation_state, l.state_reasoning,
                 CASE WHEN l.review_result = 'confirmed_not_lead' THEN 'recepcao' ELSE 'ia' END AS origem_descarte,
                 (SELECT min(m.received_at) FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
                   WHERE cv.tenant_id = $1 AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = ${_IDENT} AND m.role = 'USER') AS received_at,
                 (SELECT m.body FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
                   WHERE cv.tenant_id = $1 AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = ${_IDENT} AND m.role = 'USER'
                   ORDER BY m.received_at ASC LIMIT 1) AS first_message,
                 (SELECT cv.channel FROM conversations cv
                   WHERE cv.tenant_id = $1 AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = ${_IDENT}
                   ORDER BY cv.updated_at DESC LIMIT 1) AS channel
            FROM leads l
           -- Descartados = CASA DE RESGATE: tudo fora do funil como NOT_LEAD que dá pra
           -- recuperar — descartado pela IA (review_result NULL) OU marcado "não é lead"
           -- pela recepção (confirmed_not_lead). Exclui desfecho (decisão de resultado).
           WHERE l.status = 'NOT_LEAD' AND l.desfecho IS NULL
             AND (l.review_result IS NULL OR l.review_result = 'confirmed_not_lead')
         ORDER BY coalesce(l.review_em, l.created_at) DESC NULLS LAST
         LIMIT 100`,
        [req.tenantId]
      )
    ).rows,
    }));
    res.json({ tenant_id: req.tenantId, count: items.length, items, motivos });
  } catch (err) {
    logger.error('tenant.unclassified.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// Helpers de resolução de item não classificado (lead | message).
async function _msgInfo(c, msgId) {
  return (await c.query(
    `SELECT m.id, m.body, m.sender, cv.external_id, cv.channel
       FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE m.id = $1`, [msgId]
  )).rows[0] || null;
}

// POST /tenant/:tid/unclassified/:id/promote — vira lead + processa + feedback 'lead'.
router.post('/:tenantId/unclassified/:id/promote', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { id } = req.params;
  const kind = req.body?.kind;
  if (!isUuid(id) || (kind !== 'lead' && kind !== 'message')) return res.status(400).json({ error: 'invalid' });
  // Temperatura opcional (passo secundário do controle "é lead" compartilhado).
  const temperature = ['quente', 'morno', 'frio'].includes(req.body?.temperature) ? req.body.temperature : null;
  try {
    const leadId = await withTenant(req.tenantId, async (c) => {
      if (kind === 'lead') {
        const r = await c.query(
          `UPDATE leads SET status = 'QUALIFYING', review_queue = false,
                            review_result = 'confirmed_lead', review_em = now(), review_by = $3,
                            temperatura_manual = COALESCE($2, temperatura_manual), updated_at = now()
            WHERE id = $1 RETURNING id`, [id, temperature, req.tenantRole]
        );
        if (!r.rows[0]) return null;
        await _registrarFeedback(c, req.tenantId, id, 'lead', req.tenantRole, { temperature });
        return id;
      }
      const m = await _msgInfo(c, id);
      if (!m) return null;
      const lead = await c.query(
        `INSERT INTO leads (tenant_id, name, phone, status, temperatura_manual) VALUES ($1, $2, $3, 'QUALIFYING', $4)
         ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL
         DO UPDATE SET status = 'QUALIFYING', temperatura_manual = COALESCE(EXCLUDED.temperatura_manual, leads.temperatura_manual), updated_at = now()
         RETURNING id`,
        [req.tenantId, m.sender || m.external_id, m.external_id, temperature]
      );
      await c.query("UPDATE messages SET discarded = false, discard_reason = 'promoted' WHERE id = $1", [id]);
      await _registrarFeedback(c, req.tenantId, lead.rows[0].id, 'lead', req.tenantRole, { temperature });
      return lead.rows[0].id;
    });
    if (!leadId) return res.status(404).json({ error: 'not found' });
    let draft = { ok: false };
    try { draft = await generateDraftForLead(req.tenantId, leadId); }
    catch (e) { logger.error('tenant.unclassified.promote_draft_error', { tenant_id: req.tenantId, error: e.message }); }
    logger.info('tenant.unclassified.promoted', { tenant_id: req.tenantId, kind, id, lead_id: leadId, draft: draft.ok });
    res.json({ ok: true, lead_id: leadId, draft: draft.ok });
  } catch (err) {
    logger.error('tenant.unclassified.promote_error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /tenant/:tid/unclassified/:id/ignore — marca resolvido (some da lista).
router.post('/:tenantId/unclassified/:id/ignore', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { id } = req.params;
  const kind = req.body?.kind;
  if (!isUuid(id) || (kind !== 'lead' && kind !== 'message')) return res.status(400).json({ error: 'invalid' });
  // Motivo (tópico ou texto livre) — vira rótulo content-based no classification_feedback,
  // mesmo caminho da Revisar. Mantém o lead fora do funil.
  const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.trim().slice(0, 200) || null : null;
  try {
    const ok = await withTenant(req.tenantId, async (c) => {
      if (kind === 'lead') {
        const r = await c.query("UPDATE leads SET review_result = 'confirmed_not_lead', review_em = now(), review_by = $2 WHERE id = $1 RETURNING id", [id, req.tenantRole]);
        if (!r.rows[0]) return false;
        await _registrarFeedback(c, req.tenantId, id, 'not_lead', req.tenantRole, { context: motivo });
        return true;
      }
      const r = await c.query("UPDATE messages SET discard_reason = 'ignored' WHERE id = $1 AND discarded = true RETURNING id", [id]);
      return !!r.rows[0];
    });
    if (!ok) return res.status(404).json({ error: 'not found' });
    logger.info('tenant.unclassified.ignored', { tenant_id: req.tenantId, kind, id, by: req.tenantRole });
    res.json({ ok: true });
  } catch (err) {
    logger.error('tenant.unclassified.ignore_error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /tenant/:tid/unclassified/:id/marcar-interno — adiciona a internal_contacts + resolve.
router.post('/:tenantId/unclassified/:id/marcar-interno', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { id } = req.params;
  const kind = req.body?.kind;
  if (!isUuid(id) || (kind !== 'lead' && kind !== 'message')) return res.status(400).json({ error: 'invalid' });
  const TIPOS = ['gestor', 'recepcionista', 'professor', 'funcionario', 'parceiro', 'outro'];
  const type = TIPOS.includes(req.body?.type) ? req.body.type : 'outro';
  const nome = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : null;
  try {
    const ok = await withTenant(req.tenantId, async (c) => {
      let phone = null, defName = nome;
      if (kind === 'lead') {
        const l = (await c.query('SELECT phone, name FROM leads WHERE id = $1', [id])).rows[0];
        if (!l || !l.phone) return false;
        phone = l.phone; defName = defName || l.name;
        await c.query("UPDATE leads SET status = 'NOT_LEAD', review_result = 'confirmed_not_lead', review_em = now(), review_by = $2 WHERE id = $1", [id, req.tenantRole]);
      } else {
        const m = await _msgInfo(c, id);
        if (!m || !m.external_id) return false;
        phone = m.external_id; defName = defName || m.sender;
        await c.query("UPDATE messages SET discard_reason = 'internal_resolved' WHERE id = $1", [id]);
      }
      await c.query(
        `INSERT INTO internal_contacts (tenant_id, phone, name, type) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, phone) DO NOTHING`,
        [req.tenantId, phone, defName || 'Contato interno', type]
      );
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'not found' });
    logger.info('tenant.unclassified.marcado_interno', { tenant_id: req.tenantId, kind, id, type, by: req.tenantRole });
    res.json({ ok: true });
  } catch (err) {
    logger.error('tenant.unclassified.marcar_interno_error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

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
    // Decisão da Revisar agora carrega o passo secundário: É LEAD → temperatura;
    // NÃO É LEAD → motivo (tópico ou texto livre). Ambos opcionais e não-quebram
    // o uso atual (botões sem esses campos seguem funcionando).
    const temperature = ['quente', 'morno', 'frio'].includes(req.body?.temperature) ? req.body.temperature : null;
    const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.trim().slice(0, 200) || null : null;
    try {
      const updated = await withTenant(req.tenantId, async (c) => {
        const isLead = result === 'confirmed_lead';
        const r = await c.query(
          `UPDATE leads
              SET review_result = $2, review_em = now(), review_by = $3,
                  review_queue = false,
                  status = CASE WHEN $4 THEN 'QUALIFYING' ELSE 'NOT_LEAD' END,
                  temperatura_manual = CASE WHEN $4 AND $5::text IS NOT NULL THEN $5 ELSE temperatura_manual END,
                  updated_at = now()
            WHERE id = $1 AND review_queue = true AND review_result IS NULL
            RETURNING id, status`,
          [id, result, req.tenantRole, isLead, temperature]
        );
        // Feedback de aprendizado (ADR-011 Fase 2): a decisão real da recepção. Mesmo
        // motor de rótulo do requalificar — motivo → correction_context (tópico que a
        // IA aprende), temperatura → corrected_temperature.
        if (r.rows[0]) {
          await _registrarFeedback(c, req.tenantId, id, isLead ? 'lead' : 'not_lead', req.tenantRole,
            { context: isLead ? null : motivo, temperature: isLead ? temperature : null });
        }
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
            `SELECT l.id, l.name, l.phone, l.status, l.intent, l.temperatura_manual,
                    l.created_at, l.updated_at,
                    l.suggested_stage, l.stage_reasoning, l.stage_suggested_at,
                    q.instrument,
                    q.availability,
                    COALESCE(q.qualification_complete, false) AS qualification_complete,
                    (SELECT max(m.received_at)
                       FROM messages m
                       JOIN conversations cv ON cv.id = m.conversation_id
                      WHERE cv.external_id = l.phone) AS last_contact_at,
                    -- item B: última mensagem recebida DO lead (role USER).
                    (SELECT max(m.received_at)
                       FROM messages m
                       JOIN conversations cv ON cv.id = m.conversation_id
                      WHERE cv.external_id = l.phone AND m.role = 'USER') AS ultimo_contato_lead,
                    (SELECT cv.channel FROM conversations cv
                      WHERE regexp_replace(cv.external_id, '[^0-9]', '', 'g')
                          = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
                      ORDER BY cv.updated_at DESC LIMIT 1) AS channel,
                    EXISTS (SELECT 1 FROM pending_approvals pa
                             WHERE pa.lead_id = l.id AND pa.status = 'PENDING') AS pending_approval,
                    -- ADR / Parte 5: flags p/ os filtros dos cards de indicadores.
                    -- Mesmas fontes do painel (staff_outbound_samples, pending_approvals).
                    EXISTS (SELECT 1 FROM staff_outbound_samples s
                             WHERE regexp_replace(s.external_id, '[^0-9]', '', 'g')
                                 = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
                               AND s.received_at >= ${SP_HOJE}) AS responded_today,
                    EXISTS (SELECT 1 FROM pending_approvals pa
                             WHERE pa.lead_id = l.id AND pa.status = 'APPROVED' AND pa.decided_at >= ${SP_HOJE}) AS approved_today,
                    EXISTS (SELECT 1 FROM pending_approvals pa
                             WHERE pa.lead_id = l.id AND pa.status = 'EDITED' AND pa.decided_at >= ${SP_HOJE}) AS edited_today,
                    -- D1 — "aguardando resposta" = conversation_state AGUARDANDO_RECEPCAO
                    -- (independe de termos mandado msg: resposta-promessa NÃO encerra).
                    -- Fallback p/ a heurística de timestamps quando o estado é NULL (não
                    -- esconder quem espera). Fora: EXPERIMENTAL_AGENDADA, CONVERTED, desfecho.
                    (l.status <> 'EXPERIMENTAL_AGENDADA' AND l.status <> 'CONVERTED' AND l.desfecho IS NULL AND (
                      l.conversation_state = 'AGUARDANDO_RECEPCAO'
                      OR (l.conversation_state IS NULL AND
                          (SELECT max(m.received_at) FROM messages m
                             JOIN conversations cv ON cv.id = m.conversation_id
                            WHERE cv.external_id = l.phone AND m.role = 'USER')
                          > COALESCE((SELECT max(s.received_at) FROM staff_outbound_samples s
                             WHERE regexp_replace(s.external_id, '[^0-9]', '', 'g')
                                 = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')), 'epoch'::timestamptz))
                    )) AS awaiting_reply,
                    -- P5: sequências de msgs p/ classificar o engajamento do cliente.
                    (SELECT array_agg(EXTRACT(EPOCH FROM m.received_at) ORDER BY m.received_at)
                       FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
                      WHERE cv.external_id = l.phone AND m.role = 'USER') AS ts_in,
                    (SELECT array_agg(EXTRACT(EPOCH FROM s.received_at) ORDER BY s.received_at)
                       FROM staff_outbound_samples s
                      WHERE regexp_replace(s.external_id, '[^0-9]', '', 'g')
                          = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')) AS ts_out
               FROM leads l
               LEFT JOIN lead_qualifications q ON q.lead_id = l.id
              WHERE l.status NOT IN ('NOT_LEAD', 'REVIEW_QUEUE')
              ORDER BY l.created_at DESC
              LIMIT 1000`
          )
        ).rows;
        // P5 — classifica engajamento do cliente por lead (e remove os arrays crus).
        const nowSec = Date.now() / 1000;
        for (const l of leads) {
          const e = classificarEngajamento(l.ts_in, l.ts_out, nowSec);
          l.engajamento = e.engajamento;
          l.tempo_medio_resposta_cliente_seg = e.tempo_medio_resposta_cliente_seg;
          delete l.ts_in; delete l.ts_out;
        }
        const pendingTotal = (
          await c.query(
            `SELECT count(*)::int AS n FROM pending_approvals WHERE status = 'PENDING'`
          )
        ).rows[0].n;
        // Bloco 2 — contagem da fila de revisão (badge "Para revisar").
        const reviewTotal = (
          await c.query(
            `SELECT count(*)::int AS n FROM leads WHERE review_queue = true AND review_result IS NULL AND status = 'REVIEW_QUEUE'`
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
            `SELECT l.id, l.name, l.phone, l.status, l.intent, l.meta_psid, l.temperatura_manual,
                    l.created_at, l.updated_at,
                    l.desfecho, l.desfecho_notas, l.desfecho_em, l.desfecho_source, l.desfecho_motivo,
                    l.suggested_stage, l.stage_reasoning, l.stage_suggested_at,
                    q.name AS qual_name, q.instrument, q.availability,
                    COALESCE(q.qualification_complete, false) AS qualification_complete,
                    q.reasked,
                    (SELECT cv.channel FROM conversations cv
                      WHERE regexp_replace(cv.external_id, '[^0-9]', '', 'g')
                          = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
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
        // Cada linha expõe `id` (id interno da própria linha) e, quando cita outra
        // mensagem, `reply_to_id` (FK -> messages.id). O LEFT JOIN `rt` resolve a
        // citada (sempre uma linha de messages) p/ montar reply_to {id, author, preview}.
        const timelineRows = ident
          ? (
              await c.query(
                `SELECT t.id, t.received_at, t.kind, t.sender, t.body,
                        t.media_url, t.media_type, t.media_filename, t.media_transcription,
                        t.reply_to_id, rt.role AS rt_role, rt.body AS rt_body, rt.media_type AS rt_media_type
                   FROM (
                   -- Entrada do LEAD (USER). Rascunhos da IA (ASSISTANT) NÃO entram na
                   -- conversa: os pendentes pertencem ao bloco "Resposta sugerida".
                   SELECT m.id, m.reply_to_message_id AS reply_to_id, m.received_at, 'lead' AS kind, m.sender, m.body,
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
                   SELECT s.id, s.reply_to_message_id AS reply_to_id, s.received_at, 'recepcao' AS kind, s.sender, s.body,
                          s.media_url, s.media_type, s.media_filename, NULL AS media_transcription
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
                   SELECT pa.id, pa.reply_to_message_id AS reply_to_id, pa.created_at AS received_at, 'ia' AS kind, NULL AS sender,
                          pa.suggested_response AS body,
                          NULL AS media_url, NULL AS media_type, NULL AS media_filename, NULL AS media_transcription
                     FROM pending_approvals pa
                    WHERE pa.tenant_id = $1 AND pa.lead_id = $3
                      AND pa.status IN ('APPROVED', 'EDITED')
                      AND pa.suggested_response IS NOT NULL
                 ) t
                 LEFT JOIN messages rt ON rt.id = t.reply_to_id
                 ORDER BY t.received_at ASC`,
                [req.tenantId, ident, id]
              )
            ).rows
          : [];
        // Monta reply_to {id, author:"lead"|"staff", preview}. author vem do papel da
        // citada (USER=lead; ASSISTANT=escola/IA=staff). preview: ~80 chars ou "[mídia]".
        const timeline = timelineRows.map((r) => {
          const row = {
            id: r.id, received_at: r.received_at, kind: r.kind, sender: r.sender, body: r.body,
            media_url: r.media_url, media_type: r.media_type, media_filename: r.media_filename,
            media_transcription: r.media_transcription, reply_to: null,
          };
          if (r.reply_to_id) {
            const txt = r.rt_body && r.rt_body.trim() ? r.rt_body.trim() : null;
            row.reply_to = {
              id: r.reply_to_id,
              author: r.rt_role === 'USER' ? 'lead' : 'staff',
              preview: txt ? txt.slice(0, 80) : (r.rt_media_type ? '[mídia]' : ''),
            };
          }
          return row;
        });

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

        const desfechoCatalog = await _catalogoDesfecho(c, req.tenantId);
        return { lead, messages, timeline, pending, pendingTotal, desfechoCatalog };
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
          // E6: canal Meta normalizado p/ a UI decidir o endpoint de resposta.
          meta_channel: l.channel === 'instagram_dm' ? 'instagram'
            : l.channel === 'facebook_messenger' ? 'messenger' : null,
          instrument: l.instrument,
          availability: l.availability,
          qualification_complete: l.qualification_complete,
          temperatura_manual: l.temperatura_manual,
          created_at: l.created_at,
          updated_at: l.updated_at,
          desfecho: l.desfecho,
          desfecho_notas: l.desfecho_notas,
          desfecho_em: l.desfecho_em,
          desfecho_source: l.desfecho_source,
          desfecho_motivo: l.desfecho_motivo,
          desfecho_catalog: data.desfechoCatalog,
          // ADR sugestão-de-etapa: chip "IA sugere → etapa" no card de detalhe.
          suggested_stage: l.suggested_stage || null,
          stage_reasoning: l.stage_reasoning || null,
          stage_suggested_at: l.stage_suggested_at || null,
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
async function decidePending(tenantId, leadId, { status, response, decidedBy, replyToMessageId }) {
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

    // Citação (só no approve): persiste a citada na própria aprovação (linha 'ia' da
    // timeline). undefined em reject -> mantém NULL.
    const row = (
      await c.query(
        `UPDATE pending_approvals
            SET status = $2, suggested_response = $3, decided_at = now(), decided_by = $4,
                reply_to_message_id = $5
          WHERE id = $1
        RETURNING id, status, suggested_response, lead_id, conversation_id, created_at, decided_at`,
        [pending.id, finalStatus, finalText, decidedBy || null, replyToMessageId || null]
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
async function enviarRespostaAprovada(tenantId, leadId, texto, quoted) {
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
  const res = await evolution.sendText({ instance, apikey }, dados.phone, texto, quoted);
  return { sent: true, messageId: evolution.pickMessageId(res) };
}

// ADR-016 P1 / item C — telefone do lead + creds Evolution (mesma tx, RLS).
async function _credsLead(tenantId, leadId) {
  return withTenant(tenantId, async (c) => {
    const lead = (await c.query('SELECT phone FROM leads WHERE id = $1', [leadId])).rows[0];
    const tnt = (await c.query('SELECT evolution_instance, evolution_token_enc FROM tenants WHERE id = $1', [tenantId])).rows[0] || {};
    return { phone: lead && lead.phone, instance: tnt.evolution_instance, apikey: decrypt(tnt.evolution_token_enc) };
  });
}

// Registra a saída da recepção em staff_outbound_samples (timeline 'recepcao').
// O eco fromMe do webhook deduplica pela unique (tenant_id, external_message_id).
async function _registrarSaida(tenantId, { phone, externalMessageId, sender, body, media, replyToMessageId }) {
  await withTenant(tenantId, (c) => c.query(
    `INSERT INTO staff_outbound_samples
       (tenant_id, channel, external_id, external_message_id, source, sender, body, raw,
        media_url, media_type, media_filename, reply_to_message_id)
     VALUES ($1, 'whatsapp', $2, $3, 'api', $4, $5, NULL, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING`,
    [tenantId, phone, externalMessageId || null, sender || 'Recepção', body || null,
     (media && media.url) || null, (media && media.type) || null, (media && media.filename) || null,
     replyToMessageId || null]
  ));
}

// Citação: resolve a mensagem citada (sempre uma linha de messages, FK reply_to_message_id).
// Devolve { id, role, body, media_type, wa_key } ou null se o id for inválido/inexistente —
// nesse caso degrada para envio sem quoted, sem violar a FK. wa_key = key do WhatsApp
// (raw->'data'->'key') usada no quoted da Evolution; null p/ msg da IA (raw vazio) ou Z-API.
async function _msgCitada(tenantId, replyToMessageId) {
  if (!replyToMessageId || !isUuid(replyToMessageId)) return null;
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT id, role, body, media_type, raw->'data'->'key' AS wa_key
         FROM messages WHERE id = $1`,
      [replyToMessageId]
    );
    return r.rows[0] || null;
  });
}

// Registra feedback de classificação (aprendizado — ADR-011 Fase 2) com o
// confidence/reasoning ORIGINAIS do classificador. Roda dentro de um client `c`.
async function _registrarFeedback(c, tenantId, leadId, correctLabel, by, extra = {}) {
  const lead = (await c.query(
    'SELECT classification_confidence, classification_reasoning FROM leads WHERE id = $1', [leadId]
  )).rows[0] || {};
  await c.query(
    `INSERT INTO classification_feedback
       (tenant_id, lead_id, correct_label, original_confidence, original_reasoning,
        correction_context, corrected_temperature, feedback_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, leadId, correctLabel, lead.classification_confidence ?? null, lead.classification_reasoning ?? null,
     extra.context ?? null, extra.temperature ?? null, by || null]
  );
}

// POST /tenant/:tid/leads/:id/requalificar — recepção corrige a classificação.
// body { classification:'not_lead'|'quente'|'morno'|'frio', instrument?, intent?, observation? }
router.post('/:tenantId/leads/:id/requalificar', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
  const cls = req.body?.classification;
  if (!['not_lead', 'quente', 'morno', 'frio'].includes(cls)) return res.status(400).json({ error: 'invalid classification' });
  const instrument = typeof req.body?.instrument === 'string' ? req.body.instrument.trim() || null : null;
  const intent = typeof req.body?.intent === 'string' ? req.body.intent.trim() || null : null;
  const observation = typeof req.body?.observation === 'string' ? req.body.observation.trim() || null : null;
  try {
    const out = await withTenant(req.tenantId, async (c) => {
      const exists = (await c.query('SELECT 1 FROM leads WHERE id = $1', [id])).rowCount > 0;
      if (!exists) return null;
      if (cls === 'not_lead') {
        await c.query("UPDATE leads SET status = 'NOT_LEAD', updated_at = now() WHERE id = $1", [id]);
        await _registrarFeedback(c, req.tenantId, id, 'not_lead', req.tenantRole, { context: observation });
        return { status: 'NOT_LEAD' };
      }
      // quente/morno/frio: override de temperatura + instrumento/intenção opcionais.
      await c.query(
        `UPDATE leads SET temperatura_manual = $2,
                          intent = COALESCE($3, intent), updated_at = now()
          WHERE id = $1`,
        [id, cls, intent]
      );
      if (instrument) {
        await c.query(
          `INSERT INTO lead_qualifications (tenant_id, lead_id, instrument, extracted_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (tenant_id, lead_id) DO UPDATE SET instrument = EXCLUDED.instrument, extracted_at = now()`,
          [req.tenantId, id, instrument]
        );
      }
      await _registrarFeedback(c, req.tenantId, id, 'lead', req.tenantRole, { context: observation, temperature: cls });
      return { status: 'requalificado', temperatura: cls };
    });
    if (!out) return res.status(404).json({ error: 'lead not found' });
    logger.info('tenant.lead.requalificado', { tenant_id: req.tenantId, lead_id: id, classification: cls, by: req.tenantRole });
    res.json({ ok: true, ...out });
  } catch (err) {
    logger.error('tenant.lead.requalificar_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /tenant/:tid/leads/:id/mensagem — item C: envia texto livre ao lead.
router.post('/:tenantId/leads/:id/mensagem', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'empty text' });
  const replyToId = typeof req.body?.reply_to_message_id === 'string' ? req.body.reply_to_message_id : null;
  try {
    const d = await _credsLead(req.tenantId, id);
    if (!d.phone) return res.status(400).json({ error: 'no_phone' });
    if (!d.instance || !d.apikey) return res.status(400).json({ error: 'tenant_sem_evolution' });
    const st = await evolution.status({ instance: d.instance, apikey: d.apikey });
    if (st.state !== 'open') return res.status(409).json({ error: 'instancia=' + st.state });
    // Citação: resolve a citada; quoted só quando ela tem a key do WhatsApp (fallback:
    // sem key, envia sem quoted mas persiste reply_to_message_id p/ a citação visual).
    const citada = await _msgCitada(req.tenantId, replyToId);
    const quoted = citada && citada.wa_key ? { key: citada.wa_key } : undefined;
    const r = await evolution.sendText({ instance: d.instance, apikey: d.apikey }, d.phone, text, quoted);
    const msgId = evolution.pickMessageId(r);
    await _registrarSaida(req.tenantId, { phone: d.phone, externalMessageId: msgId, sender: req.tenantRole, body: text, replyToMessageId: citada ? citada.id : null });
    logger.info('tenant.lead.mensagem_enviada', { tenant_id: req.tenantId, lead_id: id, by: req.tenantRole, quoted: !!quoted });
    res.json({ ok: true, message_id: msgId, quoted: !!quoted });
  } catch (err) {
    logger.error('tenant.lead.mensagem_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
    res.status(502).json({ error: 'send_failed', detail: err.message });
  }
});

// POST /tenant/:tid/leads/:id/mensagem-meta — E6: responde um lead de DM (Messenger/IG)
// PELO MESMO CANAL que ele usou, via Graph API (POST /{page_id}/messages). Usa o
// meta_psid do lead + o Page Token do tenant. Grava em staff_outbound_samples.
router.post('/:tenantId/leads/:id/mensagem-meta', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'empty text' });
  const replyToId = typeof req.body?.reply_to_message_id === 'string' ? req.body.reply_to_message_id : null;
  try {
    const info = await withTenant(req.tenantId, async (c) => {
      const lead = (await c.query('SELECT meta_psid FROM leads WHERE id = $1', [id])).rows[0];
      if (!lead) return null;
      const channel = (await c.query(
        `SELECT cv.channel FROM conversations cv
          WHERE cv.tenant_id = $1
            AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = regexp_replace($2, '[^0-9]', '', 'g')
          ORDER BY cv.updated_at DESC LIMIT 1`,
        [req.tenantId, lead.meta_psid || '']
      )).rows[0]?.channel || null;
      return { psid: lead.meta_psid, channel };
    });
    if (!info) return res.status(404).json({ error: 'lead not found' });
    if (!info.psid) return res.status(400).json({ error: 'no_psid' });
    const creds = await meta.pageCredsForTenant(req.tenantId);
    if (!creds || !creds.pageId || !creds.token) return res.status(400).json({ error: 'tenant_sem_meta' });
    // LIMITAÇÃO Meta: a Send API (Messenger/IG) não oferece um "quoted reply" nativo
    // confiável referenciando uma mensagem anterior pelo mid que guardamos — então NÃO
    // enviamos reply nativo do Graph aqui. A citação é PERSISTIDA (reply_to_message_id)
    // e renderizada visualmente pela timeline; o envio sai sem quote nativo.
    const r = await meta.sendMessage(creds, info.psid, text);
    const msgId = (r && (r.message_id || r.mid)) || null;
    const citada = await _msgCitada(req.tenantId, replyToId);
    await withTenant(req.tenantId, (c) => c.query(
      `INSERT INTO staff_outbound_samples
         (tenant_id, channel, external_id, external_message_id, source, sender, body, raw, reply_to_message_id)
       VALUES ($1, $2, $3, $4, 'api', $5, $6, NULL, $7)
       ON CONFLICT (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING`,
      [req.tenantId, info.channel || 'facebook_messenger', info.psid, msgId, req.tenantRole || 'Recepção', text, citada ? citada.id : null]
    ));
    logger.info('tenant.lead.mensagem_meta_enviada', { tenant_id: req.tenantId, lead_id: id, channel: info.channel, by: req.tenantRole, quoted_persisted: !!citada });
    res.json({ ok: true, message_id: msgId, quoted: false, quoted_native_unsupported: !!citada });
  } catch (err) {
    const detail = err && err.body ? JSON.stringify(err.body) : err.message;
    logger.error('tenant.lead.mensagem_meta_error', { tenant_id: req.tenantId, lead_id: id, error: detail });
    res.status(502).json({ error: 'send_failed', detail: err.message });
  }
});

// POST /tenant/:tid/leads/:id/midia — ADR-016 P1: envia mídia (multipart file + caption?).
router.post('/:tenantId/leads/:id/midia', authenticate, requireTenantAccess(WRITE_ROLES), upload.single('file'), async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'no_file' });
  const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim() : '';
  const mimetype = req.file.mimetype || 'application/octet-stream';
  const filename = req.file.originalname || 'arquivo';
  try {
    const d = await _credsLead(req.tenantId, id);
    if (!d.phone) return res.status(400).json({ error: 'no_phone' });
    if (!d.instance || !d.apikey) return res.status(400).json({ error: 'tenant_sem_evolution' });
    const st = await evolution.status({ instance: d.instance, apikey: d.apikey });
    if (st.state !== 'open') return res.status(409).json({ error: 'instancia=' + st.state });
    const saved = mediaLib.salvarBuffer({ tenantId: req.tenantId, buffer: req.file.buffer, mimetype, filename });
    const r = await evolution.sendMedia({ instance: d.instance, apikey: d.apikey }, d.phone, {
      mediatype: saved.media_type, mimetype, media: saved.base64, fileName: filename, caption: caption || undefined,
    });
    const msgId = evolution.pickMessageId(r);
    const ph = caption || ({ audio: '[áudio]', image: '[imagem]', video: '[vídeo]', document: `[documento: ${filename}]` }[saved.media_type] || '[mídia]');
    await _registrarSaida(req.tenantId, {
      phone: d.phone, externalMessageId: msgId, sender: req.tenantRole, body: ph,
      media: { url: saved.media_url, type: saved.media_type, filename: saved.media_type === 'document' ? filename : null },
    });
    logger.info('tenant.lead.midia_enviada', { tenant_id: req.tenantId, lead_id: id, kind: saved.media_type, by: req.tenantRole });
    res.json({ ok: true, message_id: msgId, media_url: saved.media_url, media_type: saved.media_type });
  } catch (err) {
    logger.error('tenant.lead.midia_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
    res.status(502).json({ error: 'send_failed', detail: err.message });
  }
});

// PARTE 3 — retomada de leads silenciosos.
const RETOMADA_CACHE_TTL = 24 * 3600;

// GET /tenant/:tid/leads/:id/sugestao-retomada — sugestão de reabordagem (estrategia +
// P6 — nota de engajamento p/ contextualizar o prompt da IA + a linha exibida
// na estratégia. `speed` = classe pela mediana (alto/normal/baixo); `silenciou`
// = última msg foi nossa e o cliente sumiu. Retorna null se não há padrão claro.
function _notaEngajamento(speed, silenciou) {
  if (speed === 'alto' && silenciou) {
    return {
      desc: 'estava muito engajado (respondia em menos de 1h) e parou de responder — algo pode ter travado.',
      prompt: 'Este lead estava muito engajado (respondia em menos de 1h). Algo pode ter travado. '
        + 'Sugira perguntar diretamente se surgiu alguma dúvida, com tom próximo e natural.',
    };
  }
  if (speed === 'baixo') {
    return {
      desc: 'sempre demorou para responder — provavelmente tem rotina ocupada.',
      prompt: 'Este lead sempre demorou para responder. Provavelmente tem rotina ocupada. '
        + 'Sugira uma abordagem direta com algo concreto: um horário específico ou proposta objetiva. '
        + 'Identifique o melhor horário com base nos momentos em que o cliente respondeu.',
    };
  }
  if (speed === 'normal' && silenciou) {
    return {
      desc: 'tinha engajamento normal e silenciou — pode ter perdido o interesse ou estar avaliando.',
      prompt: 'Este lead tinha engajamento normal. Pode ter perdido o interesse ou estar avaliando. '
        + 'Sugira uma abordagem leve e sem pressão, reativando o contexto da última conversa.',
    };
  }
  return null;
}

// rascunho) via IA, READ-ONLY. Cacheada 24h no Redis (?refresh=1 força regenerar).
router.get('/:tenantId/leads/:id/sugestao-retomada', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
  const cacheKey = `retomada:${req.tenantId}:${id}`;
  try {
    if (req.query.refresh !== '1') {
      const cached = await redisClient.getCache(cacheKey);
      if (cached) return res.json({ ok: true, cached: true, ...cached });
    }
    const ctx = await withTenant(req.tenantId, async (c) => {
      const cfg = (await c.query(
        `SELECT school_name, system_prompt_override, available_instruments, business_hours, notification_whatsapp
           FROM tenant_lead_config WHERE tenant_id = $1`, [req.tenantId]
      )).rows[0];
      const tname = (await c.query('SELECT name FROM tenants WHERE id = $1', [req.tenantId])).rows[0]?.name;
      const lead = (await c.query('SELECT name, phone, meta_psid FROM leads WHERE id = $1', [id])).rows[0];
      if (!lead) return null;
      const ident = String(lead.phone || lead.meta_psid || '').replace(/\D/g, '');
      let convo = [];
      if (ident) {
        convo = (await c.query(
          `SELECT role, content FROM (
             SELECT m.received_at, 'USER' AS role, coalesce(m.media_transcription, m.body) AS content
               FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
              WHERE cv.tenant_id = $1 AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = $2
                AND coalesce(m.media_transcription, m.body) IS NOT NULL
             UNION ALL
             SELECT s.received_at, 'ASSISTANT' AS role, s.body AS content
               FROM staff_outbound_samples s
              WHERE s.tenant_id = $1 AND regexp_replace(s.external_id, '[^0-9]', '', 'g') = $2
                AND coalesce(s.raw->'data'->'key'->>'remoteJid', '') NOT LIKE '%@g.us' AND s.body IS NOT NULL
           ) t ORDER BY received_at ASC LIMIT 40`,
          [req.tenantId, ident]
        )).rows;
      }
      // P6 — sequências de msgs p/ classificar o padrão de engajamento do cliente.
      let eng = { engajamento: null, silenciou: false, tempo_medio_resposta_cliente_seg: null };
      if (ident) {
        const tin = (await c.query(
          `SELECT array_agg(EXTRACT(EPOCH FROM m.received_at) ORDER BY m.received_at) AS ts
             FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
            WHERE cv.tenant_id = $1 AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = $2 AND m.role = 'USER'`,
          [req.tenantId, ident])).rows[0];
        const tout = (await c.query(
          `SELECT array_agg(EXTRACT(EPOCH FROM s.received_at) ORDER BY s.received_at) AS ts
             FROM staff_outbound_samples s
            WHERE s.tenant_id = $1 AND regexp_replace(s.external_id, '[^0-9]', '', 'g') = $2
              AND coalesce(s.raw->'data'->'key'->>'remoteJid', '') NOT LIKE '%@g.us'`,
          [req.tenantId, ident])).rows[0];
        eng = classificarEngajamento(tin && tin.ts, tout && tout.ts, Date.now() / 1000);
      }
      return { config: cfg, tname, leadName: lead.name, convo, eng };
    });
    if (!ctx) return res.status(404).json({ error: 'lead not found' });
    const schoolContext = resolveSystemPrompt(ctx.config || { school_name: ctx.tname || 'Escola', system_prompt_override: null });
    // Classe pela mediana (independe do flag silenciou, que tem prioridade no rótulo).
    const med = ctx.eng && ctx.eng.tempo_medio_resposta_cliente_seg;
    const speed = med == null ? null : (med <= 3600 ? 'alto' : (med <= 86400 ? 'normal' : 'baixo'));
    const nota = _notaEngajamento(speed, !!(ctx.eng && ctx.eng.silenciou));
    const out = await gemini.sugestaoRetomada({
      history: ctx.convo, leadName: ctx.leadName, schoolContext,
      engajamentoNota: nota ? nota.prompt : '',
    });
    if (nota && out && typeof out.estrategia === 'string') {
      out.estrategia = `Padrão do cliente: ${nota.desc}\n\n${out.estrategia}`.trim();
    }
    await redisClient.setCache(cacheKey, out, RETOMADA_CACHE_TTL);
    logger.info('tenant.retomada.sugestao', { tenant_id: req.tenantId, lead_id: id, by: req.tenantRole });
    res.json({ ok: true, cached: false, ...out });
  } catch (err) {
    logger.error('tenant.retomada.sugestao_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /tenant/:tid/leads/:id/enviar-retomada — body { texto, estrategia?, rascunho? }.
// Envia via Evolution, grava na timeline e registra a tentativa em reabordagem_tentativas.
router.post('/:tenantId/leads/:id/enviar-retomada', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
  const text = typeof req.body?.texto === 'string' ? req.body.texto.trim() : '';
  if (!text) return res.status(400).json({ error: 'empty text' });
  const estrategia = typeof req.body?.estrategia === 'string' ? req.body.estrategia.trim() || null : null;
  const rascunho = typeof req.body?.rascunho === 'string' ? req.body.rascunho.trim() || null : null;
  try {
    const d = await _credsLead(req.tenantId, id);
    if (!d.phone) return res.status(400).json({ error: 'no_phone' });
    if (!d.instance || !d.apikey) return res.status(400).json({ error: 'tenant_sem_evolution' });
    const st = await evolution.status({ instance: d.instance, apikey: d.apikey });
    if (st.state !== 'open') return res.status(409).json({ error: 'instancia=' + st.state });
    const r = await evolution.sendText({ instance: d.instance, apikey: d.apikey }, d.phone, text);
    const msgId = evolution.pickMessageId(r);
    await _registrarSaida(req.tenantId, { phone: d.phone, externalMessageId: msgId, sender: req.tenantRole, body: text });
    // Se há uma sugestão PENDENTE (gerada pelo job ADR-020), aprova-a (vira
    // 'enviado') em vez de criar uma 2ª linha; senão registra o envio manual.
    await withTenant(req.tenantId, async (c) => {
      const upd = await c.query(
        `UPDATE reabordagem_tentativas
            SET texto = $3, status = 'enviado', enviado_em = now(),
                sugestao_estrategia = COALESCE($4, sugestao_estrategia),
                sugestao_rascunho   = COALESCE($5, sugestao_rascunho)
          WHERE id = (SELECT id FROM reabordagem_tentativas
                       WHERE tenant_id = $1 AND lead_id = $2 AND status = 'pendente'
                       ORDER BY enviado_em DESC LIMIT 1)`,
        [req.tenantId, id, text, estrategia, rascunho]
      );
      if (upd.rowCount === 0) {
        await c.query(
          `INSERT INTO reabordagem_tentativas (tenant_id, lead_id, texto, sugestao_estrategia, sugestao_rascunho, status)
           VALUES ($1, $2, $3, $4, $5, 'enviado')`,
          [req.tenantId, id, text, estrategia, rascunho]
        );
      }
    });
    redisClient.delCache(`retomada:${req.tenantId}:${id}`).catch(() => {});
    logger.info('tenant.retomada.enviada', { tenant_id: req.tenantId, lead_id: id, by: req.tenantRole });
    res.json({ ok: true, message_id: msgId });
  } catch (err) {
    logger.error('tenant.retomada.enviar_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
    res.status(502).json({ error: 'send_failed', detail: err.message });
  }
});

// POST /tenant/:tid/leads/:id/ignorar-retomada — ADR-020: descarta a sugestão de
// reabordagem pendente (status 'pendente' -> 'ignorado'). Não envia nada.
router.post('/:tenantId/leads/:id/ignorar-retomada', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
  try {
    const n = await withTenant(req.tenantId, (c) => c.query(
      `UPDATE reabordagem_tentativas
          SET status = 'ignorado'
        WHERE id = (SELECT id FROM reabordagem_tentativas
                     WHERE tenant_id = $1 AND lead_id = $2 AND status = 'pendente'
                     ORDER BY enviado_em DESC LIMIT 1)`,
      [req.tenantId, id]
    ).then((r) => r.rowCount));
    if (!n) return res.status(404).json({ error: 'no_pending' });
    redisClient.delCache(`retomada:${req.tenantId}:${id}`).catch(() => {});
    logger.info('tenant.retomada.ignorada', { tenant_id: req.tenantId, lead_id: id, by: req.tenantRole });
    res.json({ ok: true });
  } catch (err) {
    logger.error('tenant.retomada.ignorar_error', { tenant_id: req.tenantId, lead_id: id, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// Resumo legado {inicio,fim,dias} a partir da forma canônica por-dia — mantém
// a tela ATUAL funcionando até a UI por-dia (H2). Single-faixa = exato.
function _resumoLegado(porDia) {
  const norm = normaliza(porDia) || {};
  const dias = Object.keys(norm).map(Number).sort((a, b) => a - b);
  let mi = null, ma = null;
  for (const d of dias) for (const fx of norm[d]) {
    mi = mi == null ? fx.ini : Math.min(mi, fx.ini);
    ma = ma == null ? fx.fim : Math.max(ma, fx.fim);
  }
  return {
    inicio: mi != null ? minToHm(mi) : '08:00',
    fim: ma != null ? minToHm(ma) : '18:00',
    dias: dias.length ? dias : [1, 2, 3, 4, 5],
  };
}

// GET /tenant/:tid/horario-comercial — horário de atendimento atual.
// Devolve o jsonb por-dia (`por_dia`) + um resumo legado {inicio,fim,dias} p/
// a tela atual. Se só houver dado antigo (jsonb nulo), converte na resposta.
router.get('/:tenantId/horario-comercial', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  try {
    const row = await withTenant(req.tenantId, (c) => c.query(
      `SELECT horario_comercial AS jsonb,
              to_char(horario_comercial_inicio, 'HH24:MI') AS inicio,
              to_char(horario_comercial_fim, 'HH24:MI') AS fim,
              horario_comercial_dias AS dias
         FROM tenants WHERE id = $1`, [req.tenantId]
    ).then((r) => r.rows[0] || {}));
    const fonte = row.jsonb || fromLegacy(row.inicio, row.fim, row.dias);
    const por_dia = canonicaliza(fonte);   // {} = nenhum dia configurado (fechado)
    res.json({ por_dia, ..._resumoLegado(por_dia) });
  } catch (err) {
    logger.error('tenant.horario.get_error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// PUT /tenant/:tid/horario-comercial — grava no jsonb por-dia.
// Aceita:
//   - shape novo:   { por_dia: { "1":[{inicio,fim}], ... } }  ou o objeto bare { "1":[...] }
//   - shape antigo: { inicio:'HH:MM', fim:'HH:MM', dias:[1..7] }  (convertido)
// Valida HH:MM, inicio<fim por faixa, faixas sem sobreposição no mesmo dia.
// NÃO toca as colunas antigas (ficam como snapshot pré-049 p/ rollback).
router.put('/:tenantId/horario-comercial', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const body = req.body || {};
  let porDia;
  const isLegacy = Array.isArray(body.dias) || 'inicio' in body || 'fim' in body;
  if (body.por_dia && typeof body.por_dia === 'object') {
    porDia = body.por_dia;
  } else if (isLegacy) {
    const inicio = String(body.inicio || '').trim();
    const fim = String(body.fim || '').trim();
    const dias = [...new Set((Array.isArray(body.dias) ? body.dias.map(Number) : [])
      .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);
    if (!dias.length) return res.status(400).json({ error: 'selecione ao menos um dia' });
    porDia = fromLegacy(inicio, fim, dias);
    if (!porDia) return res.status(400).json({ error: 'horário inválido (use HH:MM)' });
  } else {
    porDia = body;   // objeto bare { "1":[...] }
  }

  const v = validaHorarioJson(porDia);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const canon = canonicaliza(porDia);

  try {
    await withTenant(req.tenantId, (c) => c.query(
      `UPDATE tenants SET horario_comercial = $2 WHERE id = $1`,
      [req.tenantId, JSON.stringify(canon)]
    ));
    logger.info('tenant.horario.updated', { tenant_id: req.tenantId, por_dia: canon, by: req.tenantRole });
    res.json({ ok: true, por_dia: canon, ..._resumoLegado(canon) });
  } catch (err) {
    logger.error('tenant.horario.put_error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// ADR-018 — contatos internos (equipe/parceiros que nunca viram lead).
const _TIPOS_INTERNO = ['gestor', 'recepcionista', 'professor', 'funcionario', 'parceiro', 'outro'];

// Normaliza para dígitos com DDI 55 (formato dos dados existentes; o engine casa
// internal_contacts por dígitos). Aceita +55..., 55..., ou número BR sem DDI.
function _normalizaTelefoneBR(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (!d.startsWith('55') && (d.length === 10 || d.length === 11)) d = '55' + d;
  return d.length >= 12 && d.length <= 13 ? d : null;
}

// GET /tenant/:tid/internal-contacts — lista os contatos internos do tenant.
router.get('/:tenantId/internal-contacts', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  try {
    const rows = await withTenant(req.tenantId, (c) => c.query(
      `SELECT id, name, phone, type, created_at
         FROM internal_contacts WHERE tenant_id = $1
        ORDER BY created_at DESC`, [req.tenantId]
    ).then((r) => r.rows));
    res.json({ tenant_id: req.tenantId, count: rows.length, contacts: rows });
  } catch (err) {
    logger.error('tenant.internal_contacts.list_error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /tenant/:tid/internal-contacts — body { name, phone, type }.
router.post('/:tenantId/internal-contacts', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const phone = _normalizaTelefoneBR(req.body?.phone);
  const type = _TIPOS_INTERNO.includes(req.body?.type) ? req.body.type : null;
  if (!name) return res.status(400).json({ error: 'informe o nome' });
  if (!phone) return res.status(400).json({ error: 'telefone inválido (use +55 e DDD)' });
  if (!type) return res.status(400).json({ error: 'tipo inválido' });
  try {
    const row = await withTenant(req.tenantId, (c) => c.query(
      `INSERT INTO internal_contacts (tenant_id, phone, name, type) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, phone) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type
       RETURNING id, name, phone, type, created_at`,
      [req.tenantId, phone, name, type]
    ).then((r) => r.rows[0]));
    logger.info('tenant.internal_contacts.created', { tenant_id: req.tenantId, type, by: req.tenantRole });
    res.json({ ok: true, contact: row });
  } catch (err) {
    logger.error('tenant.internal_contacts.create_error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// DELETE /tenant/:tid/internal-contacts/:id — remove um contato interno.
router.delete('/:tenantId/internal-contacts/:id', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const n = await withTenant(req.tenantId, (c) => c.query(
      'DELETE FROM internal_contacts WHERE id = $1 AND tenant_id = $2', [id, req.tenantId]
    ).then((r) => r.rowCount));
    if (!n) return res.status(404).json({ error: 'not found' });
    logger.info('tenant.internal_contacts.deleted', { tenant_id: req.tenantId, id, by: req.tenantRole });
    res.json({ ok: true });
  } catch (err) {
    logger.error('tenant.internal_contacts.delete_error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /tenant/:tid/leads/:id/approve  — body opcional { response }
router.post(
  '/:tenantId/leads/:id/approve',
  authenticate,
  requireTenantAccess(WRITE_ROLES),
  async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
    const response = typeof req.body?.response === 'string' ? req.body.response.trim() : null;
    const replyToId = typeof req.body?.reply_to_message_id === 'string' ? req.body.reply_to_message_id : null;
    try {
      // Citação: resolve a citada antes de decidir (id válido p/ persistir + key p/ o quoted).
      const citada = await _msgCitada(req.tenantId, replyToId);
      const r = await decidePending(req.tenantId, id, { status: 'APPROVED', response, decidedBy: req.tenantRole, replyToMessageId: citada ? citada.id : null });
      if (r.notFound) return res.status(404).json({ error: 'no pending approval' });
      // E4 — após gravar o status, envia a resposta aprovada ao lead. Best-effort:
      // falha de envio NÃO derruba o approve (a aprovação já está persistida).
      let envio = { sent: false, reason: 'not_attempted' };
      try {
        const quoted = citada && citada.wa_key ? { key: citada.wa_key } : undefined;
        envio = await enviarRespostaAprovada(req.tenantId, id, r.approval.suggested_response, quoted);
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
  'nao_e_lead',
  'outro',
];

// Catálogo de desfecho GENÉRICO (won/lost/open) — default em código (mesma forma do
// seed por-tenant em tenant_lead_config.desfecho_catalog, migr. 042). Sem conceito ADR
// cravado: 'matriculado'/'nao_matriculado_*' são só os valores LEGADOS mapeados.
const DESFECHO_CATALOG_DEFAULT = {
  outcomes: [
    { key: 'won',  label: 'Ganhou',    desfecho: 'matriculado', status: 'CONVERTED' },
    { key: 'lost', label: 'Não fechou', motivos: [
      { key: 'preco',         label: 'Preço',          desfecho: 'nao_matriculado_preco' },
      { key: 'sem_retorno',   label: 'Sem retorno',    desfecho: 'nao_matriculado_desistiu' },
      { key: 'outro_curso',   label: 'Escolheu outro', desfecho: 'nao_matriculado_concorrente' },
      { key: 'sem_interesse', label: 'Sem interesse',  desfecho: 'outro' },
    ] },
    { key: 'open', label: 'Em aberto', desfecho: null },
  ],
};
async function _catalogoDesfecho(c, tenantId) {
  const r = await c.query('SELECT desfecho_catalog FROM tenant_lead_config WHERE tenant_id = $1', [tenantId]);
  const cat = r.rows[0] && r.rows[0].desfecho_catalog;
  return (cat && Array.isArray(cat.outcomes) && cat.outcomes.length) ? cat : DESFECHO_CATALOG_DEFAULT;
}
// outcome(+motivo) -> { desfecho legado, status, ground_truth, motivo, label } via catálogo.
function _resolverDesfecho(catalog, outcome, motivoKey) {
  const o = (catalog.outcomes || []).find((x) => x.key === outcome);
  if (!o) return null;
  if (outcome === 'open') return { desfecho: null, status: null, ground_truth: null, motivo: null, label: o.label };
  if (outcome === 'won')  return { desfecho: o.desfecho || 'matriculado', status: o.status || 'CONVERTED', ground_truth: 'won', motivo: null, label: o.label };
  // lost: precisa de um motivo do catálogo
  const m = (o.motivos || []).find((x) => x.key === motivoKey) || (o.motivos || [])[0];
  if (!m) return null;
  return { desfecho: m.desfecho || 'outro', status: null, ground_truth: 'lost', motivo: m.key, label: `${o.label} · ${m.label}` };
}

// POST /tenant/:tid/leads/:id/desfecho — registra o resultado final do lead.
// body { desfecho, notas? }. Auth igual a approve/reject (WRITE_ROLES).
router.post(
  '/:tenantId/leads/:id/desfecho',
  authenticate,
  requireTenantAccess(WRITE_ROLES),
  async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(400).json({ error: 'invalid lead id' });
    const notas = typeof req.body?.notas === 'string' ? req.body.notas.trim() || null : null;
    const autor = (typeof req.body?.by_name === 'string' && req.body.by_name.trim())
      ? req.body.by_name.trim() : (req.tenantRole || 'recepção');
    // API genérica (preferida): { outcome: won|lost|open, motivo? } — mapeada pelo
    // catálogo por-tenant. Back-compat: aceita o { desfecho } legado direto.
    const outcome = typeof req.body?.outcome === 'string' ? req.body.outcome.trim() : '';
    const legado = typeof req.body?.desfecho === 'string' ? req.body.desfecho.trim() : '';
    try {
      const out = await withTenant(req.tenantId, async (c) => {
        let desfecho, status = null, ground_truth = null, motivo = null, label;
        if (outcome) {
          const cat = await _catalogoDesfecho(c, req.tenantId);
          const res2 = _resolverDesfecho(cat, outcome, typeof req.body?.motivo === 'string' ? req.body.motivo.trim() : null);
          if (!res2) return { bad: true };
          ({ desfecho, status, ground_truth, motivo, label } = res2);
        } else {
          if (!DESFECHOS_VALIDOS.includes(legado)) return { bad: true };
          desfecho = legado;
          status = legado === 'nao_e_lead' ? 'NOT_LEAD' : null;
          ground_truth = legado === 'matriculado' ? 'won' : (legado === 'nao_e_lead' ? null : 'lost');
          label = legado;
        }
        // D2 — humano tem PRIORIDADE: grava desfecho + source='recepcao' + motivo + em.
        const r = await c.query(
          `UPDATE leads
              SET desfecho = $2, desfecho_notas = COALESCE($3, desfecho_notas),
                  desfecho_motivo = $4, desfecho_source = 'recepcao', desfecho_em = now(),
                  -- won -> CONVERTED; mudar PRA fora de 'matriculado' des-converte (lost/open
                  -- não pode deixar o lead como convertido). nao_e_lead -> NOT_LEAD.
                  status = CASE
                             WHEN $5::text IS NOT NULL THEN $5::text
                             WHEN status = 'CONVERTED' AND $2 IS DISTINCT FROM 'matriculado' THEN 'QUALIFIED'
                             ELSE status END,
                  updated_at = now()
            WHERE id = $1
            RETURNING desfecho, desfecho_notas, desfecho_motivo, desfecho_source, desfecho_em, status`,
          [id, desfecho, notas, motivo, status]
        );
        if (!r.rows[0]) return null;
        // Auditoria (append) — lead_eventos.
        await c.query(
          `INSERT INTO lead_eventos (tenant_id, lead_id, tipo, autor, conteudo)
           VALUES ($1, $2, 'desfecho', $3, $4)`,
          [req.tenantId, id, autor, `Desfecho: ${label}${notas ? ` — ${notas}` : ''}`]
        );
        // Ground-truth de conversão (destrava o classifier_shadow): UPDATE idempotente.
        await c.query('UPDATE classifier_shadow SET ground_truth = $2 WHERE lead_id = $1', [id, ground_truth]);
        // "não é lead" legado segue alimentando o few-shot do classificador.
        if (desfecho === 'nao_e_lead') await _registrarFeedback(c, req.tenantId, id, 'not_lead', req.tenantRole);
        return { row: r.rows[0], ground_truth, outcome: outcome || null };
      });
      if (out && out.bad) return res.status(400).json({ error: 'invalid desfecho/outcome' });
      if (!out || !out.row) return res.status(404).json({ error: 'lead not found' });
      logger.info('tenant.lead.desfecho', {
        tenant_id: req.tenantId, lead_id: id, desfecho: out.row.desfecho, source: 'recepcao',
        ground_truth: out.ground_truth, by: autor,
      });
      res.json({ ok: true, ...out.row, ground_truth: out.ground_truth });
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

// ===========================================================================
// ADR-006 — Automação de atendimento (automacao_config + automacao_log).
// GET retorna a config atual (com defaults) + as últimas alterações.
// PUT grava a config (upsert), audita em automacao_log e loga o evento.
// ===========================================================================
const MODOS = ['manual', 'semi', 'auto'];
const AUTOMACAO_DEFAULTS = {
  modo_comercial: 'manual', modo_fora_horario: 'semi', modo_fds: 'semi',
  primeira_resposta_auto: true, qualificacao_auto: true,
  proposta_sempre_manual: true, agendamento_sempre_manual: true,
};

const MODO_LABEL = { manual: 'Manual', semi: 'Semi-automático', auto: 'Automático' };
const AUTOMACAO_CAMPOS = {
  modo_comercial: { label: 'Horário comercial', modo: true },
  modo_fora_horario: { label: 'Fora do horário', modo: true },
  modo_fds: { label: 'Fins de semana', modo: true },
  primeira_resposta_auto: { label: 'Primeira resposta automática', modo: false },
  qualificacao_auto: { label: 'Qualificação automática', modo: false },
  proposta_sempre_manual: { label: 'Proposta sempre manual', modo: false },
  agendamento_sempre_manual: { label: 'Agendamento sempre manual', modo: false },
};
function _valorLabel(campo, v) {
  if (AUTOMACAO_CAMPOS[campo] && AUTOMACAO_CAMPOS[campo].modo) return MODO_LABEL[v] || v;
  return v ? 'Sim' : 'Não';
}
// Lista os campos que mudaram entre `de` e `para`, com rótulos legíveis.
function _diffAutomacao(de, para) {
  const out = [];
  for (const campo of Object.keys(AUTOMACAO_CAMPOS)) {
    if (de[campo] !== para[campo]) {
      out.push({
        campo, label: AUTOMACAO_CAMPOS[campo].label, modo: AUTOMACAO_CAMPOS[campo].modo,
        de: _valorLabel(campo, de[campo]), para: _valorLabel(campo, para[campo]),
      });
    }
  }
  return out;
}

function _snapshotAutomacao(row) {
  return {
    modo_comercial: row.modo_comercial, modo_fora_horario: row.modo_fora_horario, modo_fds: row.modo_fds,
    primeira_resposta_auto: row.primeira_resposta_auto, qualificacao_auto: row.qualificacao_auto,
    proposta_sempre_manual: row.proposta_sempre_manual, agendamento_sempre_manual: row.agendamento_sempre_manual,
  };
}

router.get('/:tenantId/automacao', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  try {
    const out = await withTenant(req.tenantId, async (c) => {
      const cfg = (await c.query('SELECT * FROM automacao_config WHERE tenant_id = $1', [req.tenantId])).rows[0];
      const historico = (await c.query(
        `SELECT usuario, modo_anterior, modo_novo, motivo, criado_em
           FROM automacao_log WHERE tenant_id = $1 ORDER BY criado_em DESC LIMIT 10`, [req.tenantId])).rows;
      return { cfg, historico };
    });
    const config = out.cfg
      ? { ..._snapshotAutomacao(out.cfg), updated_at: out.cfg.updated_at, updated_by: out.cfg.updated_by }
      : { ...AUTOMACAO_DEFAULTS, updated_at: null, updated_by: null };
    res.json({ tenant_id: req.tenantId, config, historico: out.historico });
  } catch (err) {
    logger.error('tenant.automacao.error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

router.put('/:tenantId/automacao', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const b = req.body || {};
  const novo = {
    modo_comercial: String(b.modo_comercial || '').trim(),
    modo_fora_horario: String(b.modo_fora_horario || '').trim(),
    modo_fds: String(b.modo_fds || '').trim(),
    primeira_resposta_auto: b.primeira_resposta_auto !== false,
    qualificacao_auto: b.qualificacao_auto !== false,
    proposta_sempre_manual: b.proposta_sempre_manual !== false,
    agendamento_sempre_manual: b.agendamento_sempre_manual !== false,
  };
  for (const k of ['modo_comercial', 'modo_fora_horario', 'modo_fds']) {
    if (!MODOS.includes(novo[k])) return res.status(400).json({ error: `${k} inválido` });
  }
  const motivo = typeof b.motivo === 'string' ? b.motivo.trim().slice(0, 500) : '';
  // usuario do log: identidade real do operador (vem do dashboard, que autentica
  // com SERVICE_TOKEN compartilhado); cai no papel do token só como fallback.
  const usuario = (typeof b.by_name === 'string' && b.by_name.trim())
    ? b.by_name.trim() : (req.tenantRole || 'desconhecido');
  try {
    const out = await withTenant(req.tenantId, async (c) => {
      const atual = (await c.query('SELECT * FROM automacao_config WHERE tenant_id = $1', [req.tenantId])).rows[0];
      const anterior = atual ? _snapshotAutomacao(atual) : { ...AUTOMACAO_DEFAULTS };
      const r = await c.query(
        `INSERT INTO automacao_config
           (tenant_id, modo_comercial, modo_fora_horario, modo_fds,
            primeira_resposta_auto, qualificacao_auto, proposta_sempre_manual, agendamento_sempre_manual,
            updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9)
         ON CONFLICT (tenant_id) DO UPDATE SET
           modo_comercial = EXCLUDED.modo_comercial,
           modo_fora_horario = EXCLUDED.modo_fora_horario,
           modo_fds = EXCLUDED.modo_fds,
           primeira_resposta_auto = EXCLUDED.primeira_resposta_auto,
           qualificacao_auto = EXCLUDED.qualificacao_auto,
           proposta_sempre_manual = EXCLUDED.proposta_sempre_manual,
           agendamento_sempre_manual = EXCLUDED.agendamento_sempre_manual,
           updated_at = now(), updated_by = EXCLUDED.updated_by
         RETURNING *`,
        [req.tenantId, novo.modo_comercial, novo.modo_fora_horario, novo.modo_fds,
         novo.primeira_resposta_auto, novo.qualificacao_auto, novo.proposta_sempre_manual,
         novo.agendamento_sempre_manual, usuario]
      );
      await c.query(
        `INSERT INTO automacao_log (tenant_id, usuario, modo_anterior, modo_novo, motivo)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5)`,
        [req.tenantId, usuario, JSON.stringify(anterior), JSON.stringify(novo), motivo || null]
      );
      return { row: r.rows[0], anterior };
    });
    logger.info('tenant.automacao.alterada', {
      tenant_id: req.tenantId, by: usuario, anterior: out.anterior, novo, motivo: motivo || null,
    });
    // Warning ao gestor (notif_phones): só quando um MODO mudou (ADR-006).
    const mudancas = _diffAutomacao(out.anterior, novo);
    const modoMudou = mudancas.some((m) => m.modo);
    if (modoMudou) {
      const byName = typeof b.by_name === 'string' && b.by_name.trim() ? b.by_name.trim() : usuario;
      notificarRecepcao(req.tenantId, 'automacao_alterada', { byName, mudancas, motivo: motivo || null })
        .catch((e) => logger.warn('tenant.automacao.notif_error', { tenant_id: req.tenantId, error: e.message }));
    }
    res.json({ ok: true, config: { ..._snapshotAutomacao(out.row), updated_at: out.row.updated_at, updated_by: out.row.updated_by }, anterior: out.anterior });
  } catch (err) {
    logger.error('tenant.automacao.update_error', { tenant_id: req.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
