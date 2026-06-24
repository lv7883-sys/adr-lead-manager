'use strict';

const { withTenant, pool } = require('./db');
const logger = require('./logger');
const { toE164 } = require('./validation');
const telBR = require('./telefoneBR');
const { resolveSystemPrompt } = require('./templates');
const gemini = require('./gemini');
const notifyModule = require('./notify');
const notificacao = require('./notificacao');   // Bloco 4: push WhatsApp pra recepção
const redisClient = require('./redisClient');
const gating = require('./gating');
const { kanbanColuna } = require('./metrics');   // ADR sugestão-de-etapa: travas de posição

const CONFIDENCE_THRESHOLD = 0.7;
// Bloco 2 — roteamento por confidence (probabilidade de ser lead):
//   >= AUTO  : entra no funil automaticamente.
//   >= REVIEW: fila de revisão (status REVIEW_QUEUE).
//   <  REVIEW: fila de revisão também, mas status NOT_LEAD (visível, zero lead perdido).
const AUTO_THRESHOLD = 0.85;
const REVIEW_THRESHOLD = 0.40;

// Few-shot dinâmico: últimas correções da recepção pra calibrar o classificador.
async function _fewShotExamples(tenantId) {
  try {
    const res = await withTenant(tenantId, (c) => c.query(
      `SELECT correct_label, original_reasoning, correction_context, corrected_temperature
         FROM classification_feedback WHERE tenant_id = $1
        ORDER BY feedback_at DESC LIMIT 10`,
      [tenantId]
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

// ADR sugestão-de-etapa — persiste a sugestão da IA (suggestion-only) com as DUAS travas:
// (1) nunca sugerir a etapa em que o lead JÁ está; (2) não re-sugerir uma etapa que a
// recepção já dispensou (suggested_stage_dismissed). NUNCA move o lead. Best-effort.
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
  try {
    const r = await pool.query(
      `SELECT 1 FROM app.professor_notificacao
        WHERE regexp_replace(coalesce(telefone_override, telefone), '[^0-9]', '', 'g') = $1
        LIMIT 1`,
      [identDigits]
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
  if (phone) {
    const interno = await withTenant(tenantId, (c) =>
      c.query(
        `SELECT 1 FROM internal_contacts
          WHERE tenant_id = $1
            AND regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace($2, '[^0-9]', '', 'g')
          LIMIT 1`,
        [tenantId, phone]
      )
    );
    if (interno.rowCount > 0) {
      log.info('gate0.internal_contact', { gate: 0 });
      await captureDiscarded(tenantId, channel, phone, msg, rawBody, 'internal_contact');
      return;
    }
  }

  let cls = null;

  // ============================================================================
  // ROTEAMENTO VIVO em conversa ESTABELECIDA (substitui o auto-promote do skip).
  // Antes: established → pulava o Portão 1 e auto-promovia NEW→QUALIFYING. Agora o
  // classifyConversa (conversa INTEIRA) GOVERNA, roteando por INTENT (sinal estável;
  // NUNCA por confidence, que não é P(lead)). Seguro por construção: não-lead CLARO
  // → não-classificadas (rede reviewável, não inunda a Revisar); dúvida/erro/contato de
  // relacionamento → Revisar; nova oportunidade → funil. Staff já saiu no gate de internal_contacts.
  // ============================================================================
  if (conversaEstabelecida && !msg.skipTriage) {
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
      const estado = { conversation_state: r.conversation_state, state_reasoning: r.state_reasoning };
      // Sugestão de etapa: só carrega quando É lead (independente de intent/estado).
      const sugEtapa = r.is_lead ? r.suggested_stage : null;
      const sugMotivo = r.is_lead ? r.stage_reasoning : null;
      if (r.intent === 'NOVA_OPORTUNIDADE') {
        if (isRelationship) {
          // contato de relacionamento NUNCA auto-funil: oportunidade aparente → confirmação humana.
          route = { status: 'REVIEW_QUEUE', reviewQueue: true, intent: 'RELACIONAMENTO_OPORTUNIDADE',
                    reasoning: '[vivo] contato de relacionamento com sinal de oportunidade — Revisar', confidence: r.confidence, ...estado };
        } else if (r.conversation_state === 'RESOLVIDO' || r.conversation_state === 'AGUARDANDO_CLIENTE') {
          // CONSUMIDOR 2 (estendido) — rascunho pendente só faz sentido pra AGUARDANDO_RECEPCAO
          // (a bola está com a escola). RESOLVIDO (encerrou) e AGUARDANDO_CLIENTE (a escola já
          // respondeu, espera o cliente) NÃO precisam de resposta agora: mantém no funil, SEM
          // gerar rascunho "aguardando aprovação" (não infla a fila com conversa que não devemos).
          route = { status: 'QUALIFYING', reviewQueue: false, intent: r.intent,
                    reasoning: `[vivo] ${r.reasoning || (r.conversation_state === 'RESOLVIDO' ? 'oportunidade resolvida' : 'aguardando cliente')}`,
                    confidence: r.confidence, suggested_stage: sugEtapa, stage_reasoning: sugMotivo, ...estado };
        } else {
          // funil: deixa cair no Portão 2 (auto-promove + rascunho). Registra a classificação + estado.
          cls = { confidence: r.confidence, reasoning: `[vivo] ${r.reasoning || 'nova oportunidade'}`,
                  profile_signals: [r.intent], is_lead: true,
                  suggested_stage: sugEtapa, stage_reasoning: sugMotivo, ...estado };
        }
      } else if (r.intent === 'ROTINA_CLIENTE' || r.intent === 'INTERNO') {
        // não-lead CLARO → não-classificadas (rede reviewável).
        route = { status: 'NOT_LEAD', reviewQueue: true, intent: r.intent,
                  reasoning: `[vivo] ${r.reasoning || r.intent}`, confidence: r.confidence, ...estado };
      } else {
        // INDEFINIDO → Revisar.
        route = { status: 'REVIEW_QUEUE', reviewQueue: true, intent: 'INDEFINIDO',
                  reasoning: `[vivo] ${r.reasoning || 'indefinido'}`, confidence: r.confidence, ...estado };
      }
    } catch (err) {
      // falha/429 esgotado → Revisar (default seguro). Nunca quebra o ingest.
      log.warn('gate1.estab.classify_error', { error: err.message });
      route = { status: 'REVIEW_QUEUE', reviewQueue: true, intent: 'ERRO',
                reasoning: '[vivo] erro no classificador — enviado para Revisar', confidence: null };
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
        await notificar(tenantId, 'revisao', { leadId: routedLeadId });
      }
      return;
    }
    // route === null → NOVA_OPORTUNIDADE (não-relacionamento): cai no Portão 2 (funil).
  }

  // ---------------- PORTÃO 1: classificador leve -------------------
  // skipTriage: um lead vindo de Lead Ads (leadgen) já É um lead por definição —
  // pula o classificador (não há mensagem conversacional pra triar).
  // conversaEstabelecida (BUG2-2): recepção já respondeu → roteamento vivo acima.
  if (!msg.skipTriage && !conversaEstabelecida) {
    const examples = await _fewShotExamples(tenantId);   // few-shot dinâmico (PARTE 3)
    try {
      cls = await classify({ message: msg.body, examples });
    } catch (err) {
      log.error('gate1.error', { gate: 1, error: err.message });
      await captureInboundOnly(tenantId, channel, phone || psid, msg, rawBody); // F: thread completo
      return; // não trava: webhook já retornou 200
    }
    log.info('gate1.classified', { gate: 1, is_lead: cls.is_lead, confidence: cls.confidence });
    // Bloco 2 — abaixo do limite automático: NÃO entra no funil; vai pra fila de revisão.
    if (cls.confidence < AUTO_THRESHOLD) {
      const reviewStatus = cls.confidence >= REVIEW_THRESHOLD ? 'REVIEW_QUEUE' : 'NOT_LEAD';
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
      const existing = await findByPhone();
      if (existing) {
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
        lead = { rows: [{ id: existing.id, status: existing.status, inserted: false }] };
      } else {
        // Não achou: cria com origem=meta_lead_ads (first-touch). ON CONFLICT cobre
        // reentrega do MESMO leadgen (idempotência); origem fora do DO UPDATE = imutável.
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

    const cfg = (
      await c.query(
        `SELECT school_name, system_prompt_override, available_instruments,
                business_hours, notification_whatsapp
           FROM tenant_lead_config WHERE tenant_id = $1`,
        [tenantId]
      )
    ).rows[0];
    const name = (await c.query('SELECT name FROM tenants WHERE id = $1', [tenantId])).rows[0]?.name;

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
      config: cfg || {
        school_name: name || 'Escola',
        system_prompt_override: null,
        available_instruments: [],
        business_hours: {},
        notification_whatsapp: null,
      },
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
    // review_result IS NULL preserva decisões HUMANAS explícitas (não ressuscita o que
    // a recepção marcou como não-lead).
    await c.query(
      `UPDATE leads SET status = 'QUALIFYING', review_queue = false, updated_at = now()
        WHERE id = $1
          AND status IN ('NEW', 'NOT_LEAD', 'REVIEW_QUEUE')
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
    const cfg = (
      await c.query(
        `SELECT school_name, system_prompt_override, available_instruments, business_hours, notification_whatsapp
           FROM tenant_lead_config WHERE tenant_id = $1`,
        [tenantId]
      )
    ).rows[0];
    const tname = (await c.query('SELECT name FROM tenants WHERE id = $1', [tenantId])).rows[0]?.name;
    return {
      ident, conversationId: conv?.id || null, lastBody: last?.body || '',
      config: cfg || { school_name: tname || 'Escola', system_prompt_override: null, available_instruments: [], business_hours: {}, notification_whatsapp: null },
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
  return { ok: true, approvalId: out.id };
}

module.exports = { processInbound, generateDraftForLead, mergeQualification, loadRealHistory, CONFIDENCE_THRESHOLD };
