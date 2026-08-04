'use strict';

const { withTenant, pool } = require('./db');
const logger = require('./logger');
const { toE164 } = require('./validation');
const telBR = require('./telefoneBR');
const { resolveSystemPrompt } = require('./templates');
const { loadPromptConfig } = require('./promptConfig');   // horário: fonte única tenants.horario_comercial
const gemini = require('./gemini');
const { getRescuePolicy } = require('./roleLeadPolicy');   // ADR-036 E1.4: rescue question por papel (config por tenant)
const notifyModule = require('./notify');
const notificacao = require('./notificacao');   // Bloco 4: push WhatsApp pra recepção
const redisClient = require('./redisClient');
const gating = require('./gating');
const { kanbanColuna } = require('./metrics');   // ADR sugestão-de-etapa: travas de posição
const stages = require('./stages');              // régua canônica: KEY_TO_STATUS/KANBAN_TRANSICOES (auto-apply)
const { gateSaida } = require('./bolaGate');     // ADR-030 Passo 2: gate determinístico da saída

const CONFIDENCE_THRESHOLD = 0.7;
// Bloco 2 — roteamento por confidence (probabilidade de ser lead):
//   >= AUTO  : entra no funil automaticamente.
//   >= REVIEW: fila de revisão (status REVIEW_QUEUE).
//   <  REVIEW: fila de revisão também, mas status NOT_LEAD (visível, zero lead perdido).
const AUTO_THRESHOLD = 0.85;
const REVIEW_THRESHOLD = 0.40;

// Few-shot dinâmico: últimas correções da recepção pra calibrar o classificador.
// BALANCEADO por rótulo (Frente 2): a base é fortemente negativa (ex.: 105 not_lead
// vs 7 lead em Valinhos). Pegar "os 10 mais recentes" cru espreme os exemplos
// POSITIVOS pra fora — o gate aprende só "não é lead" e passa a rebaixar lead óbvio.
// Buscamos os N mais recentes de CADA rótulo (o _fewShot do gemini já corta em 5+5),
// garantindo que o exemplo positivo apareça sempre que existir.
const FEWSHOT_PER_LABEL = 5;
async function _fewShotExamples(tenantId) {
  try {
    const res = await withTenant(tenantId, (c) => c.query(
      `(SELECT correct_label, original_reasoning, correction_context, corrected_temperature, feedback_at
          FROM classification_feedback WHERE tenant_id = $1 AND correct_label = 'lead'
         ORDER BY feedback_at DESC LIMIT $2)
       UNION ALL
       (SELECT correct_label, original_reasoning, correction_context, corrected_temperature, feedback_at
          FROM classification_feedback WHERE tenant_id = $1 AND correct_label = 'not_lead'
         ORDER BY feedback_at DESC LIMIT $2)
       ORDER BY feedback_at DESC`,
      [tenantId, FEWSHOT_PER_LABEL]
    ));
    return res.rows.map((r) => ({
      label: r.correct_label, reasoning: r.original_reasoning,
      context: r.correction_context, temperature: r.corrected_temperature,
    }));
  } catch { return []; }
}

// Config do classificador por tenant (multi-tenant, sem hardcode):
//  - lead_definition  : a DEFINIÇÃO de negócio/lead injetada no prompt do classifyConversa
//                       (externaliza o que antes era "escola de música" cravado).
//  - stage_definitions: as etapas sugeríveis do detector (key→descrição).
// Ausente/NULL → o prompt cai no fallback genérico / o detector não sugere nada.
async function _classifierConfig(tenantId) {
  try {
    const res = await withTenant(tenantId, (c) => c.query(
      'SELECT lead_definition, stage_definitions FROM tenant_lead_config WHERE tenant_id = $1', [tenantId]));
    return { leadDefinition: res.rows[0]?.lead_definition || null, stageDefinitions: res.rows[0]?.stage_definitions || null };
  } catch { return { leadDefinition: null, stageDefinitions: null }; }
}

// ============================================================================
// ADR-029 fatia 3 — supressão por papel + pré-sinalização de "não é lead" (MODO SOMBRA).
// INERTE com gate_suppression_mode='off' (default de TODOS os tenants). 'shadow' só
// REGISTRA em gate_shadow_log (não age). 'on' age. Toda leitura de contact_role_member
// passa por withTenant (set app.current_tenant) → RLS isola um tenant do outro.
// TTL e modo vêm da config por tenant (nunca constante). Edição por UI = fatia 5.
// ============================================================================
const PRESIGNAL_NOTE = 'Contato já marcado "não é lead" antes (dentro da validade). '
  + 'Reavalie a conversa do zero — isto é só uma dúvida a conferir, NÃO um veredito.';

// Gate 0 (rescue question): nº MÁXIMO de turnos da conversa passados à rescue. Cap de custo/token —
// rotina-vs-lead se decide nos turnos RECENTES; manda-se o TAIL (mais recente). A rescue só roda p/
// contato de PAPEL hard (conhecido no cadastro), fração pequena dos inbounds → custo extra contido.
const RESCUE_CONV_MAX = 20;
// Monta a conversa que a rescue julga: histórico real (loadRealHistory) + a mensagem ATUAL (que no
// Gate 0 ainda não está persistida em `messages`), com tail cap. Histórico vazio → devolve só a
// mensagem atual → classifyRescue mantém o default conservador (na dúvida, keep). PURA (testável).
function _rescueConversation(history, currentBody) {
  const conv = Array.isArray(history) ? history.slice() : [];
  if (currentBody) conv.push({ role: 'USER', content: currentBody, at: new Date().toISOString() });
  return conv.length > RESCUE_CONV_MAX ? conv.slice(-RESCUE_CONV_MAX) : conv;
}

async function _gateConfig(tenantId) {
  try {
    const r = await withTenant(tenantId, (c) => c.query(
      'SELECT gate_suppression_mode, presignal_ttl_days, rescue_conv_mode FROM tenant_lead_config WHERE tenant_id = $1', [tenantId]));
    const row = r.rows[0] || {};
    const mode = ['off', 'shadow', 'on'].includes(row.gate_suppression_mode) ? row.gate_suppression_mode : 'off';
    const ttlDays = Number.isInteger(row.presignal_ttl_days) ? row.presignal_ttl_days : 30;
    // Flag INDEPENDENTE (migration 076): shadow/flip da rescue-com-conversa. 'off' → rescue julga só a
    // mensagem (pré-correção). Nunca confundir com `mode` (gate_suppression) — são ortogonais.
    const rescueConvMode = ['off', 'shadow', 'on'].includes(row.rescue_conv_mode) ? row.rescue_conv_mode : 'off';
    return { mode, ttlDays, rescueConvMode };
  } catch { return { mode: 'off', ttlDays: 30, rescueConvMode: 'off' }; }   // falha → inerte
}

// Papel EXPLÍCITO do contato (contact_role_member ⋈ contact_role). RLS isola por tenant.
// Casa por DÍGITOS BR-aware (matchKeys), IDÊNTICO a _presignalActive/_isRelationshipContact:
// um papel gravado em formato divergente (com/sem 55, com/sem 9º dígito) não pode escapar do
// match só por diferença de formato (mesmo bug que a Camada 1 corrigiu no _isRelationshipContact).
async function _lookupRole(tenantId, phone) {
  const keys = phone ? telBR.matchKeys(phone) : [];
  if (!keys.length) return null;
  try {
    const r = await withTenant(tenantId, (c) => c.query(
      `SELECT cr.id AS role_id, cr.key, cr.suppression
         FROM contact_role_member m
         JOIN contact_role cr ON cr.id = m.role_id
        WHERE m.tenant_id = $1
          AND regexp_replace(m.phone, '[^0-9]', '', 'g') = ANY($2::text[])
        LIMIT 1`,
      [tenantId, keys]));
    return r.rows[0] || null;
  } catch { return null; }
}

// Pré-sinalização DERIVADA DO HISTÓRICO (sem linha por-contato): houve confirmed_not_lead
// dentro da validade (TTL por tenant). Casa com a decisão da fatia 2 (estado-por-histórico).
async function _presignalActive(tenantId, phone, ttlDays) {
  const keys = phone ? telBR.matchKeys(phone) : [];
  if (!keys.length) return false;
  const days = Number.isInteger(ttlDays) && ttlDays > 0 ? ttlDays : 30;
  try {
    const r = await withTenant(tenantId, (c) => c.query(
      `SELECT 1 FROM leads
        WHERE tenant_id = $1
          AND review_result = 'confirmed_not_lead'
          AND review_em > now() - ($3 || ' days')::interval
          AND regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = ANY($2::text[])
        LIMIT 1`,
      [tenantId, keys, String(days)]));
    return r.rowCount > 0;
  } catch { return false; }
}

// SALVAGUARDA do rescue (backtest 2026-07-24): o gate de ENTRADA existe p/ impedir lead de NASCER
// errado — NÃO p/ matar lead que a recepção JÁ trabalha. Se o contato tem lead em FUNIL ATIVO
// (QUALIFYING/QUALIFIED/EXPERIMENTAL_AGENDADA, desfecho NULL), o rescue nunca descarta; a saída de
// funil ativo é humano ou a re-avaliação por sinal (077), nunca o gate. NEW (intake) e terminais
// (CONVERTED/WON/perdido/desfecho≠NULL) ficam FORA da guarda. Casa por matchKeys BR-aware.
const _FUNIL_ATIVO_GUARD = ['QUALIFYING', 'QUALIFIED', 'EXPERIMENTAL_AGENDADA'];
async function _leadEmFunilAtivo(tenantId, phone) {
  const keys = phone ? telBR.matchKeys(phone) : [];
  if (!keys.length) return false;
  try {
    const r = await withTenant(tenantId, (c) => c.query(
      `SELECT 1 FROM leads
        WHERE tenant_id = $1 AND desfecho IS NULL AND status = ANY($3::text[])
          AND regexp_replace(coalesce(phone, meta_psid, ''), '[^0-9]', '', 'g') = ANY($2::text[])
        LIMIT 1`,
      [tenantId, keys, _FUNIL_ATIVO_GUARD]));
    return r.rowCount > 0;
  } catch { return false; }   // falha → não bloqueia (conservador: segue a decisão do rescue)
}

// Decisão do gate SEM agir: { hard, presignal, roleId, roleKey }. Papel 'hard' tem
// precedência; senão 'presignal' (papel explícito OU histórico dentro do TTL).
async function _evaluateGateSuppression(tenantId, phone, cfg) {
  const role = await _lookupRole(tenantId, phone);
  if (role && role.suppression === 'hard') return { hard: true, presignal: false, roleId: role.role_id, roleKey: role.key };
  if (role && role.suppression === 'presignal') return { hard: false, presignal: true, roleId: role.role_id, roleKey: role.key };
  const presignal = await _presignalActive(tenantId, phone, cfg.ttlDays);
  return { hard: false, presignal, roleId: null, roleKey: null };
}

// Log do modo sombra (append-only). Retorna o id p/ preencher crivo_outcome pós-classify.
async function _shadowLog(tenantId, { phone, channel, wouldAction, roleId, reason, externalMessageId }) {
  try {
    const r = await withTenant(tenantId, (c) => c.query(
      `INSERT INTO gate_shadow_log (tenant_id, phone, channel, would_action, role_id, reason, external_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [tenantId, phone || null, channel || null, wouldAction, roleId || null, reason || null, externalMessageId || null]));
    return r.rows[0]?.id || null;
  } catch (e) { logger.warn('gate0.shadow_log_failed', { tenant_id: tenantId, error: e.message }); return null; }
}

async function _shadowOutcome(tenantId, shadowId, crivoOutcome) {
  if (!shadowId || !['lead', 'not_lead'].includes(crivoOutcome)) return;
  try {
    await withTenant(tenantId, (c) => c.query(
      'UPDATE gate_shadow_log SET crivo_outcome = $2 WHERE id = $1', [shadowId, crivoOutcome]));
  } catch (e) { logger.warn('gate0.shadow_outcome_failed', { tenant_id: tenantId, error: e.message }); }
}

// GÊMEO de routes/tenant.js::_aplicarMoverEtapa — move de etapa SEM cliente HTTP (fluxo ao vivo/backfill).
// Roda no client `c` de uma transação withTenant JÁ aberta. NÃO pode requerer routes (ciclo), então
// replica a mecânica mínima do move canônico: mesma partição (stages.stageOfLead), mesmas transições
// (stages.KANBAN_TRANSICOES), mesmos UPDATEs de status/desfecho por destino, mesmo evento 'mudanca_etapa'.
// O itest prova a equivalência de transição. Grava o SNAPSHOT do estado anterior em stage_autoapply_log
// (o REVERTER do Monitor restaura EXATO, igual ao Undo de /sugestao-etapa/restaurar). Retorna
// {applied} | {invalid} | {terminal}. NÃO limpa suggested_stage_dismissed (respeita dispensa anterior).
async function _autoAplicarEtapa(c, { tenantId, leadId, destCol, reasoning, source, externalMessageId }) {
  const lead = (await c.query(
    'SELECT status, desfecho, desfecho_em FROM leads WHERE id = $1', [leadId])).rows[0];
  if (!lead) return { notFound: true };
  // Trava dura: nunca move sozinho um lead terminal/descartado (carimbo/desfecho é decisão de gente).
  if (lead.desfecho != null || ['NOT_LEAD', 'REVIEW_QUEUE'].includes(String(lead.status || '').toUpperCase())) {
    return { terminal: true };
  }
  const origem = stages.stageOfLead(lead);
  if (origem === destCol) return { terminal: true };                       // já está lá (nada a mover)
  if (!(stages.KANBAN_TRANSICOES[origem] || []).includes(destCol)) return { invalid: true, origem };
  // UPDATE de status por destino — espelho EXATO dos ramos de _aplicarMoverEtapa (não-terminais zeram
  // desfecho; 'convertido' grava matriculado). 'perdido' nunca é auto (exige motivo) → não cai aqui.
  if (destCol === 'qualificando') await c.query("UPDATE leads SET status='QUALIFYING', desfecho=NULL, desfecho_em=NULL, updated_at=now() WHERE id=$1", [leadId]);
  else if (destCol === 'qualificado') await c.query("UPDATE leads SET status='QUALIFIED', desfecho=NULL, desfecho_em=NULL, updated_at=now() WHERE id=$1", [leadId]);
  else if (destCol === 'experimental') await c.query("UPDATE leads SET status='EXPERIMENTAL_AGENDADA', desfecho=NULL, desfecho_em=NULL, updated_at=now() WHERE id=$1", [leadId]);
  else if (destCol === 'convertido') await c.query("UPDATE leads SET status='CONVERTED', desfecho='matriculado', desfecho_em=now(), updated_at=now() WHERE id=$1", [leadId]);
  else return { invalid: true, origem };
  const conteudo = `movido para ${destCol} — sugestão da IA aplicada automaticamente`;
  const evento = (await c.query(
    `INSERT INTO lead_eventos (tenant_id, lead_id, tipo, autor, conteudo, etapa_key)
     VALUES ($1, $2, 'mudanca_etapa', 'ia_auto', $3, $4) RETURNING id`,
    [tenantId, leadId, conteudo, destCol])).rows[0];
  // A sugestão foi RESOLVIDA pelo próprio move → limpa (não fica pendente no badge).
  await c.query(
    'UPDATE leads SET suggested_stage = NULL, stage_reasoning = NULL, stage_suggested_at = NULL WHERE id = $1',
    [leadId]);
  await c.query(
    `INSERT INTO stage_autoapply_log
       (tenant_id, lead_id, from_stage, to_stage, reasoning, source, external_message_id,
        prior_status, prior_desfecho, prior_desfecho_em, evento_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [tenantId, leadId, origem, destCol, reasoning || null, source || 'event', externalMessageId || null,
     lead.status, lead.desfecho, lead.desfecho_em, evento.id]);
  return { applied: true, from: origem, evento_id: evento.id };
}

// ADR sugestão-de-etapa — persiste a sugestão da IA com as DUAS travas: (1) nunca sugerir a etapa em
// que o lead JÁ está; (2) não re-sugerir uma etapa que a recepção já dispensou. Se o tenant tem
// APLICAÇÃO AUTOMÁTICA ligada (stage_autoapply_mode='on') E a etapa está na lista elegível (078),
// APLICA no evento (via _autoAplicarEtapa, auditável+revertível no Monitor); senão fica suggestion-only
// como antes. 'convertido' fica de fora por padrão. Tudo em UMA transação. Best-effort (nunca lança).
async function persistStageSuggestion(tenantId, leadId, suggestedStage, stageReasoning) {
  if (!leadId || !suggestedStage) return;
  try {
    await withTenant(tenantId, async (c) => {
      const row = (await c.query(
        'SELECT status, desfecho, suggested_stage_dismissed FROM leads WHERE id = $1', [leadId]
      )).rows[0];
      if (!row) return;
      const atual = kanbanColuna(row.status, row.desfecho);
      // Já está na etapa sugerida, ou foi exatamente essa que a recepção dispensou → não sugere.
      if (suggestedStage === atual || suggestedStage === row.suggested_stage_dismissed) return;
      await c.query(
        `UPDATE leads SET suggested_stage = $2, stage_reasoning = $3, stage_suggested_at = now()
          WHERE id = $1`,
        [leadId, suggestedStage, stageReasoning || null]
      );
      // Aplicação automática (config por-tenant). Lê mode+lista na MESMA transação. Fora do 'on' ou
      // fora da lista → nada move (suggestion-only). Transição inválida/terminal → deixa pra recepção.
      const cfg = (await c.query(
        'SELECT stage_autoapply_mode, stage_autoapply_stages FROM tenant_lead_config WHERE tenant_id = $1',
        [tenantId])).rows[0];
      const allowed = Array.isArray(cfg?.stage_autoapply_stages) ? cfg.stage_autoapply_stages : [];
      if (cfg?.stage_autoapply_mode === 'on' && allowed.includes(suggestedStage)) {
        const r = await _autoAplicarEtapa(c, {
          tenantId, leadId, destCol: suggestedStage, reasoning: stageReasoning, source: 'event',
        });
        if (r.applied) logger.info('stage.autoapplied', { tenant_id: tenantId, lead_id: leadId, from: r.from, to: suggestedStage });
      }
    });
  } catch (e) {
    logger.warn('stage.suggestion_persist_failed', { tenant_id: tenantId, lead_id: leadId, error: e.message });
  }
}

// ADR-016 — params de mídia da mensagem (4 colunas), na ordem do INSERT.
function _mediaCols(msg) {
  const m = (msg && msg.media) || null;
  return [m && m.url || null, m && m.type || null, m && m.filename || null, m && m.transcription || null];
}

// LGPD — versão do texto registrada no consent_records (consentimento implícito
// no 1º contato). O rodapé de opt-out foi REMOVIDO das mensagens de leads (conversa
// humana aprovada pela recepção); permanece só nos avisos automáticos do Scheduler.
const CONSENT_VERSION = 'optout-footer-v1';

const QUAL_FIELDS = ['name', 'instrument', 'availability'];
const FIELD_LABELS = {
  name: 'seu nome',
  instrument: 'o instrumento de interesse',
  availability: 'a disponibilidade de horário',
};

/**
 * Mescla a extração da IA com a qualificação já armazenada, aplicando a regra
 * "repergunta única antes de marcar como unclear" (E1-03).
 *  - valor concreto -> grava.
 *  - ambíguo e ainda não reperguntado -> pede esclarecimento e marca reasked.
 *  - ambíguo e já reperguntado -> marca 'unclear' (terminal).
 * qualification_complete = os 3 campos com valor concreto (≠ null/unclear).
 */
function mergeQualification(stored, extraction) {
  const values = {
    name: stored?.name ?? null,
    instrument: stored?.instrument ?? null,
    availability: stored?.availability ?? null,
  };
  const reasked = new Set(stored?.reasked || []);
  const clarify = [];

  for (const f of QUAL_FIELDS) {
    if (values[f] && values[f] !== 'unclear') continue; // já conhecido
    const val = extraction?.[f];
    if (val) {
      values[f] = String(val);
      reasked.delete(f);
    } else if (extraction?.ambiguous?.includes(f)) {
      if (reasked.has(f)) values[f] = 'unclear';
      else {
        reasked.add(f);
        clarify.push(f);
      }
    }
  }

  const complete = QUAL_FIELDS.every((f) => values[f] && values[f] !== 'unclear');
  return { values, reasked: [...reasked], clarify, complete };
}

// Conversa REAL mesclada pra a IA gerar com contexto verdadeiro (não só o que passou
// pelo funil): entrada do LEAD (messages USER) + respostas REAIS da recepção
// (staff_outbound_samples fromMe, exclui grupos @g.us) + respostas da IA já
// aprovadas/enviadas (pending_approvals APPROVED/EDITED). Lead -> USER; escola -> ASSISTANT.
// Sem cache: as respostas da recepção não passam por invalidação de cache.
async function loadRealHistory(tenantId, { conversationId, ident, leadId }) {
  const rows = await withTenant(tenantId, (c) =>
    c
      .query(
        `SELECT role, content, received_at FROM (
           -- Áudio: usa a transcrição como conteúdo (a IA "ouve" o que foi dito).
           SELECT m.received_at, 'USER' AS role,
                  CASE WHEN m.media_type = 'audio' AND m.media_transcription IS NOT NULL
                       THEN m.media_transcription ELSE m.body END AS content
             FROM messages m
            WHERE m.conversation_id = $1 AND m.role = 'USER'
              AND coalesce(m.media_transcription, m.body) IS NOT NULL
           UNION ALL
           SELECT s.received_at, 'ASSISTANT' AS role, s.body AS content
             FROM staff_outbound_samples s
            WHERE s.tenant_id = $2 AND $3 <> ''
              AND regexp_replace(s.external_id, '[^0-9]', '', 'g') = $3
              AND coalesce(s.raw->'data'->'key'->>'remoteJid', '') NOT LIKE '%@g.us'
              AND s.body IS NOT NULL
           UNION ALL
           SELECT pa.created_at, 'ASSISTANT' AS role, pa.suggested_response AS content
             FROM pending_approvals pa
            WHERE pa.tenant_id = $2 AND pa.lead_id = $4
              AND pa.status IN ('APPROVED', 'EDITED') AND pa.suggested_response IS NOT NULL
         ) t
         ORDER BY received_at ASC`,
        [conversationId, tenantId, ident, leadId]
      )
      .then((r) => r.rows)
  );
  // `at` (timestamp) acompanha cada turno para a IA decidir se é retomada após
  // intervalo longo (saudação/apresentação permitidas) ou conversa em andamento.
  return rows.map((r) => ({ role: r.role, content: r.content, at: r.received_at }));
}

// F — captura do inbound mesmo quando NÃO vira lead (NOT_LEAD ou erro de triagem), pra
// o histórico do thread ficar completo. Grava só a conversa + a mensagem do lead (sem
// criar lead nem rascunho). Idempotente por external_message_id. Best-effort: nunca lança.
async function captureInboundOnly(tenantId, channel, externalId, msg, rawBody) {
  if (!externalId || !msg.body) return;
  try {
    await withTenant(tenantId, async (c) => {
      const conv = (
        await c.query(
          `INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, channel, external_id) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [tenantId, channel, externalId]
        )
      ).rows[0];
      await c.query(
        `INSERT INTO messages
           (tenant_id, conversation_id, direction, role, external_message_id, sender, body, raw,
            media_url, media_type, media_filename, media_transcription)
         VALUES ($1, $2, 'inbound', 'USER', $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, external_message_id)
           WHERE external_message_id IS NOT NULL DO NOTHING`,
        [tenantId, conv.id, msg.externalMessageId, msg.sender, msg.body, rawBody, ..._mediaCols(msg)]
      );
    });
  } catch (e) {
    logger.warn('gate1.capture_inbound_failed', { tenant_id: tenantId, error: e.message });
  }
}

// ADR-042 (E14 / B1) — captura mensagem de GRUPO (jid @g.us). NÃO passa pelo funil de lead
// (grupo nunca é lead). Cria a conversa com kind='GROUP' e external_id = jid COMPLETO (com
// @g.us, distinto dos telefones 1:1). sender = pushName do participante (autor). Aditivo e
// isolado do 1:1. Best-effort. Dedup por (tenant, external_message_id).
async function captureGroupInbound(tenantId, jid, msg, rawBody) {
  if (!jid || !/@g\.us$/i.test(String(jid)) || !msg.body) return;
  try {
    await withTenant(tenantId, async (c) => {
      const conv = (await c.query(
        `INSERT INTO conversations (tenant_id, channel, external_id, conversation_kind)
         VALUES ($1, 'whatsapp', $2, 'GROUP')
         ON CONFLICT (tenant_id, channel, external_id) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [tenantId, jid]
      )).rows[0];
      await c.query(
        `INSERT INTO messages
           (tenant_id, conversation_id, direction, role, external_message_id, sender, body, raw,
            media_url, media_type, media_filename, media_transcription)
         VALUES ($1, $2, 'inbound', 'USER', $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, external_message_id)
           WHERE external_message_id IS NOT NULL DO NOTHING`,
        [tenantId, conv.id, msg.externalMessageId, msg.sender, msg.body, rawBody, ..._mediaCols(msg)]
      );
    });
  } catch (e) {
    logger.warn('group.capture_failed', { tenant_id: tenantId, error: e.message });
  }
}

// ADR-042/Meta — captura um COMENTÁRIO de post (IG/FB) como conversa da Caixa de Entrada,
// SEM triagem/lead/auto-reply (comentário público ≠ DM). Upsert da conversa (kind='COMMENT',
// channel instagram_comment/facebook_comment; external_id = id do autor) + message role='USER'
// (external_message_id = comment_id; raw guarda post_id/parent_id/media_id). Dedup por
// (tenant, external_message_id). Best-effort: nunca lança. Retorna o conversation_id (ou null).
async function captureComment(tenantId, { channel, externalId, commentId, sender, body }, rawComment) {
  if (!tenantId || !channel || !externalId || !commentId) return null;
  try {
    return await withTenant(tenantId, async (c) => {
      const conv = (await c.query(
        `INSERT INTO conversations (tenant_id, channel, external_id, conversation_kind)
         VALUES ($1, $2, $3, 'COMMENT')
         ON CONFLICT (tenant_id, channel, external_id) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [tenantId, channel, String(externalId)]
      )).rows[0];
      await c.query(
        `INSERT INTO messages
           (tenant_id, conversation_id, direction, role, external_message_id, sender, body, raw)
         VALUES ($1, $2, 'inbound', 'USER', $3, $4, $5, $6)
         ON CONFLICT (tenant_id, external_message_id)
           WHERE external_message_id IS NOT NULL DO NOTHING`,
        [tenantId, conv.id, String(commentId), sender || null, body || '', rawComment || {}]
      );
      return conv.id;
    });
  } catch (e) {
    logger.warn('comment.capture_failed', { tenant_id: tenantId, channel, error: e.message });
    return null;
  }
}

// ADR-019 — captura uma mensagem DESCARTADA (gate0) sem criar lead. Upsert da
// conversa + message com discarded=true. Best-effort. Alimenta "Não classificadas".
async function captureDiscarded(tenantId, channel, externalId, msg, rawBody, reason) {
  if (!externalId || !msg.body) return;
  try {
    await withTenant(tenantId, async (c) => {
      const conv = (
        await c.query(
          `INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, channel, external_id) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [tenantId, channel, externalId]
        )
      ).rows[0];
      await c.query(
        `INSERT INTO messages
           (tenant_id, conversation_id, direction, role, external_message_id, sender, body, raw, discarded, discard_reason)
         VALUES ($1, $2, 'inbound', 'USER', $3, $4, $5, $6, true, $7)
         ON CONFLICT (tenant_id, external_message_id)
           WHERE external_message_id IS NOT NULL DO NOTHING`,
        [tenantId, conv.id, msg.externalMessageId, msg.sender, msg.body, rawBody, reason]
      );
    });
  } catch (e) {
    logger.warn('gate0.capture_discarded_failed', { tenant_id: tenantId, error: e.message });
  }
}

// Bloco 2 — captura do inbound E cria o lead na FILA DE REVISÃO (não entra no funil).
// `reviewStatus` = 'REVIEW_QUEUE' (médio) ou 'NOT_LEAD' (baixo). Grava os campos de
// classificação + review_queue=true. Idempotente. Best-effort: nunca lança.
async function captureForReview(tenantId, channel, externalId, msg, rawBody, cls, reviewStatus) {
  if (!externalId || !msg.body) return null;
  const psid = msg.psid || null;
  const phone = psid ? null : externalId;
  try {
    return await withTenant(tenantId, async (c) => {
      // Upsert do lead pela identidade do canal (espelha o PORTÃO 2), com status de revisão.
      let lead;
      if (psid) {
        lead = await c.query(
          `INSERT INTO leads (tenant_id, name, status, meta_psid, review_queue,
                              classification_confidence, classification_reasoning, classification_signals)
           VALUES ($1, $2, $3, $4, true, $5, $6, $7)
           ON CONFLICT (tenant_id, meta_psid) WHERE meta_psid IS NOT NULL
           DO UPDATE SET classification_confidence = EXCLUDED.classification_confidence,
                         classification_reasoning = EXCLUDED.classification_reasoning,
                         classification_signals = EXCLUDED.classification_signals,
                         updated_at = now()
           RETURNING id`,
          [tenantId, msg.sender || externalId, reviewStatus, externalId,
           cls.confidence, cls.reasoning, JSON.stringify(cls.profile_signals || [])]
        );
      } else {
        lead = await c.query(
          `INSERT INTO leads (tenant_id, name, phone, status, review_queue,
                              classification_confidence, classification_reasoning, classification_signals)
           VALUES ($1, $2, $3, $4, true, $5, $6, $7)
           ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL
           DO UPDATE SET classification_confidence = EXCLUDED.classification_confidence,
                         classification_reasoning = EXCLUDED.classification_reasoning,
                         classification_signals = EXCLUDED.classification_signals,
                         updated_at = now()
           RETURNING id`,
          [tenantId, msg.sender || phone, phone, reviewStatus,
           cls.confidence, cls.reasoning, JSON.stringify(cls.profile_signals || [])]
        );
      }
      const conv = (
        await c.query(
          `INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, channel, external_id) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [tenantId, channel, externalId]
        )
      ).rows[0];
      await c.query(
        `INSERT INTO messages
           (tenant_id, conversation_id, direction, role, external_message_id, sender, body, raw,
            media_url, media_type, media_filename, media_transcription)
         VALUES ($1, $2, 'inbound', 'USER', $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, external_message_id)
           WHERE external_message_id IS NOT NULL DO NOTHING`,
        [tenantId, conv.id, msg.externalMessageId, msg.sender, msg.body, rawBody, ..._mediaCols(msg)]
      );
      return lead.rows[0].id;
    });
  } catch (e) {
    logger.warn('gate1.capture_for_review_failed', { tenant_id: tenantId, error: e.message });
    return null;
  }
}

// ROTEAMENTO VIVO — CONTATO DE RELACIONAMENTO (genérico, multi-tenant): pessoa com vínculo
// existente que NUNCA deve auto-entrar no funil mesmo parecendo oportunidade — precisa de
// confirmação humana (classifyConversa → Revisar). Distinto do gate DURO de staff
// (internal_contacts), que descarta de vez. Cada tenant define sua fonte de contatos de
// relacionamento; no ADR o valor é PROFESSOR (telefone ∈ app.professor_notificacao, schema
// do Scheduler, READ-only cross-schema — grant em db/grants/professor_notificacao_read.sql).
// Best-effort: falha de leitura → trata como NÃO-relacionamento (o default-seguro de dúvida
// já cobre os demais intents; só a NOVA_OPORTUNIDADE depende deste sinal).
async function _isRelationshipContact(identDigits) {
  if (!identDigits) return false;
  // Match BR-aware (telBR.matchKeys), IDÊNTICO aos lookups de opt-out (gate0.opted_out) e de
  // dedup (findByPhone) deste arquivo: o lead chega com DDI 55 (ex.: 5519994301015) e o cadastro
  // guarda sem 55 (ex.: 19994301015) — a igualdade EXATA de dígitos deixava o professor escapar
  // e virar lead. matchKeys faz as duas formas (com/sem 55, com/sem 9º dígito) convergirem.
  const keys = telBR.matchKeys(identDigits);
  if (!keys.length) return false;
  try {
    // TODO(binding tenant↔franquia): franquia_id=1 cravado provisoriamente até a tabela de binding
    //   existir (ver DEBT-binding-tenant-franquia). Trocar por resolução via tenant.
    const r = await pool.query(
      `SELECT 1 FROM app.professor_notificacao
        WHERE regexp_replace(coalesce(telefone_override, telefone), '[^0-9]', '', 'g') = ANY($1::text[])
          AND franquia_id = 1
        LIMIT 1`,
      [keys]
    );
    return r.rowCount > 0;
  } catch (e) {
    logger.warn('estab.relationship_lookup_failed', { error: e.message });
    return false;
  }
}

// Retry/backoff curto p/ o classifyConversa no ingest (429 do flash é transitório).
// Bounded de propósito: roda depois do webhook já ter respondido 200, mas não pode
// prender o processamento. Esgotou as tentativas → lança (o chamador manda pra Revisar).
async function _classifyConversaRetry(classifyConversa, args) {
  let last;
  for (let i = 0; i < 3; i += 1) {
    try { return await classifyConversa(args); }
    catch (e) { last = e; await new Promise((s) => setTimeout(s, 800 * (i + 1))); }
  }
  throw last;
}

// ============================================================================
// RESILIÊNCIA A 503/timeout NO PORTÃO 1 (contato novo) — buffer "aguardando
// classificação". Causa confirmada (Gabriel/Osvaldo): a falha de IA no Portão 1
// (single-message, SEM retry nem rede) engolia a mensagem-chave. Aqui o contato
// novo ganha a MESMA resiliência da conversa estabelecida: retry imediato →
// buffer visível e reprocessável pela CONVERSA INTEIRA → Revisar+alerta no
// esgotamento. NUNCA reclassifica single-message (foi o thread completo que
// classificou o Osvaldo certo; single-message recriaria o erro do Gabriel).
// ============================================================================
const PENDING_CLASSIFICATION_WINDOW_MS = 15 * 60 * 1000;   // janela do buffer (decisão: 15min)

// Erro TRANSITÓRIO de IA (vale retry/buffer): 503/429/5xx, "high demand"/overloaded,
// timeout e falhas de rede. Erro de CONTRATO (JSON malformado etc.) NÃO entra — não
// adianta reprocessar a mesma falha determinística; segue o caminho antigo (captura).
function _isTransientAIError(err) {
  return /\b(429|500|502|503|504)\b|service unavailable|high demand|overloaded|unavailable|timeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i.test(
    String(err?.message || err || '')
  );
}

// Retry imediato com backoff p/ o Portão 1 single-message (espelha _classifyConversaRetry).
// Resolve o spike curto (maioria dos 503). Só re-tenta erro transitório; o resto sobe na hora.
async function _classifyRetry(classify, args) {
  let last;
  for (let i = 0; i < 3; i += 1) {
    try { return await classify(args); }
    catch (e) {
      last = e;
      if (!_isTransientAIError(e)) throw e;
      await new Promise((s) => setTimeout(s, 800 * (i + 1)));
    }
  }
  throw last;
}

// Janela de 15min esgotada? (since nulo → trata como esgotada: vai pra Revisar.)
function _pendingWindowExpired(since) {
  if (!since) return true;
  return Date.now() - new Date(since).getTime() >= PENDING_CLASSIFICATION_WINDOW_MS;
}

// Lead deste contato que está no buffer "aguardando classificação" (por dígitos).
async function _loadPendingState(tenantId, ident) {
  if (!ident) return null;
  try {
    const r = await withTenant(tenantId, (c) => c.query(
      `SELECT id, classification_pending_since FROM leads
        WHERE tenant_id = $1 AND status = 'PENDING_CLASSIFICATION'
          AND regexp_replace(coalesce(phone, meta_psid, ''), '[^0-9]', '', 'g') = $2
        LIMIT 1`,
      [tenantId, ident]
    ));
    return r.rows[0] ? { leadId: r.rows[0].id, pendingSince: r.rows[0].classification_pending_since } : null;
  } catch { return null; }
}

// Coloca/mantém o lead no buffer "aguardando classificação" (status VISÍVEL, não
// NOT_LEAD nem limbo) e captura conversa+mensagem (mesmo padrão de captureForReview).
// GUARDA a decisão humana (review_result/desfecho) e NÃO rebaixa lead ATIVO do funil:
// só entra/permanece a partir de estados automáticos. pending_since só na 1ª vez
// (COALESCE) — a janela de 15min conta do PRIMEIRO erro, não de cada retentativa.
async function captureForPendingClassification(tenantId, channel, externalId, msg, rawBody, errMessage) {
  if (!externalId || !msg.body) return null;
  const psid = msg.psid || null;
  const phone = psid ? null : externalId;
  const guard =
    `leads.review_result IS NULL AND leads.desfecho IS NULL
     AND leads.status IN ('NEW','NOT_LEAD','REVIEW_QUEUE','PENDING_CLASSIFICATION')`;
  // Em conflito ($4 = errMessage nas duas variantes): transiciona pra PENDING só sob a
  // guarda; senão preserva o status atual (não rebaixa funil/decisão humana).
  const onConflictSet =
    `status = CASE WHEN ${guard} THEN 'PENDING_CLASSIFICATION' ELSE leads.status END,
     classification_pending_since = CASE WHEN ${guard}
        THEN COALESCE(leads.classification_pending_since, now()) ELSE leads.classification_pending_since END,
     classification_attempts = leads.classification_attempts + 1,
     classification_last_error = $4,
     updated_at = now()`;
  try {
    return await withTenant(tenantId, async (c) => {
      let lead;
      if (psid) {
        lead = await c.query(
          `INSERT INTO leads (tenant_id, name, status, meta_psid,
                              classification_pending_since, classification_attempts, classification_last_error)
           VALUES ($1, $2, 'PENDING_CLASSIFICATION', $3, now(), 1, $4)
           ON CONFLICT (tenant_id, meta_psid) WHERE meta_psid IS NOT NULL
           DO UPDATE SET ${onConflictSet}
           RETURNING id`,
          [tenantId, msg.sender || externalId, externalId, errMessage || null]
        );
      } else {
        lead = await c.query(
          `INSERT INTO leads (tenant_id, name, phone, status,
                              classification_pending_since, classification_attempts, classification_last_error)
           VALUES ($1, $2, $3, 'PENDING_CLASSIFICATION', now(), 1, $4)
           ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL
           DO UPDATE SET ${onConflictSet}
           RETURNING id`,
          [tenantId, msg.sender || phone, phone, errMessage || null]
        );
      }
      const conv = (
        await c.query(
          `INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, channel, external_id) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [tenantId, channel, externalId]
        )
      ).rows[0];
      await c.query(
        `INSERT INTO messages
           (tenant_id, conversation_id, direction, role, external_message_id, sender, body, raw,
            media_url, media_type, media_filename, media_transcription)
         VALUES ($1, $2, 'inbound', 'USER', $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, external_message_id)
           WHERE external_message_id IS NOT NULL DO NOTHING`,
        [tenantId, conv.id, msg.externalMessageId, msg.sender, msg.body, rawBody, ..._mediaCols(msg)]
      );
      return lead.rows[0].id;
    });
  } catch (e) {
    logger.warn('gate1.capture_pending_failed', { tenant_id: tenantId, error: e.message });
    return null;
  }
}

// Decisão de roteamento a partir do resultado do classifyConversa (conversa inteira).
// PURA (não toca DB). Retorna { cls } (cai no funil/Portão 2, com rascunho) ou { route }
// (roteia pra fora do funil). Compartilhada pelo caminho VIVO (conversa estabelecida) e
// pela RECLASSIFICAÇÃO do buffer (job/evento) — uma única lógica, provada pelo Osvaldo.
function _decideConversaRoute(r, isRelationship) {
  const estado = { conversation_state: r.conversation_state, state_reasoning: r.state_reasoning };
  const sugEtapa = r.is_lead ? r.suggested_stage : null;
  const sugMotivo = r.is_lead ? r.stage_reasoning : null;
  if (r.intent === 'NOVA_OPORTUNIDADE') {
    if (isRelationship) {
      // contato de relacionamento NUNCA auto-funil: oportunidade aparente → confirmação humana.
      return { route: { status: 'REVIEW_QUEUE', reviewQueue: true, intent: 'RELACIONAMENTO_OPORTUNIDADE',
        reasoning: '[vivo] contato de relacionamento com sinal de oportunidade — Revisar', confidence: r.confidence, ...estado } };
    }
    if (r.conversation_state === 'RESOLVIDO' || r.conversation_state === 'AGUARDANDO_CLIENTE') {
      // RESOLVIDO/AGUARDANDO_CLIENTE não precisam de resposta agora: funil SEM rascunho.
      return { route: { status: 'QUALIFYING', reviewQueue: false, intent: r.intent,
        reasoning: `[vivo] ${r.reasoning || (r.conversation_state === 'RESOLVIDO' ? 'oportunidade resolvida' : 'aguardando cliente')}`,
        confidence: r.confidence, suggested_stage: sugEtapa, stage_reasoning: sugMotivo, ...estado } };
    }
    // funil: cai no Portão 2 (auto-promove + rascunho).
    return { cls: { confidence: r.confidence, reasoning: `[vivo] ${r.reasoning || 'nova oportunidade'}`,
      profile_signals: [r.intent], is_lead: true, suggested_stage: sugEtapa, stage_reasoning: sugMotivo, ...estado } };
  }
  if (r.intent === 'CANDIDATO') {
    // Candidato a VAGA de trabalho (quer DAR aula, não estudar/contratar) → Descartados,
    // com rótulo "Candidato a vaga". Mesma forma do não-lead claro (NOT_LEAD, reviewável).
    return { route: { status: 'NOT_LEAD', reviewQueue: true, intent: 'CANDIDATO',
      reasoning: `[vivo] candidato a vaga — ${r.reasoning || 'quer trabalhar/dar aula'}`, confidence: r.confidence, ...estado } };
  }
  if (r.intent === 'ROTINA_CLIENTE' || r.intent === 'INTERNO') {
    // não-lead CLARO → não-classificadas (rede reviewável).
    return { route: { status: 'NOT_LEAD', reviewQueue: true, intent: r.intent,
      reasoning: `[vivo] ${r.reasoning || r.intent}`, confidence: r.confidence, ...estado } };
  }
  // INDEFINIDO → Revisar.
  return { route: { status: 'REVIEW_QUEUE', reviewQueue: true, intent: 'INDEFINIDO',
    reasoning: `[vivo] ${r.reasoning || 'indefinido'}`, confidence: r.confidence, ...estado } };
}

// Resolve um lead que está no buffer para o status decidido (funil/NOT_LEAD/Revisar),
// limpando o buffer. Guarda a decisão humana e SÓ age sobre lead ainda PENDING
// (idempotente vs. o caminho por evento). Retorna true se efetivou. NÃO insere
// mensagem (o job não tem mensagem nova — só reclassifica o thread acumulado).
async function _resolvePendingTo(tenantId, leadId, route) {
  try {
    const r = await withTenant(tenantId, (c) => c.query(
      `UPDATE leads SET
         status = CASE WHEN review_result IS NULL AND desfecho IS NULL THEN $2 ELSE status END,
         review_queue = CASE WHEN review_result IS NULL AND desfecho IS NULL THEN $3 ELSE review_queue END,
         classification_confidence = $4,
         classification_reasoning = $5,
         classification_signals = $6,
         conversation_state = COALESCE($7, conversation_state),
         state_reasoning = COALESCE($8, state_reasoning),
         state_computed_at = CASE WHEN $7 IS NOT NULL THEN now() ELSE state_computed_at END,
         classification_pending_since = NULL,
         classification_attempts = 0,
         classification_last_error = NULL,
         updated_at = now()
       WHERE id = $1 AND status = 'PENDING_CLASSIFICATION'
       RETURNING id`,
      [leadId, route.status, route.reviewQueue, route.confidence,
       route.reasoning, JSON.stringify([route.intent].filter(Boolean)),
       route.conversation_state || null, route.state_reasoning || null]
    ));
    return r.rowCount > 0;
  } catch (e) {
    logger.warn('pending.resolve_failed', { tenant_id: tenantId, lead_id: leadId, error: e.message });
    return false;
  }
}

// Reprocessa UM lead do buffer pela CONVERSA INTEIRA (gatilho por TEMPO, via job).
// O gatilho por EVENTO (nova mensagem) é tratado no processInbound (bloco da conversa
// estabelecida, que o pendingState passa a alcançar). Sucesso → resolve. Falha dentro
// da janela → permanece (silencioso). Falha com janela esgotada → Revisar + ALERTA ativo.
async function reprocessPendingLead(tenant, leadRow, deps = {}) {
  const classifyConversa = deps.classifyConversa || gemini.classifyConversa;
  const notificar = deps.notificar || notificacao.notificarRecepcao;
  const tenantId = tenant.id;
  const ident = String(leadRow.phone || leadRow.meta_psid || '').replace(/\D/g, '');
  const log = logger.child({ tenant_id: tenantId, lead_id: leadRow.id, fn: 'reprocessPendingLead' });

  // Conversa inteira acumulada (o que classificou o Osvaldo certo) — SEM mensagem isolada.
  let conversation = [];
  try {
    const conv = await withTenant(tenantId, (c) => c.query(
      `SELECT id FROM conversations WHERE tenant_id = $1
         AND regexp_replace(external_id, '[^0-9]', '', 'g') = $2
       ORDER BY updated_at DESC LIMIT 1`,
      [tenantId, ident]
    ).then((rr) => rr.rows[0]));
    if (conv) conversation = await loadRealHistory(tenantId, { conversationId: conv.id, ident, leadId: leadRow.id });
  } catch (e) {
    log.warn('pending.history_error', { error: e.message });
  }

  const examples = await _fewShotExamples(tenantId);
  const { leadDefinition, stageDefinitions } = await _classifierConfig(tenantId);
  const isRelationship = await _isRelationshipContact(ident);

  let decision;
  try {
    const r = await _classifyConversaRetry(classifyConversa, {
      conversation, examples, stageDefinitions, leadDefinition, tenant: tenantId,
    });
    log.info('pending.classified', { intent: r.intent, is_lead: r.is_lead, state: r.conversation_state });
    decision = _decideConversaRoute(r, isRelationship);
  } catch (err) {
    if (!_pendingWindowExpired(leadRow.classification_pending_since)) {
      // ainda dentro da janela: registra a tentativa e permanece no buffer (silencioso).
      await withTenant(tenantId, (c) => c.query(
        `UPDATE leads SET classification_attempts = classification_attempts + 1,
                          classification_last_error = $2, updated_at = now()
          WHERE id = $1 AND status = 'PENDING_CLASSIFICATION'`,
        [leadRow.id, err.message]
      )).catch(() => {});
      log.info('pending.retained', { error: err.message });
      return { status: 'retained' };
    }
    // janela de 15min esgotada → Revisar + alerta ATIVO (classificação automática indisponível).
    const moved = await _resolvePendingTo(tenantId, leadRow.id, {
      status: 'REVIEW_QUEUE', reviewQueue: true, intent: 'ERRO',
      reasoning: '[buffer] classificação automática indisponível (15min) — enviado para Revisar', confidence: null,
    });
    if (moved) await notificar(tenantId, 'classificacao_indisponivel', { leadId: leadRow.id });
    log.warn('pending.expired_to_review', { error: err.message });
    return { status: 'expired_to_review' };
  }

  // Sucesso → materializa a decisão (sem rascunho; o draft sai no próximo inbound/fluxo vivo).
  const route = decision.route || {
    status: 'QUALIFYING', reviewQueue: false, intent: 'NOVA_OPORTUNIDADE',
    reasoning: decision.cls.reasoning, confidence: decision.cls.confidence,
    suggested_stage: decision.cls.suggested_stage, stage_reasoning: decision.cls.stage_reasoning,
    conversation_state: decision.cls.conversation_state, state_reasoning: decision.cls.state_reasoning,
  };
  const moved = await _resolvePendingTo(tenantId, leadRow.id, route);
  if (moved && route.status === 'QUALIFYING' && route.suggested_stage) {
    await persistStageSuggestion(tenantId, leadRow.id, route.suggested_stage, route.stage_reasoning);
  }
  if (moved && route.status === 'REVIEW_QUEUE') await notificar(tenantId, 'revisao', { leadId: leadRow.id });
  log.info('pending.resolved', { to: route.status });
  return { status: 'resolved', to: route.status };
}

// ROTEAMENTO VIVO — captura a mensagem e roteia um lead de conversa ESTABELECIDA para
// FORA do funil (NOT_LEAD = não-classificadas reviewável | REVIEW_QUEUE = Revisar), SEM
// gerar resposta nem promover. Em lead já existente, só muda o status quando NÃO há
// decisão humana (review_result) nem desfecho — preserva o que a recepção/desfecho fixou.
// Idempotente. Best-effort: nunca lança. Retorna o leadId (p/ notificação) ou null.
async function captureRoutedEstablished(tenantId, channel, externalId, msg, rawBody, route) {
  if (!externalId || !msg.body) return null;
  const psid = msg.psid || null;
  const phone = psid ? null : externalId;
  const signals = JSON.stringify([route.intent].filter(Boolean));
  // Em conflito, status/review_queue só mudam se o lead não tiver decisão humana/desfecho.
  // O estado da conversa (observação da IA) é sempre atualizado.
  const onConflictSet =
    `status = CASE WHEN leads.review_result IS NULL AND leads.desfecho IS NULL THEN EXCLUDED.status ELSE leads.status END,
     review_queue = CASE WHEN leads.review_result IS NULL AND leads.desfecho IS NULL THEN EXCLUDED.review_queue ELSE leads.review_queue END,
     classification_confidence = EXCLUDED.classification_confidence,
     classification_reasoning = EXCLUDED.classification_reasoning,
     classification_signals = EXCLUDED.classification_signals,
     conversation_state = EXCLUDED.conversation_state,
     state_reasoning = EXCLUDED.state_reasoning,
     state_computed_at = now(),
     classification_pending_since = NULL,
     classification_attempts = 0,
     classification_last_error = NULL,
     updated_at = now()`;
  try {
    return await withTenant(tenantId, async (c) => {
      let lead;
      if (psid) {
        lead = await c.query(
          `INSERT INTO leads (tenant_id, name, status, meta_psid, review_queue,
                              classification_confidence, classification_reasoning, classification_signals,
                              conversation_state, state_reasoning, state_computed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
           ON CONFLICT (tenant_id, meta_psid) WHERE meta_psid IS NOT NULL
           DO UPDATE SET ${onConflictSet}
           RETURNING id`,
          [tenantId, msg.sender || externalId, route.status, externalId, route.reviewQueue,
           route.confidence, route.reasoning, signals, route.conversation_state || null, route.state_reasoning || null]
        );
      } else {
        lead = await c.query(
          `INSERT INTO leads (tenant_id, name, phone, status, review_queue,
                              classification_confidence, classification_reasoning, classification_signals,
                              conversation_state, state_reasoning, state_computed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
           ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL
           DO UPDATE SET ${onConflictSet}
           RETURNING id`,
          [tenantId, msg.sender || phone, phone, route.status, route.reviewQueue,
           route.confidence, route.reasoning, signals, route.conversation_state || null, route.state_reasoning || null]
        );
      }
      const conv = (
        await c.query(
          `INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, channel, external_id) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [tenantId, channel, externalId]
        )
      ).rows[0];
      await c.query(
        `INSERT INTO messages
           (tenant_id, conversation_id, direction, role, external_message_id, sender, body, raw,
            media_url, media_type, media_filename, media_transcription)
         VALUES ($1, $2, 'inbound', 'USER', $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, external_message_id)
           WHERE external_message_id IS NOT NULL DO NOTHING`,
        [tenantId, conv.id, msg.externalMessageId, msg.sender, msg.body, rawBody, ..._mediaCols(msg)]
      );
      return lead.rows[0].id;
    });
  } catch (e) {
    logger.warn('gate1.estab.route_failed', { tenant_id: tenantId, error: e.message });
    return null;
  }
}

// ============================================================================
// ADR-030 Passo 2 — ESTADO SEMÂNTICO DA BOLA (escrita da SAÍDA), fatia SHADOW.
// classificarSaida NÃO reusa processInbound (não cria lead/rascunho/notificação) e NÃO
// reescreve conversation_state em prod (o corte sincronizado vem depois da calibração).
// Só OBSERVA a saída da recepção e loga o estado/relógio SUGERIDOS em bola_shadow_log.
// ============================================================================

// Marco imutável do CICLO de posse ("desde quando a bola é nossa"). Preserva o valor já
// fixado (feature 'on'); em shadow, sugere o último inbound do cliente (estável durante
// todo o ciclo — não muda enquanto o cliente não escreve de novo). Fallback: created_at.
async function _posseDesde(tenantId, ident, lead) {
  if (lead.bola_nossa_desde) return lead.bola_nossa_desde;
  const r = await withTenant(tenantId, (c) => c.query(
    `SELECT max(m.received_at) AS last_in
       FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
      WHERE cv.tenant_id = $1
        AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = $2
        AND m.role = 'USER'`,
    [tenantId, ident]
  ).then((rr) => rr.rows[0]));
  return (r && r.last_in) || lead.created_at || null;
}

// Carrega a conversa INTEIRA (histórico real, incl. a saída recém-capturada como ASSISTANT)
// p/ a Camada 2. Mesmo loadRealHistory dos outros pontos.
async function _carregarConversaSaida(tenantId, ident, leadId) {
  const conv = await withTenant(tenantId, (c) => c.query(
    `SELECT id FROM conversations WHERE tenant_id = $1
       AND regexp_replace(external_id, '[^0-9]', '', 'g') = $2
     ORDER BY updated_at DESC LIMIT 1`,
    [tenantId, ident]
  ).then((r) => r.rows[0]));
  if (!conv) return [];
  return loadRealHistory(tenantId, { conversationId: conv.id, ident, leadId });
}

// Log do modo sombra da bola (append-only, molde do _shadowLog). Best-effort.
async function _shadowBola(tenantId, {
  leadId, sampleId, camada, veredito = null, confidence = null, reason = null,
  estadoAtual = null, estadoSugerido = null, bolaDesdeSug = null, adiamentosSug = null,
}) {
  try {
    await withTenant(tenantId, (c) => c.query(
      `INSERT INTO bola_shadow_log
         (tenant_id, lead_id, outbound_sample_id, camada, veredito, confidence, reason,
          estado_atual, estado_sugerido, bola_nossa_desde_sugerido, adiamentos_sugerido)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [tenantId, leadId || null, sampleId || null, camada, veredito, confidence,
       reason || null, estadoAtual || null, estadoSugerido || null, bolaDesdeSug || null, adiamentosSug]
    ));
  } catch (e) { logger.warn('bola.shadow_log_failed', { tenant_id: tenantId, error: e.message }); }
}

// Classifica UMA saída da recepção. Best-effort: nunca lança (o webhook já respondeu 200).
// mediaPendente = mídia (áudio) ainda sem transcrição → adia (classifica quando chegar).
// FLIP da bola (ADR-030 Fatia 0): escreve o conversation_state derivado da SAÍDA, RESPEITANDO
// override manual (revert da aba Bola) via proveniência (aplicar_scraping/070, entity_kind='lead').
// Sem trava → 'ESCREVE' → grava; travado por humano → 'IGUAL'/'DIVERGE' → NÃO grava (a bola
// respeita) e a divergência fica auditável. Devolve o veredito. NÃO toca o path INBOUND
// (classifyConversa) — um novo inbound é evento novo e pode re-derivar legitimamente.
async function _aplicarEstadoBola(tenantId, leadId, estado, reason, bolaDesde, adiamentos) {
  return withTenant(tenantId, async (c) => {
    const v = (await c.query(
      `SELECT lead_manager.aplicar_scraping('lead',$1,'conversation_state',$2,'bola') AS v`, [leadId, estado])).rows[0].v;
    if (v === 'ESCREVE') {
      await c.query(
        `UPDATE leads SET conversation_state=$2, state_reasoning=$3, state_computed_at=now(),
                bola_nossa_desde=$4, adiamentos=$5, updated_at=now() WHERE id=$1`,
        [leadId, estado, reason, bolaDesde, adiamentos]);
    }
    return v;
  });
}

async function classificarSaida(tenantId, { ident, sampleId, body, mediaPendente = false }, deps = {}) {
  const classifyConversa = deps.classifyConversa || gemini.classifyConversa;
  const log = logger.child({ tenant_id: tenantId, fn: 'classificarSaida' });
  try {
    if (!ident) return;
    // Modo por tenant (molde do gate): off = inerte; shadow/on só LOGAM neste pacote (a
    // escrita do conversation_state — 'on' de verdade — fica pra depois da calibração).
    const cfg = await withTenant(tenantId, (c) => c.query(
      'SELECT bola_mode FROM tenant_lead_config WHERE tenant_id = $1', [tenantId]
    ).then((r) => r.rows[0] || {}));
    const mode = ['off', 'shadow', 'on'].includes(cfg.bola_mode) ? cfg.bola_mode : 'off';
    if (mode === 'off') return;

    // Lead + estado atual + marco/contador de posse. Casa por dígitos (como nos outros
    // pontos). Sem lead → nada a rastrear.
    const lead = await withTenant(tenantId, (c) => c.query(
      `SELECT id, conversation_state, bola_nossa_desde, adiamentos, created_at
         FROM leads
        WHERE tenant_id = $1
          AND regexp_replace(coalesce(phone, meta_psid, ''), '[^0-9]', '', 'g') = $2
        LIMIT 1`,
      [tenantId, ident]
    ).then((r) => r.rows[0]));
    if (!lead) return;
    const estadoAtual = lead.conversation_state || null;

    // (a) SKIP: mídia sem transcrição (adia) | estado já NÃO-nosso (a bola já era do
    //     cliente; nossa saída não reabre — evita nos marcar como quem espera).
    if (mediaPendente) {
      return _shadowBola(tenantId, { leadId: lead.id, sampleId, camada: 'skip',
        reason: 'midia_sem_transcricao', estadoAtual });
    }
    if (estadoAtual === 'AGUARDANDO_CLIENTE' || estadoAtual === 'RESOLVIDO') {
      return _shadowBola(tenantId, { leadId: lead.id, sampleId, camada: 'skip',
        reason: 'estado_ja_nao_nosso', estadoAtual });
    }

    // (b) Camada 1 — gate determinístico. (c) AMBIGUO → Camada 2 (classifyConversa, Flash).
    let camada = 'gate', confidence = null, reason = null;
    let veredito = gateSaida(body);
    if (veredito === 'ambiguo') {
      camada = 'modelo_leve';
      let r;
      try {
        const conversation = await _carregarConversaSaida(tenantId, ident, lead.id);
        const examples = await _fewShotExamples(tenantId);
        const { leadDefinition, stageDefinitions } = await _classifierConfig(tenantId);
        r = await _classifyConversaRetry(classifyConversa, {
          conversation, examples, stageDefinitions, leadDefinition, tenant: tenantId,
        });
      } catch (e) {
        // CONSERVADOR (503/timeout do Gemini): NUNCA passa a bola no escuro → fica NOSSA.
        log.warn('bola.modelo_leve_erro', { error: e.message });
        r = { conversation_state: 'AGUARDANDO_RECEPCAO', state_reasoning: `erro IA: ${e.message}`, confidence: null };
      }
      confidence = r.confidence != null ? r.confidence : null; // GRAVADO p/ calibração, NÃO decide
      // Veredito pelo ESTADO que a IA devolveu — NUNCA por confidence: confidence é P(é lead),
      // não a certeza de com quem está a bola (perguntas diferentes; ADR-030 §ajuste). Conservador:
      // só AGUARDANDO_CLIENTE explícito passa a bola; qualquer outro (AGUARDANDO_RECEPCAO,
      // INDEFINIDO, RESOLVIDO ambíguo) fica conosco ("na dúvida, nossa").
      veredito = r.conversation_state === 'AGUARDANDO_CLIENTE' ? 'passou_bola' : 'enrolou';
      // reason carrega o estado bruto da IA (facilita a leitura na calibração dos ambíguos).
      reason = `ia:${r.conversation_state}${r.state_reasoning ? ' — ' + r.state_reasoning : ''}`;
    } else {
      reason = `gate:${veredito}`;
    }

    // Relógio + contador SUGERIDOS (em shadow só logam):
    //  - PASSOU_BOLA: encerra o ciclo (bola vira do cliente).
    //  - ENROLOU: bola segue nossa; marco PRESERVADO (imutável no ciclo); adiamento do ciclo
    //    = 1 (binário por posse — rajada de N "vou ver" = 1, não N: não incrementa enquanto
    //    já era nosso). Aqui cada linha carrega o valor do contador do ciclo (=1), não um +1
    //    por mensagem, então a rajada loga 1 em toda linha (não 1→2→3).
    let estadoSugerido, bolaDesdeSug, adiamentosSug;
    if (veredito === 'passou_bola') {
      estadoSugerido = 'AGUARDANDO_CLIENTE'; bolaDesdeSug = null; adiamentosSug = 0;
    } else {
      estadoSugerido = 'AGUARDANDO_RECEPCAO';
      bolaDesdeSug = await _posseDesde(tenantId, ident, lead);
      adiamentosSug = 1;
    }
    // FLIP: em 'on', a SAÍDA governa o conversation_state (respeitando override manual). Em
    // 'shadow' NÃO escreve (só loga). bola_shadow_log é gravado SEMPRE (a bola presta contas).
    let aplicado = null;
    if (mode === 'on') {
      aplicado = await _aplicarEstadoBola(tenantId, lead.id, estadoSugerido, reason, bolaDesdeSug, adiamentosSug);
    }
    await _shadowBola(tenantId, {
      leadId: lead.id, sampleId, camada, veredito, confidence, reason,
      estadoAtual, estadoSugerido, bolaDesdeSug, adiamentosSug,
    });
    log.info('bola.saida_classificada', { camada, veredito, estado_atual: estadoAtual, estado_sugerido: estadoSugerido, mode, aplicado });
  } catch (e) {
    log.warn('bola.classificar_error', { error: e.message });
  }
}

/**
 * Processa uma mensagem recebida pelo funil de triagem do ADR-003.
 * Idempotente, assíncrono e tolerante a falhas: qualquer erro é logado e
 * encerra o processamento sem lançar (o webhook já respondeu 200).
 *
 * deps injetáveis (testes): { classify, generate, classifyIntent, extract, notify, redis }.
 */
async function processInbound(tenant, msg, rawBody, deps = {}) {
  const classify = deps.classify || gemini.classify;
  const classifyConversa = deps.classifyConversa || gemini.classifyConversa;
  const classifyRescue = deps.classifyRescue || gemini.classifyRescue;   // rescue question do papel (Gate 0)
  const generate = deps.generate || gemini.generateReply;
  const classifyIntent = deps.classifyIntent || gemini.classifyIntent;
  const extract = deps.extract || gemini.extractQualification;
  const notify = deps.notify || notifyModule.notifyReceptionist;
  const notificar = deps.notificar || notificacao.notificarRecepcao;   // Bloco 4
  const redis = deps.redis || redisClient;

  const tenantId = tenant.id;
  // E5 — canal e identidade. WhatsApp/leadgen são identificados por TELEFONE;
  // DM da Meta (Messenger/IG) por PSID (sem telefone). Default = comportamento
  // original do WhatsApp (channel 'whatsapp', sem psid).
  const channel = msg.channel || 'whatsapp';
  const psid = msg.psid || null;
  // Escrita BR-aware (garante DDI 55) — o envio via Evolution e o fallback de 9º dígito
  // dependem do 55. Para número não-BR, comporta-se como o toE164 ingênuo.
  const phone = psid ? null : telBR.toE164BR(msg.phone || msg.externalId);
  const log = logger.child({ tenant_id: tenantId, channel, phone, psid });

  // -------- GATING DE ASSINATURA (E9-05): antes de qualquer custo --------
  // Só ACTIVE/TRIALING (válido) processam. GRACE/EXPIRED/SUSPENDED/ausente
  // são barrados aqui — não chama Gemini nem cria pending_approval.
  const sub = await gating.resolveStatus(tenantId, { redis });
  if (!gating.isAllowed(sub.verdict)) {
    log.info('gate.subscription_blocked', {
      reason: 'subscription_inactive',
      status: sub.verdict,
      db_status: sub.dbStatus ?? null,
      source: sub.source,
    });
    return;
  }

  // NB: NÃO há mais filtro por "contato conhecido". O critério de LEAD vs NOT_LEAD é o
  // CONTEXTO DA MENSAGEM (avaliado pela IA no Portão 1) — não se o número já existe no
  // banco. Um cliente atual pode querer um curso adicional ou perguntar por outra pessoa.

  // BUG2(2) — conversa estabelecida: se a recepção JÁ respondeu este contato
  // (existe staff_outbound, fora de grupos @g.us), é lead por definição. Pula o
  // Portão 1 pra não REBAIXAR (NOT_LEAD/REVIEW_QUEUE) uma conversa em andamento por
  // uma saudação isolada de baixo sinal. Gatilho FORTE e específico de propósito —
  // "inbound anterior" sozinho NÃO conta (pode ser ruído/spam).
  let conversaEstabelecida = false;
  {
    const idStaff = String(phone || psid || '').replace(/\D/g, '');
    if (idStaff) {
      const r = await withTenant(tenantId, (c) =>
        c.query(
          `SELECT 1 FROM staff_outbound_samples
             WHERE tenant_id = $1
               AND regexp_replace(external_id, '[^0-9]', '', 'g') = $2
               AND coalesce(raw->'data'->'key'->>'remoteJid', '') NOT LIKE '%@g.us'
             LIMIT 1`,
          [tenantId, idStaff]
        )
      );
      conversaEstabelecida = r.rowCount > 0;
    }
  }
  // ---- LGPD: lead que pediu opt-out NUNCA mais é processado/respondido ----
  // Casa por DÍGITOS BR-aware (matchKeys): um OPTED_OUT gravado em formato antigo
  // (pré-normalização) não pode escapar do bloqueio só por divergência de formato.
  const optKeys = phone ? telBR.matchKeys(phone) : [];
  const optedOut = optKeys.length ? await withTenant(tenantId, (c) =>
    c.query(
      `SELECT 1 FROM leads WHERE tenant_id = $1 AND status = 'OPTED_OUT'
         AND regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = ANY($2::text[])`,
      [tenantId, optKeys]
    )
  ) : { rowCount: 0 };
  if (optedOut.rowCount > 0) {
    log.info('gate0.opted_out', { gate: 0 });
    return;
  }

  // ---- ADR-018: contato interno (equipe/parceiro) nunca vira lead ----
  // Casa por DÍGITOS BR-aware (matchKeys), IDÊNTICO ao opt-out acima e a _isRelationshipContact:
  // um interno gravado em formato divergente (com/sem 55, com/sem 9º dígito) não pode escapar do
  // descarte só por diferença de formato.
  const intKeys = phone ? telBR.matchKeys(phone) : [];
  if (intKeys.length) {
    const interno = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT 1 FROM internal_contacts
          WHERE tenant_id = $1
            AND regexp_replace(phone, '[^0-9]', '', 'g') = ANY($2::text[])
          LIMIT 1`,
        [tenantId, intKeys]
      )
    );
    if (interno.rowCount > 0) {
      log.info('gate0.internal_contact', { gate: 0 });
      await captureDiscarded(tenantId, channel, phone, msg, rawBody, 'internal_contact');
      return;
    }
  }

  // ---- ADR-029 fatia 3: supressão por PAPEL (hard) + pré-sinalização. INERTE com mode='off'.
  // O caminho do internal_contacts acima fica intocado (generalização = futuro). Em 'shadow'
  // apenas REGISTRA o que faria; em 'on' age (hard descarta; presignal vira contexto do crivo
  // e roteia não-lead pro Revisar). Decisão sem agir = gate_shadow_log.
  const gateCfg = await _gateConfig(tenantId);
  let gatePresignal = false, gateShadowId = null;
  if (phone && gateCfg.mode !== 'off') {
    const sup = await _evaluateGateSuppression(tenantId, phone, gateCfg);
    if (sup.hard) {
      // WIRE do RESGATE (ADR-036 E1.4): papel supressor NÃO descarta cego. Pergunta a RESCUE
      // QUESTION do papel (config por tenant, role_lead_policy). resgata=true → MANTÉM (segue o
      // pipeline normal → crivo/funil, nunca descarte silencioso); resgata=false → descarta
      // ('role_hard'). Falha da IA ou papel sem critério → CONSERVADOR: mantém (não descarta).
      const policy = await getRescuePolicy(tenantId, sup.roleKey);
      // ── DOIS VEREDITOS lado a lado (shadow da rescue-com-conversa, flag rescue_conv_mode / migration 076) ──
      // (A) MESSAGE-ONLY: julga só a mensagem atual. É o driver da AÇÃO do gate HOJE (off/shadow) —
      //     comportamento de produção INTOCADO. Sempre computado quando há critério.
      // (B) CONVERSA: julga o histórico real + a mensagem atual (corrige o Jörg — um "Olá;" isolado
      //     engana a rescue; a rotina de responsável só se revela na conversa). Só computado em
      //     shadow/on → custo extra (1 chamada Gemini) apenas p/ contato de PAPEL hard, fração pequena.
      let msgResgata = true, msgMotivo = null, msgConf = null;
      let convResgata = null, convMotivo = null, convConf = null;
      if (policy.rescue_prompt) {
        try {
          const rqMsg = await classifyRescue({ message: msg.body, rescuePrompt: policy.rescue_prompt });
          msgResgata = rqMsg.resgata; msgMotivo = rqMsg.motivo; msgConf = rqMsg.confidence;
        } catch (e) { log.warn('gate0.rescue_failed', { gate: 0, role: sup.roleKey, error: e.message }); msgResgata = true; }
        if (gateCfg.rescueConvMode !== 'off') {
          try {
            const identRescue = String(phone || '').replace(/\D/g, '');
            const histRescue = identRescue ? await _carregarConversaSaida(tenantId, identRescue, null) : [];
            const convRescue = _rescueConversation(histRescue, msg.body);   // tail cap p/ custo
            const rqConv = await classifyRescue({ message: msg.body, conversation: convRescue, rescuePrompt: policy.rescue_prompt });
            convResgata = rqConv.resgata; convMotivo = rqConv.motivo; convConf = rqConv.confidence;
          } catch (e) { log.warn('gate0.rescue_conv_failed', { gate: 0, role: sup.roleKey, error: e.message }); convResgata = null; }
        }
      }
      // FLIP: só em rescue_conv_mode='on' a CONVERSA manda na ação; em off/shadow a ação segue o
      // message-only (produção atual). convResgata=null (não computado/falhou) → cai no message-only.
      let resgata = (gateCfg.rescueConvMode === 'on' && convResgata !== null) ? convResgata : msgResgata;
      // SALVAGUARDA funil ativo: nunca descarta lead vivo (recepção trabalhando). Só consulta quando
      // ia descartar (economia). Zera o falso-descarte grave do backtest (lead QUALIFIED/QUALIFYING).
      let funilAtivoGuard = false;
      if (!resgata) {
        funilAtivoGuard = await _leadEmFunilAtivo(tenantId, phone);
        if (funilAtivoGuard) resgata = true;   // força MANTER
      }
      const decisao = resgata ? 'keep' : 'discard';
      // AUDITORIA side-by-side (presta contas do shadow): TODA decisão vai pro gate_shadow_log — keep E
      // discard. `rescue:<ação real>` (backward-compat) + msg:/conv:/div: p/ responder "quantos
      // divergiram, quais contatos, qual motivo". div:Y = os dois vereditos DISCORDAM = o que o flip
      // mudaria (filtro do Monitor). Sem veredito-conversa (off/falha) → mantém o formato legado.
      const msgDec = msgResgata ? 'keep' : 'discard';
      const convDec = convResgata === null ? null : (convResgata ? 'keep' : 'discard');
      const reason = (convDec === null
        ? `role:${sup.roleKey || ''}|rescue:${decisao}${msgMotivo ? '|' + msgMotivo.slice(0, 100) : ''}`
        : `role:${sup.roleKey || ''}|rescue:${decisao}|msg:${msgDec}|conv:${convDec}|div:${convDec !== msgDec ? 'Y' : 'N'}`
          + `${msgMotivo ? '|motivo:' + msgMotivo.slice(0, 80) : ''}${convMotivo ? '|conv_motivo:' + convMotivo.slice(0, 80) : ''}`)
        + (funilAtivoGuard ? '|guard:funil_ativo' : '');   // salvaguarda: rescue queria descartar, funil ativo vetou
      gateShadowId = await _shadowLog(tenantId, { phone, channel, wouldAction: 'hard',
        roleId: sup.roleId, reason, externalMessageId: msg.externalMessageId });
      if (gateCfg.mode === 'on' && !resgata) {
        log.info('gate0.role_hard', { gate: 0, role: sup.roleKey, rescue_conf: msgConf, conv_conf: convConf, conv_mode: gateCfg.rescueConvMode });
        await captureDiscarded(tenantId, channel, phone, msg, rawBody, 'role_hard');  // distinto de 'internal_contact'
        return;
      }
    } else if (sup.presignal) {
      gatePresignal = true;   // presignal NUNCA descarta sozinha; segue pro crivo
      if (gateCfg.mode !== 'on') {
        gateShadowId = await _shadowLog(tenantId, { phone, channel, wouldAction: 'presignal',
          roleId: sup.roleId, reason: sup.roleKey ? ('role:' + sup.roleKey) : 'history_notlead_within_ttl',
          externalMessageId: msg.externalMessageId });
      }
    }
  }

  // ---- ADR-031: reação (emoji) é META-SINAL, não mensagem ----
  // NUNCA classifica nem gera rascunho (senão um 👍 vira resposta-fantasma na fila).
  // Só captura pro histórico (bolha não-vazia; o alvo fica no raw p/ exibição grudada
  // futura) e retorna. Staff já saiu nos gates de internal_contacts/papel acima.
  if (msg.reaction) {
    await captureInboundOnly(tenantId, channel, phone || psid, msg, rawBody);
    log.info('gate0.reaction_captured', { gate: 0, emoji: msg.reaction.emoji });
    return;
  }

  let cls = null;

  // ---- Buffer "aguardando classificação" (resiliência a 503 no Portão 1) ----
  // Este contato já tem um lead no buffer (uma triagem anterior falhou por 503/timeout)?
  // Se sim, a mensagem NOVA dispara reclassificação pela CONVERSA INTEIRA (o mesmo bloco
  // da conversa estabelecida) — NUNCA o Portão 1 single-message, que recriaria o erro do
  // Gabriel. Só consultamos quando NÃO é estabelecida (estabelecida já passa pelo bloco).
  const identGate = String(phone || psid || '').replace(/\D/g, '');
  const pendingState = (conversaEstabelecida || msg.skipTriage) ? null : await _loadPendingState(tenantId, identGate);
  // Caminho de CONVERSA INTEIRA = estabelecida OU pendente. Quem passa por aqui NÃO
  // pode cair no Portão 1 single-message depois.
  const viaConversaBlock = conversaEstabelecida || !!pendingState;
  // Sinaliza alerta ATIVO: só quando um lead do buffer estoura os 15min e vai pra Revisar.
  let pendingWindowExpired = false;

  // ============================================================================
  // ROTEAMENTO VIVO em conversa ESTABELECIDA (substitui o auto-promote do skip).
  // Antes: established → pulava o Portão 1 e auto-promovia NEW→QUALIFYING. Agora o
  // classifyConversa (conversa INTEIRA) GOVERNA, roteando por INTENT (sinal estável;
  // NUNCA por confidence, que não é P(lead)). Seguro por construção: não-lead CLARO
  // → não-classificadas (rede reviewável, não inunda a Revisar); dúvida/erro/contato de
  // relacionamento → Revisar; nova oportunidade → funil. Staff já saiu no gate de internal_contacts.
  // ============================================================================
  // Entra também quando há lead no buffer (pendingState): a reclassificação por EVENTO
  // (nova mensagem) reusa exatamente este caminho — conversa INTEIRA, retry, decisão.
  if (viaConversaBlock && !msg.skipTriage) {
    const identEstab = String(phone || psid || '').replace(/\D/g, '');
    // Monta a conversa: histórico real + a mensagem ATUAL (ainda não persistida).
    let conversation = [];
    try {
      const convRow = await withTenant(tenantId, (c) =>
        c.query(
          `SELECT id FROM conversations WHERE tenant_id = $1
             AND regexp_replace(external_id, '[^0-9]', '', 'g') = $2
           ORDER BY updated_at DESC LIMIT 1`,
          [tenantId, identEstab]
        ).then((r) => r.rows[0]));
      const leadRow = await withTenant(tenantId, (c) =>
        c.query(
          `SELECT id FROM leads WHERE tenant_id = $1
             AND regexp_replace(coalesce(phone, meta_psid, ''), '[^0-9]', '', 'g') = $2
           LIMIT 1`,
          [tenantId, identEstab]
        ).then((r) => r.rows[0]));
      if (convRow) {
        conversation = await loadRealHistory(tenantId, {
          conversationId: convRow.id, ident: identEstab, leadId: leadRow ? leadRow.id : null,
        });
      }
    } catch (e) {
      log.warn('gate1.estab.history_error', { error: e.message });
    }
    conversation = [...conversation, { role: 'USER', content: msg.body, at: new Date() }];

    const examplesEstab = await _fewShotExamples(tenantId);
    const { leadDefinition, stageDefinitions: stageDefs } = await _classifierConfig(tenantId);
    const isRelationship = await _isRelationshipContact(identEstab);

    // route=null → segue pro Portão 2 (funil/QUALIFYING). Senão, roteia e RETORNA.
    let route = null;
    try {
      const r = await _classifyConversaRetry(classifyConversa, {
        conversation, examples: examplesEstab, stageDefinitions: stageDefs, leadDefinition, tenant: tenantId,
      });
      log.info('gate1.estab.classified', { intent: r.intent, is_lead: r.is_lead, state: r.conversation_state, stage: r.suggested_stage });
      // Decisão única (compartilhada com a reclassificação do buffer): { cls } → funil
      // (cai no Portão 2 com rascunho); { route } → roteia pra fora do funil.
      const decision = _decideConversaRoute(r, isRelationship);
      if (decision.cls) cls = decision.cls;
      else route = decision.route;
    } catch (err) {
      log.warn('gate1.estab.classify_error', { error: err.message });
      // Buffer de classificação (resiliência 503): se este contato está AGUARDANDO e a
      // janela de 15min ainda NÃO estourou, mantém no buffer (silencioso) e sai — o
      // reprocessamento (job/próxima mensagem) volta a tentar. NUNCA cai no Portão 1
      // single-message (o erro do Gabriel). Janela estourada → Revisar + alerta ativo.
      if (pendingState && !_pendingWindowExpired(pendingState.pendingSince)) {
        await captureForPendingClassification(tenantId, channel, phone || psid, msg, rawBody, err.message);
        log.info('gate1.pending.retained', { lead_id: pendingState.leadId });
        return;
      }
      // estabelecida (default seguro) OU buffer com janela esgotada → Revisar.
      route = { status: 'REVIEW_QUEUE', reviewQueue: true, intent: 'ERRO',
                reasoning: '[vivo] erro no classificador — enviado para Revisar', confidence: null };
      pendingWindowExpired = !!pendingState;   // pendente + esgotou → alerta ATIVO abaixo
    }

    if (route) {
      const routedLeadId = await captureRoutedEstablished(tenantId, channel, phone || psid, msg, rawBody, route);
      log.info('gate1.estab.routed', { status: route.status, intent: route.intent, lead_id: routedLeadId });
      // Sugestão de etapa (suggestion-only): só persiste em lead do FUNIL (QUALIFYING);
      // lead em Revisar/não-classificadas ainda não está no kanban — nada a sugerir.
      if (route.status === 'QUALIFYING' && route.suggested_stage && routedLeadId) {
        await persistStageSuggestion(tenantId, routedLeadId, route.suggested_stage, route.stage_reasoning);
      }
      // Só Revisar notifica; não-classificadas segue silencioso (igual ao Portão 1).
      if (route.status === 'REVIEW_QUEUE' && routedLeadId) {
        // Buffer estourou os 15min → alerta ATIVO ("classificação indisponível"); senão,
        // a notificação padrão de revisão.
        await notificar(tenantId, pendingWindowExpired ? 'classificacao_indisponivel' : 'revisao', { leadId: routedLeadId });
      }
      return;
    }
    // route === null → NOVA_OPORTUNIDADE (não-relacionamento): cai no Portão 2 (funil).
  }

  // ---------------- PORTÃO 1: classificador leve -------------------
  // skipTriage: um lead vindo de Lead Ads (leadgen) já É um lead por definição —
  // pula o classificador (não há mensagem conversacional pra triar).
  // viaConversaBlock: conversa estabelecida OU buffer pendente já foram tratados pela
  // CONVERSA INTEIRA acima — não reclassificar single-message aqui.
  if (!msg.skipTriage && !viaConversaBlock) {
    const examples = await _fewShotExamples(tenantId);   // few-shot dinâmico (PARTE 3)
    // ADR-029: pré-marca entra como CONTEXTO (não veredito), só em 'on'. Em shadow é null.
    const presignalNote = (gateCfg.mode === 'on' && gatePresignal) ? PRESIGNAL_NOTE : null;
    try {
      cls = await _classifyRetry(classify, { message: msg.body, examples, presignalNote });   // retry imediato (503 spike)
    } catch (err) {
      // RESILIÊNCIA 503: falha TRANSITÓRIA esgotou o retry → NÃO joga no limbo. Entra no
      // buffer "aguardando classificação" (visível, reprocessável pela conversa inteira via
      // job/evento). Erro NÃO-transitório (ex.: contrato JSON) → captura o inbound como antes.
      if (_isTransientAIError(err)) {
        log.warn('gate1.pending.enqueued', { gate: 1, error: err.message });
        await captureForPendingClassification(tenantId, channel, phone || psid, msg, rawBody, err.message);
      } else {
        log.error('gate1.error', { gate: 1, error: err.message });
        await captureInboundOnly(tenantId, channel, phone || psid, msg, rawBody); // F: thread completo
      }
      return; // não trava: webhook já retornou 200
    }
    log.info('gate1.classified', { gate: 1, is_lead: cls.is_lead, confidence: cls.confidence });
    // ADR-029 modo sombra: registra o desfecho do crivo na MESMA linha (dimensiona o trade-off).
    if (gateShadowId) await _shadowOutcome(tenantId, gateShadowId, cls.is_lead ? 'lead' : 'not_lead');
    // Bloco 2 — abaixo do limite automático: NÃO entra no funil; vai pra fila de revisão.
    if (cls.confidence < AUTO_THRESHOLD) {
      let reviewStatus = cls.confidence >= REVIEW_THRESHOLD ? 'REVIEW_QUEUE' : 'NOT_LEAD';
      // ADR-029 presignal (só 'on'): mantém não-lead → vai pro Revisar (dúvida a conferir),
      // NUNCA NOT_LEAD silencioso/Descartados automático. A nota aparece no card.
      if (gateCfg.mode === 'on' && gatePresignal && reviewStatus === 'NOT_LEAD') {
        reviewStatus = 'REVIEW_QUEUE';
        cls = { ...cls, reasoning: '[pré-marcado não-lead — confirme] ' + (cls.reasoning || '') };
      }
      log.info('gate1.review_queue', { gate: 1, status: reviewStatus, confidence: cls.confidence });
      const reviewLeadId = await captureForReview(tenantId, channel, phone || psid, msg, rawBody, cls, reviewStatus);
      // Gatilho 3 — só REVIEW_QUEUE (médio) notifica; NOT_LEAD<0.40 segue silencioso.
      if (reviewStatus === 'REVIEW_QUEUE' && reviewLeadId) {
        await notificar(tenantId, 'revisao', { leadId: reviewLeadId });
      }
      return;
    }
  }

  // ---------------- PORTÃO 2: fluxo completo -----------------------
  // tx1: identifica/cria lead e conversa, carrega config; checa idempotência.
  const ctx = await withTenant(tenantId, async (c) => {
    if (msg.externalMessageId) {
      const dup = await c.query(
        'SELECT 1 FROM messages WHERE tenant_id = $1 AND external_message_id = $2',
        [tenantId, msg.externalMessageId]
      );
      if (dup.rowCount > 0) return { duplicate: true };
    }

    // Upsert do lead pela identidade do canal:
    //  - leadgen (Lead Ads): dedup por meta_leadgen_id (mantém/atualiza nome+telefone).
    //  - DM (Messenger/IG):  dedup por meta_psid (sem telefone).
    //  - WhatsApp:           dedup por phone (comportamento original).
    // Lookup de lead pré-existente por TELEFONE (dígitos BR-aware). Faz formatos
    // divergentes (com/sem 55, com/sem 9º dígito) convergirem no MESMO lead — sem
    // depender só do índice exato uq_leads_tenant_phone.
    const phoneKeys = phone ? telBR.matchKeys(phone) : [];
    const findByPhone = async () => {
      if (!phoneKeys.length) return null;
      const r = await c.query(
        `SELECT id, status, meta_leadgen_id FROM leads
          WHERE tenant_id = $1
            AND regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = ANY($2::text[])
          LIMIT 1`,
        [tenantId, phoneKeys]
      );
      return r.rows[0] || null;
    };

    let lead;
    if (msg.leadgenId) {
      // CENÁRIO B (WhatsApp antes, Meta depois): se já existe lead por telefone, MERGE
      // no existente — seta meta_leadgen_id se NULL, completa nome/email, registra o
      // evento. origem fica a do first-touch (não atualiza). Sem duplicata, sem evento
      // perdido, sem unique_violation no índice de phone (que o ON CONFLICT não cobre).
      // Merge do leadgen num lead JÁ existente (achado por telefone): seta meta_leadgen_id
      // se NULL, completa nome/email e registra o evento. Reusado pelo caminho normal E
      // pela blindagem de corrida abaixo (mesma semântica nos dois).
      const mergeLeadgenInto = async (existing) => {
        await c.query(
          `UPDATE leads SET meta_leadgen_id = COALESCE(meta_leadgen_id, $2),
                            name  = COALESCE(name, $3),
                            email = COALESCE(email, $4),
                            updated_at = now()
            WHERE id = $1`,
          [existing.id, msg.leadgenId, msg.sender || phone, msg.email || null]
        );
        await c.query(
          `INSERT INTO lead_eventos (tenant_id, lead_id, tipo, autor, conteudo)
           VALUES ($1, $2, 'meta_form_recebido', 'meta', $3)`,
          [tenantId, existing.id, 'Formulário Lead Ads recebido (vínculo por telefone)']
        );
        return { rows: [{ id: existing.id, status: existing.status, inserted: false }] };
      };

      const existing = await findByPhone();
      if (existing) {
        lead = await mergeLeadgenInto(existing);
      } else {
        // Não achou por telefone: cria com origem=meta_lead_ads (first-touch). ON CONFLICT
        // cobre reentrega do MESMO leadgen (idempotência); origem fora do DO UPDATE = imutável.
        // BLINDAGEM DE CORRIDA (SPIKE-E16 Cenário B): o pré-lookup + INSERT NÃO é atômico — uma
        // tx concorrente de WhatsApp com o MESMO telefone pode commitar entre o findByPhone e
        // este INSERT, disparando 23505 no índice parcial uq_leads_tenant_phone (que o
        // ON CONFLICT(meta_leadgen_id) NÃO cobre). O SAVEPOINT isola o INSERT: no 23505 de phone
        // desfaz só ele (a tx segue viva), reconsulta e faz o MERGE no lead que venceu a corrida.
        await c.query('SAVEPOINT leadgen_insert');
        try {
          lead = await c.query(
            `INSERT INTO leads (tenant_id, name, phone, email, status, meta_leadgen_id, origem)
             VALUES ($1, $2, $3, $4, 'NEW', $5, 'meta_lead_ads')
             ON CONFLICT (tenant_id, meta_leadgen_id) WHERE meta_leadgen_id IS NOT NULL
             DO UPDATE SET name = COALESCE(EXCLUDED.name, leads.name),
                           phone = COALESCE(EXCLUDED.phone, leads.phone),
                           email = COALESCE(EXCLUDED.email, leads.email),
                           updated_at = now()
             RETURNING id, status, (xmax = 0) AS inserted`,
            [tenantId, msg.sender || phone, phone, msg.email || null, msg.leadgenId]
          );
          await c.query('RELEASE SAVEPOINT leadgen_insert');
        } catch (e) {
          if (!(e && e.code === '23505' && e.constraint === 'uq_leads_tenant_phone')) throw e;
          await c.query('ROLLBACK TO SAVEPOINT leadgen_insert');
          const raced = await findByPhone();
          if (!raced) throw e;   // 23505 de phone sem lead achável não deveria ocorrer: repropaga
          lead = await mergeLeadgenInto(raced);
        }
      }
    } else if (psid) {
      lead = await c.query(
        `INSERT INTO leads (tenant_id, name, status, meta_psid, origem)
         VALUES ($1, $2, 'NEW', $3, $4)
         ON CONFLICT (tenant_id, meta_psid) WHERE meta_psid IS NOT NULL
         DO UPDATE SET name = COALESCE(EXCLUDED.name, leads.name), updated_at = now()
         RETURNING id, status, (xmax = 0) AS inserted`,
        [tenantId, msg.sender || psid, psid, channel]
      );
    } else {
      // WhatsApp: BLINDAGEM contra duplicata na mudança de formato — pré-lookup por
      // matchKeys casa um lead em formato ANTIGO (pré-normalização) quando o mesmo
      // cliente volta já normalizado. ON CONFLICT(phone) fica de fallback (race/exato).
      const existing = await findByPhone();
      if (existing) {
        await c.query('UPDATE leads SET updated_at = now() WHERE id = $1', [existing.id]);
        lead = { rows: [{ id: existing.id, status: existing.status, inserted: false }] };
      } else {
        lead = await c.query(
          `INSERT INTO leads (tenant_id, name, phone, status, origem)
           VALUES ($1, $2, $3, 'NEW', 'whatsapp')
           ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL
           DO UPDATE SET updated_at = now()
           RETURNING id, status, (xmax = 0) AS inserted`,
          [tenantId, msg.sender || phone, phone]
        );
      }
    }

    // Bloco 2 — grava o score/diagnóstico da classificação no lead do funil.
    if (cls) {
      await c.query(
        `UPDATE leads SET classification_confidence = $2, classification_reasoning = $3,
                          classification_signals = $4,
                          conversation_state = COALESCE($5, conversation_state),
                          state_reasoning = COALESCE($6, state_reasoning),
                          state_computed_at = CASE WHEN $5 IS NOT NULL THEN now() ELSE state_computed_at END
          WHERE id = $1`,
        [lead.rows[0].id, cls.confidence, cls.reasoning, JSON.stringify(cls.profile_signals || []),
         cls.conversation_state || null, cls.state_reasoning || null]
      );
    }

    const conv = await c.query(
      `INSERT INTO conversations (tenant_id, channel, external_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, channel, external_id)
       DO UPDATE SET updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [tenantId, channel, phone || psid]
    );

    // Config do prompt (nome/instrumentos/override) + horário de atendimento a
    // partir da FONTE ÚNICA tenants.horario_comercial (nunca business_hours).
    const config = await loadPromptConfig(c, tenantId);

    const qual = (
      await c.query(
        `SELECT name, instrument, availability, reasked
           FROM lead_qualifications WHERE tenant_id = $1 AND lead_id = $2`,
        [tenantId, lead.rows[0].id]
      )
    ).rows[0] || null;

    return {
      leadId: lead.rows[0].id,
      leadStatus: lead.rows[0].status,
      leadInserted: lead.rows[0].inserted === true,
      conversationId: conv.rows[0].id,
      convInserted: conv.rows[0].inserted === true,
      storedQual: qual,
      config,
    };
  });

  if (ctx.duplicate) {
    log.info('gate2.duplicate', { gate: 2, external_message_id: msg.externalMessageId });
    return;
  }

  const log2 = logger.child({
    tenant_id: tenantId,
    phone,
    lead_id: ctx.leadId,
    conversation_id: ctx.conversationId,
  });

  // Histórico REAL (lead + recepção + IA aprovada) carregado antes de persistir a
  // mensagem atual. É o que dá contexto pra IA gerar uma retomada (não primeiro contato).
  const ident = String(phone || psid || '').replace(/\D/g, '');
  const history = await loadRealHistory(tenantId, { conversationId: ctx.conversationId, ident, leadId: ctx.leadId });
  log2.info('gate2.history_loaded', { gate: 2, turns: history.length });

  // E1-03 — extração (antes de gerar, para a repergunta entrar na resposta).
  // Falha de extração é não-fatal: segue sem atualizar a qualificação.
  let qual = null;
  let clarification = null;
  try {
    const extraction = await extract({ history, message: msg.body });
    qual = mergeQualification(ctx.storedQual, extraction);
    if (qual.clarify.length) {
      clarification = qual.clarify.map((f) => FIELD_LABELS[f]).join(' e ');
    }
    log2.info('gate2.extracted', {
      gate: 2,
      fields: qual.values,
      qualification_complete: qual.complete,
      clarify: qual.clarify,
    });
  } catch (err) {
    log2.warn('gate2.extract_error', { gate: 2, error: err.message });
  }

  // Geração da resposta (rede; fora de transação).
  const systemPrompt = resolveSystemPrompt(ctx.config);
  let reply;
  try {
    reply = await generate({ systemPrompt, history, message: msg.body, clarification, retomada: history.length > 0 });
  } catch (err) {
    log2.error('gate2.generate_error', { gate: 2, error: err.message });
    // Anti-órfão: se o lead/conversa foram CRIADOS agora e a resposta não saiu,
    // desfaz — não deixa lead vazio (sem mensagem nem rascunho) poluindo o console.
    // Só apaga o que acabamos de inserir; lead/conversa pré-existentes são preservados.
    if (ctx.leadInserted || ctx.convInserted) {
      await withTenant(tenantId, async (c) => {
        if (ctx.leadInserted) {
          await c.query("DELETE FROM leads WHERE id = $1 AND status = 'NEW'", [ctx.leadId]);
        }
        if (ctx.convInserted) {
          await c.query('DELETE FROM conversations WHERE id = $1', [ctx.conversationId]);
        }
      }).catch((e) => log2.warn('gate2.orphan_cleanup_failed', { gate: 2, error: e.message }));
      log2.info('gate2.orphan_cleaned', { gate: 2, lead: ctx.leadInserted, conv: ctx.convInserted });
    }
    return; // não trava
  }

  // E1-02 — classifica a intenção APÓS gerar a resposta (não-fatal).
  let intent = null;
  try {
    intent = await classifyIntent({ message: msg.body, reply });
    log2.info('gate2.intent_classified', { gate: 2, intent });
  } catch (err) {
    log2.warn('gate2.intent_error', { gate: 2, error: err.message });
  }

  // LGPD — marca o 1º contato (lead NEW) para o registro de consentimento abaixo.
  // O rodapé de opt-out NÃO é anexado às mensagens de leads: são conversa humana
  // aprovada pela recepção. O opt-out só vai nos avisos automáticos de professores
  // (Scheduler/orchestrator), nunca aqui.
  const primeiraMensagem = ctx.leadStatus === 'NEW';

  // tx2: persiste USER + ASSISTANT, promove o lead e cria a aprovação pendente.
  const result = await withTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, direction, role, external_message_id, sender, body, raw,
          media_url, media_type, media_filename, media_transcription)
       VALUES ($1, $2, 'inbound', 'USER', $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, external_message_id)
         WHERE external_message_id IS NOT NULL DO NOTHING`,
      [tenantId, ctx.conversationId, msg.externalMessageId, msg.sender, msg.body, rawBody, ..._mediaCols(msg)]
    );
    await c.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, role, body)
       VALUES ($1, $2, 'outbound', 'ASSISTANT', $3)`,
      [tenantId, ctx.conversationId, reply]
    );

    // NEW -> QUALIFYING (só promove se ainda estava NEW).
    // BUG2(1) — resgate do latch: chegar ao Portão 2 = lead confirmado (confidence
    // >= 0.85, ou leadgen/conversa estabelecida). Promove também NOT_LEAD/REVIEW_QUEUE
    // que tinham sido travados por uma triagem anterior, e limpa a flag de revisão.
    // PENDING_CLASSIFICATION: lead recuperado do buffer 503 também promove e SAI do buffer
    // (limpa pending_since/attempts/last_error). review_result IS NULL preserva decisões
    // HUMANAS explícitas (não ressuscita o que a recepção marcou como não-lead).
    await c.query(
      `UPDATE leads SET status = 'QUALIFYING', review_queue = false, updated_at = now(),
                        classification_pending_since = NULL,
                        classification_attempts = 0,
                        classification_last_error = NULL
        WHERE id = $1
          AND status IN ('NEW', 'NOT_LEAD', 'REVIEW_QUEUE', 'PENDING_CLASSIFICATION')
          AND review_result IS NULL`,
      [ctx.leadId]
    );

    // E1-02 — grava a intenção classificada.
    if (intent) {
      await c.query('UPDATE leads SET intent = $2, updated_at = now() WHERE id = $1', [
        ctx.leadId,
        intent,
      ]);
    }

    // E1-03 — upsert da qualificação extraída.
    if (qual) {
      await c.query(
        `INSERT INTO lead_qualifications
           (tenant_id, lead_id, name, instrument, availability, qualification_complete, reasked, extracted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (tenant_id, lead_id) DO UPDATE SET
           name = EXCLUDED.name, instrument = EXCLUDED.instrument,
           availability = EXCLUDED.availability,
           qualification_complete = EXCLUDED.qualification_complete,
           reasked = EXCLUDED.reasked, extracted_at = now()`,
        [
          tenantId,
          ctx.leadId,
          qual.values.name,
          qual.values.instrument,
          qual.values.availability,
          qual.complete,
          qual.reasked,
        ]
      );
      // QUALIFYING -> QUALIFIED quando os 3 dados estão completos.
      if (qual.complete) {
        await c.query(
          "UPDATE leads SET status = 'QUALIFIED', updated_at = now() WHERE id = $1",
          [ctx.leadId]
        );
      }
    }

    // LGPD — consentimento implícito: registra no 1º contato (rodapé de
    // opt-out apresentado). Não clicar no opt-out configura o consentimento.
    if (primeiraMensagem) {
      await c.query(
        `INSERT INTO consent_records (tenant_id, lead_id, channel, text_version)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, ctx.leadId, channel, CONSENT_VERSION]
      );
    }

    // MODO OBSERVAÇÃO: não envia; cria aprovação pendente.
    // Fatia D — DEDUP: arquiva o PENDING anterior do lead ANTES de inserir o novo (rascunho mais
    // fresco). Nunca 2 PENDING vivos pro mesmo lead. A recepção já via só o mais recente
    // (decidePending ORDER BY created_at DESC LIMIT 1); isto estanca o acúmulo (era 427 p/ 102
    // leads). Mesma transação (c) → atômico. Espelha o dedup que o generateDraftForLead já faz.
    await c.query(
      "UPDATE pending_approvals SET status = 'ARCHIVED' WHERE tenant_id = $1 AND lead_id = $2 AND status = 'PENDING'",
      [tenantId, ctx.leadId]
    );
    const pa = await c.query(
      `INSERT INTO pending_approvals
         (tenant_id, lead_id, conversation_id, suggested_response, status)
       VALUES ($1, $2, $3, $4, 'PENDING')
       RETURNING id`,
      [tenantId, ctx.leadId, ctx.conversationId, reply]
    );
    return { approvalId: pa.rows[0].id };
  });

  log2.info('gate2.pending_approval_created', {
    gate: 2,
    approval_id: result.approvalId,
    lead_promoted: ctx.leadStatus === 'NEW',
  });

  // ADR sugestão-de-etapa — agora que o lead está no funil (promovido a QUALIFYING/
  // QUALIFIED), persiste a sugestão de etapa vinda do detector (roteamento vivo). As
  // travas (etapa atual / dispensa) ficam na helper. Suggestion-only: nunca move.
  if (cls && cls.suggested_stage) {
    await persistStageSuggestion(tenantId, ctx.leadId, cls.suggested_stage, cls.stage_reasoning);
  }

  // Bloco 4 — notifica a recepção (best-effort). Gatilho 1 (lead novo) ou 2 (lead
  // existente respondeu). nome/instrumento do que foi extraído nesta passagem.
  const _nome = (qual && qual.values && qual.values.name) || null;
  const _instrumento = (qual && qual.values && qual.values.instrument) || null;
  if (primeiraMensagem) {
    await notificar(tenantId, 'novo_lead', { leadId: ctx.leadId, name: _nome, instrument: _instrumento, confidence: cls ? cls.confidence : 1 });
  } else {
    await notificar(tenantId, 'nova_msg', { leadId: ctx.leadId, name: _nome });
  }
}

// Bloco 2 — gera um rascunho (pending_approval) para um lead JÁ existente, sem passar
// pelo triador. Usado quando a recepção confirma um lead da fila de revisão: replica a
// geração do PORTÃO 2 (histórico real + generate) de forma isolada. Best-effort.
async function generateDraftForLead(tenantId, leadId, deps = {}) {
  const generate = deps.generate || gemini.generateReply;
  const log = logger.child({ tenant_id: tenantId, lead_id: leadId, fn: 'generateDraftForLead' });

  const info = await withTenant(tenantId, async (c) => {
    const lead = (await c.query('SELECT id, phone, meta_psid FROM leads WHERE id = $1', [leadId])).rows[0];
    if (!lead) return null;
    const ident = String(lead.phone || lead.meta_psid || '').replace(/\D/g, '');
    const conv = (
      await c.query(
        `SELECT id FROM conversations
          WHERE tenant_id = $1 AND regexp_replace(external_id, '[^0-9]', '', 'g') = $2
          ORDER BY updated_at DESC LIMIT 1`,
        [tenantId, ident]
      )
    ).rows[0];
    const last = (
      await c.query(
        `SELECT m.body FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
          WHERE cv.tenant_id = $1 AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = $2
            AND m.role = 'USER'
          ORDER BY m.received_at DESC LIMIT 1`,
        [tenantId, ident]
      )
    ).rows[0];
    const config = await loadPromptConfig(c, tenantId);
    return {
      ident, conversationId: conv?.id || null, lastBody: last?.body || '',
      config,
    };
  });
  if (!info || !info.conversationId) { log.warn('draft.no_conversation'); return { ok: false, reason: 'no_conversation' }; }

  const history = await loadRealHistory(tenantId, { conversationId: info.conversationId, ident: info.ident, leadId });
  const systemPrompt = resolveSystemPrompt(info.config);
  let reply;
  try {
    reply = await generate({ systemPrompt, history, message: info.lastBody, retomada: history.length > 0 });
  } catch (err) {
    log.error('draft.generate_error', { error: err.message });
    return { ok: false, reason: 'generate_error' };
  }

  const out = await withTenant(tenantId, async (c) => {
    const exist = await c.query(
      "SELECT id FROM pending_approvals WHERE tenant_id = $1 AND lead_id = $2 AND status = 'PENDING' LIMIT 1",
      [tenantId, leadId]
    );
    if (exist.rowCount) return { id: exist.rows[0].id, dup: true };
    const r = await c.query(
      `INSERT INTO pending_approvals (tenant_id, lead_id, conversation_id, suggested_response, status)
       VALUES ($1, $2, $3, $4, 'PENDING') RETURNING id`,
      [tenantId, leadId, info.conversationId, reply]
    );
    return { id: r.rows[0].id };
  });
  log.info('draft.generated', { approval_id: out.id, dup: !!out.dup });
  return { ok: true, approvalId: out.id, dup: !!out.dup };   // Fatia F: dup → o Undo só arquiva draft NOVO
}

module.exports = {
  processInbound, generateDraftForLead, mergeQualification, loadRealHistory, reprocessPendingLead,
  captureGroupInbound,   // ADR-042 E14/B1 — ingestão de mensagem de grupo
  captureComment,        // ADR-042/Meta — ingestão de comentário de post (IG/FB)
  CONFIDENCE_THRESHOLD,
  // Helpers puros expostos p/ teste (resiliência 503).
  _isTransientAIError, _pendingWindowExpired, _decideConversaRoute, PENDING_CLASSIFICATION_WINDOW_MS,
  // ADR-029 fatia 3 — expostos p/ o teste de isolamento multi-tenant (§7).
  _gateConfig, _lookupRole, _presignalActive, _evaluateGateSuppression, _leadEmFunilAtivo, _shadowLog, _shadowOutcome,
  // Gate 0 rescue com conversa — expostos p/ itest (conversa passada à rescue question).
  _carregarConversaSaida, _rescueConversation, RESCUE_CONV_MAX,
  // ADR-030 Passo 2 — classificação da saída (estado semântico da bola), shadow-only.
  classificarSaida, _aplicarEstadoBola,
  // Aplicação automática de sugestão de etapa (078) — expostos p/ itest + backfill.
  _autoAplicarEtapa, persistStageSuggestion,
};
