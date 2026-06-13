'use strict';

const { withTenant } = require('./db');
const logger = require('./logger');
const { toE164 } = require('./validation');
const { resolveSystemPrompt } = require('./templates');
const gemini = require('./gemini');
const notifyModule = require('./notify');
const redisClient = require('./redisClient');
const gating = require('./gating');
const { makeOptoutToken } = require('./optoutToken');

const CONFIDENCE_THRESHOLD = 0.7;
// Bloco 2 — roteamento por confidence (probabilidade de ser lead):
//   >= AUTO  : entra no funil automaticamente.
//   >= REVIEW: fila de revisão (status REVIEW_QUEUE).
//   <  REVIEW: fila de revisão também, mas status NOT_LEAD (visível, zero lead perdido).
const AUTO_THRESHOLD = 0.85;
const REVIEW_THRESHOLD = 0.40;

// ADR-016 — params de mídia da mensagem (4 colunas), na ordem do INSERT.
function _mediaCols(msg) {
  const m = (msg && msg.media) || null;
  return [m && m.url || null, m && m.type || null, m && m.filename || null, m && m.transcription || null];
}

// LGPD (item 2) — rodapé discreto de opt-out, SÓ na 1ª mensagem (lead NEW).
// Sem mencionar IA/assistente/tecnologia; link único por lead (token HMAC).
const OPTOUT_BASE = process.env.OPTOUT_BASE_URL || 'https://agenda.leovecchi.com';
const CONSENT_VERSION = 'optout-footer-v1';
function optoutFooter(tenantId, leadId) {
  const token = makeOptoutToken(tenantId, leadId);
  return `Não quer receber mensagens? Clique aqui: ${OPTOUT_BASE}/optout/${token}`;
}

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
        `SELECT role, content FROM (
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
  return rows.map((r) => ({ role: r.role, content: r.content }));
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

// Bloco 2 — captura do inbound E cria o lead na FILA DE REVISÃO (não entra no funil).
// `reviewStatus` = 'REVIEW_QUEUE' (médio) ou 'NOT_LEAD' (baixo). Grava os campos de
// classificação + review_queue=true. Idempotente. Best-effort: nunca lança.
async function captureForReview(tenantId, channel, externalId, msg, rawBody, cls, reviewStatus) {
  if (!externalId || !msg.body) return;
  const psid = msg.psid || null;
  const phone = psid ? null : externalId;
  try {
    await withTenant(tenantId, async (c) => {
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
  const generate = deps.generate || gemini.generateReply;
  const classifyIntent = deps.classifyIntent || gemini.classifyIntent;
  const extract = deps.extract || gemini.extractQualification;
  const notify = deps.notify || notifyModule.notifyReceptionist;
  const redis = deps.redis || redisClient;

  const tenantId = tenant.id;
  // E5 — canal e identidade. WhatsApp/leadgen são identificados por TELEFONE;
  // DM da Meta (Messenger/IG) por PSID (sem telefone). Default = comportamento
  // original do WhatsApp (channel 'whatsapp', sem psid).
  const channel = msg.channel || 'whatsapp';
  const psid = msg.psid || null;
  const phone = psid ? null : toE164(msg.phone || msg.externalId);
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

  // ---- LGPD: lead que pediu opt-out NUNCA mais é processado/respondido ----
  const optedOut = await withTenant(tenantId, (c) =>
    c.query("SELECT 1 FROM leads WHERE tenant_id = $1 AND phone = $2 AND status = 'OPTED_OUT'", [tenantId, phone])
  );
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
      return;
    }
  }

  // ---------------- PORTÃO 1: classificador leve -------------------
  // skipTriage: um lead vindo de Lead Ads (leadgen) já É um lead por definição —
  // pula o classificador (não há mensagem conversacional pra triar).
  let cls = null;
  if (!msg.skipTriage) {
    try {
      cls = await classify({ message: msg.body, tenantId });
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
      await captureForReview(tenantId, channel, phone || psid, msg, rawBody, cls, reviewStatus);
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
    let lead;
    if (msg.leadgenId) {
      lead = await c.query(
        `INSERT INTO leads (tenant_id, name, phone, status, meta_leadgen_id)
         VALUES ($1, $2, $3, 'NEW', $4)
         ON CONFLICT (tenant_id, meta_leadgen_id) WHERE meta_leadgen_id IS NOT NULL
         DO UPDATE SET name = COALESCE(EXCLUDED.name, leads.name),
                       phone = COALESCE(EXCLUDED.phone, leads.phone),
                       updated_at = now()
         RETURNING id, status, (xmax = 0) AS inserted`,
        [tenantId, msg.sender || phone, phone, msg.leadgenId]
      );
    } else if (psid) {
      lead = await c.query(
        `INSERT INTO leads (tenant_id, name, status, meta_psid)
         VALUES ($1, $2, 'NEW', $3)
         ON CONFLICT (tenant_id, meta_psid) WHERE meta_psid IS NOT NULL
         DO UPDATE SET name = COALESCE(EXCLUDED.name, leads.name), updated_at = now()
         RETURNING id, status, (xmax = 0) AS inserted`,
        [tenantId, msg.sender || psid, psid]
      );
    } else {
      lead = await c.query(
        `INSERT INTO leads (tenant_id, name, phone, status)
         VALUES ($1, $2, $3, 'NEW')
         ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL
         DO UPDATE SET updated_at = now()
         RETURNING id, status, (xmax = 0) AS inserted`,
        [tenantId, msg.sender || phone, phone]
      );
    }

    // Bloco 2 — grava o score/diagnóstico da classificação no lead do funil.
    if (cls) {
      await c.query(
        `UPDATE leads SET classification_confidence = $2, classification_reasoning = $3,
                          classification_signals = $4
          WHERE id = $1`,
        [lead.rows[0].id, cls.confidence, cls.reasoning, JSON.stringify(cls.profile_signals || [])]
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

  // LGPD — rodapé de opt-out só na PRIMEIRA mensagem (lead recém-criado: NEW).
  const primeiraMensagem = ctx.leadStatus === 'NEW';
  if (primeiraMensagem) {
    reply = `${reply}\n\n${optoutFooter(tenantId, ctx.leadId)}`;
  }

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
    await c.query(
      `UPDATE leads SET status = 'QUALIFYING', updated_at = now()
        WHERE id = $1 AND status = 'NEW'`,
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

  // Notifica a recepcionista (best-effort).
  await notify({ tenantId, to: ctx.config.notification_whatsapp });
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

module.exports = { processInbound, generateDraftForLead, mergeQualification, CONFIDENCE_THRESHOLD };
