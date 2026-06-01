'use strict';

const { withTenant } = require('./db');
const logger = require('./logger');
const { toE164 } = require('./validation');
const { resolveSystemPrompt } = require('./templates');
const gemini = require('./gemini');
const notifyModule = require('./notify');
const redisClient = require('./redisClient');

const CONFIDENCE_THRESHOLD = 0.7;

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
 * deps injetáveis (testes): { classify, generate, notify, redis }.
 */
async function processInbound(tenant, msg, rawBody, deps = {}) {
  const classify = deps.classify || gemini.classify;
  const generate = deps.generate || gemini.generateReply;
  const notify = deps.notify || notifyModule.notifyReceptionist;
  const redis = deps.redis || redisClient;

  const tenantId = tenant.id;
  const phone = toE164(msg.externalId);
  const log = logger.child({ tenant_id: tenantId, phone });

  // ---------------- PORTÃO 0: filtro determinístico ----------------
  const known = await withTenant(tenantId, (c) =>
    c.query('SELECT type FROM known_contacts WHERE tenant_id = $1 AND phone = $2', [tenantId, phone])
  );
  if (known.rowCount > 0) {
    log.info('gate0.ignored', { gate: 0, contact_type: known.rows[0].type });
    return;
  }

  // ---------------- PORTÃO 1: classificador leve -------------------
  let cls;
  try {
    cls = await classify({ message: msg.body, tenantId });
  } catch (err) {
    log.error('gate1.error', { gate: 1, error: err.message });
    return; // não trava: webhook já retornou 200
  }
  log.info('gate1.classified', { gate: 1, label: cls.label, confidence: cls.confidence });
  if (cls.label !== 'LEAD' || cls.confidence < CONFIDENCE_THRESHOLD) {
    log.info('gate1.ignored', { gate: 1, label: cls.label, confidence: cls.confidence });
    return;
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

    const lead = await c.query(
      `INSERT INTO leads (tenant_id, name, phone, status)
       VALUES ($1, $2, $3, 'NEW')
       ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL
       DO UPDATE SET updated_at = now()
       RETURNING id, status`,
      [tenantId, msg.sender || phone, phone]
    );

    const conv = await c.query(
      `INSERT INTO conversations (tenant_id, channel, external_id)
       VALUES ($1, 'whatsapp', $2)
       ON CONFLICT (tenant_id, channel, external_id)
       DO UPDATE SET updated_at = now()
       RETURNING id`,
      [tenantId, phone]
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

    return {
      leadId: lead.rows[0].id,
      leadStatus: lead.rows[0].status,
      conversationId: conv.rows[0].id,
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

  // Geração da resposta (rede; fora de transação).
  const systemPrompt = resolveSystemPrompt(ctx.config);
  let reply;
  try {
    reply = await generate({ systemPrompt, history, message: msg.body });
  } catch (err) {
    log2.error('gate2.generate_error', { gate: 2, error: err.message });
    return; // não trava
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

module.exports = { processInbound, CONFIDENCE_THRESHOLD, loadHistory };
