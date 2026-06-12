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

// Histórico: tenta o cache Redis; em miss/erro, reconstrói do PostgreSQL e
// repovoa o cache. Retorna também a origem (para observabilidade).
async function loadHistory(tenantId, conversationId, redis) {
  const cached = await redis.getCachedHistory(conversationId);
  if (cached) return { messages: cached, source: 'redis' };

  const { rows } = await withTenant(tenantId, (c) =>
    c.query(
      `SELECT role, body FROM messages
        WHERE conversation_id = $1 AND role IS NOT NULL
        ORDER BY received_at ASC`,
      [conversationId]
    )
  );
  const messages = rows.map((r) => ({ role: r.role, content: r.body }));
  await redis.setCachedHistory(conversationId, messages);
  return { messages, source: 'pg' };
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

  // ---------------- PORTÃO 0: contato conhecido (contexto, não exclusão) ----------------
  // Antes, contato conhecido era DESCARTADO direto. Mas um aluno/contato atual pode
  // querer um NOVO curso, ou perguntar por outra pessoa — então não dá pra excluir no
  // determinístico. Aqui só descobrimos o tipo e passamos como CONTEXTO ao classificador
  // (Portão 1), que decide LEAD vs NOT_LEAD avaliando a mensagem.
  const known = await withTenant(tenantId, (c) =>
    c.query('SELECT type FROM known_contacts WHERE tenant_id = $1 AND phone = $2', [tenantId, phone])
  );
  const knownContactType = known.rowCount > 0 ? known.rows[0].type : null;
  if (knownContactType) log.info('gate0.known_contact', { gate: 0, contact_type: knownContactType });

  // ---- LGPD: lead que pediu opt-out NUNCA mais é processado/respondido ----
  const optedOut = await withTenant(tenantId, (c) =>
    c.query("SELECT 1 FROM leads WHERE tenant_id = $1 AND phone = $2 AND status = 'OPTED_OUT'", [tenantId, phone])
  );
  if (optedOut.rowCount > 0) {
    log.info('gate0.opted_out', { gate: 0 });
    return;
  }

  // ---------------- PORTÃO 1: classificador leve -------------------
  // skipTriage: um lead vindo de Lead Ads (leadgen) já É um lead por definição —
  // pula o classificador (não há mensagem conversacional pra triar).
  if (!msg.skipTriage) {
    let cls;
    try {
      cls = await classify({ message: msg.body, tenantId, knownContactType });
    } catch (err) {
      log.error('gate1.error', { gate: 1, error: err.message });
      return; // não trava: webhook já retornou 200
    }
    log.info('gate1.classified', { gate: 1, label: cls.label, confidence: cls.confidence });
    if (cls.label !== 'LEAD' || cls.confidence < CONFIDENCE_THRESHOLD) {
      log.info('gate1.ignored', { gate: 1, label: cls.label, confidence: cls.confidence });
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

  // Histórico (prévio) carregado antes de persistir a mensagem atual.
  const { messages: history, source } = await loadHistory(tenantId, ctx.conversationId, redis);
  log2.info('gate2.history_loaded', { gate: 2, history_source: source, turns: history.length });

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
    reply = await generate({ systemPrompt, history, message: msg.body, clarification });
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
         (tenant_id, conversation_id, direction, role, external_message_id, sender, body, raw)
       VALUES ($1, $2, 'inbound', 'USER', $3, $4, $5, $6)
       ON CONFLICT (tenant_id, external_message_id)
         WHERE external_message_id IS NOT NULL DO NOTHING`,
      [tenantId, ctx.conversationId, msg.externalMessageId, msg.sender, msg.body, rawBody]
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

  // SEMPRE invalida o cache DEPOIS de persistir no PostgreSQL (nunca antes).
  await redis.invalidateHistory(ctx.conversationId);

  log2.info('gate2.pending_approval_created', {
    gate: 2,
    approval_id: result.approvalId,
    lead_promoted: ctx.leadStatus === 'NEW',
  });

  // Notifica a recepcionista (best-effort).
  await notify({ tenantId, to: ctx.config.notification_whatsapp });
}

module.exports = { processInbound, mergeQualification, CONFIDENCE_THRESHOLD, loadHistory };
