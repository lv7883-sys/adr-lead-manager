'use strict';

const crypto = require('crypto');
const express = require('express');
const { withTenant } = require('../db');
const logger = require('../logger');

const router = express.Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Comparação de tokens em tempo constante (evita timing attack).
function tokenMatches(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Normaliza o payload do provedor (Z-API ou Evolution API) num formato único.
function normalizeMessage(body) {
  // Z-API: { phone, messageId, fromMe, senderName, text: { message } }
  if (body && body.phone) {
    return {
      externalId: String(body.phone),
      externalMessageId: body.messageId ? String(body.messageId) : null,
      fromMe: Boolean(body.fromMe),
      sender: body.senderName || body.chatName || null,
      body: body.text?.message ?? body.image?.caption ?? null,
    };
  }
  // Evolution API: { data: { key: { remoteJid, fromMe, id }, pushName, message } }
  const data = body?.data;
  if (data && data.key) {
    const jid = data.key.remoteJid || '';
    return {
      externalId: jid.split('@')[0] || jid,
      externalMessageId: data.key.id ? String(data.key.id) : null,
      fromMe: Boolean(data.key.fromMe),
      sender: data.pushName || null,
      body:
        data.message?.conversation ??
        data.message?.extendedTextMessage?.text ??
        null,
    };
  }
  return null;
}

// 200 silencioso: reconhece o webhook sem revelar nada nem processar.
function silentOk(res) {
  return res.status(200).json({ status: 'ignored' });
}

/**
 * Middleware: autentica o tenant pelo header X-ZAPI-TOKEN ANTES de processar.
 *  - tenantId inválido / inexistente  -> 200 silencioso (não vaza existência)
 *  - Lead Manager inativo no tenant    -> 200 silencioso
 *  - token ausente / divergente        -> 401
 *  - ok                                -> req.tenant preenchido, segue adiante
 */
async function authenticateTenant(req, res, next) {
  const tenantId = req.params.tenantId;
  const log = logger.child({ tenant_id: tenantId });

  if (!UUID_RE.test(tenantId || '')) {
    log.info('webhook.rejected', { reason: 'invalid_tenant_id' });
    return silentOk(res);
  }

  try {
    const tenant = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT id, lead_manager_active, zapi_token FROM tenants WHERE id = $1',
        [tenantId]
      );
      return rows[0] || null;
    });

    if (!tenant) {
      log.info('webhook.ignored', { reason: 'unknown_tenant' });
      return silentOk(res);
    }
    if (!tenant.lead_manager_active) {
      log.info('webhook.ignored', { reason: 'lead_manager_inactive' });
      return silentOk(res);
    }

    const provided = req.get('X-ZAPI-TOKEN');
    if (!tokenMatches(tenant.zapi_token || '', provided || '')) {
      log.warn('webhook.unauthorized', { reason: 'invalid_zapi_token' });
      return res.status(401).json({ error: 'invalid token' });
    }

    req.tenant = tenant;
    req.log = log;
    return next();
  } catch (err) {
    log.error('webhook.auth_error', { error: err.message });
    return res.status(500).json({ error: 'internal error' });
  }
}

/** Handler: persiste a mensagem recebida e a roteia para o Lead Manager. */
async function handleZapiWebhook(req, res) {
  const tenantId = req.tenant.id;
  const log = req.log;

  const msg = normalizeMessage(req.body);
  if (!msg || !msg.externalId) {
    log.info('webhook.no_message', { reason: 'unparseable_payload' });
    return res.status(200).json({ status: 'ok' });
  }
  if (msg.fromMe) {
    log.info('webhook.skipped', { reason: 'from_me' });
    return res.status(200).json({ status: 'ok' });
  }

  try {
    const result = await withTenant(tenantId, async (client) => {
      // upsert da conversa (uma thread por contato)
      const conv = await client.query(
        `INSERT INTO conversations (tenant_id, channel, external_id)
         VALUES ($1, 'whatsapp', $2)
         ON CONFLICT (tenant_id, channel, external_id)
         DO UPDATE SET updated_at = now()
         RETURNING id`,
        [tenantId, msg.externalId]
      );
      const conversationId = conv.rows[0].id;

      // insere a mensagem (idempotente por external_message_id)
      const inserted = await client.query(
        `INSERT INTO messages
           (tenant_id, conversation_id, direction, external_message_id, sender, body, raw)
         VALUES ($1, $2, 'inbound', $3, $4, $5, $6)
         ON CONFLICT (tenant_id, external_message_id)
           WHERE external_message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [tenantId, conversationId, msg.externalMessageId, msg.sender, msg.body, req.body]
      );
      return { conversationId, duplicate: inserted.rowCount === 0 };
    });

    log.info(result.duplicate ? 'webhook.duplicate' : 'webhook.received', {
      conversation_id: result.conversationId,
      external_message_id: msg.externalMessageId,
    });
    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    log.error('webhook.process_error', { error: err.message });
    return res.status(500).json({ error: 'internal error' });
  }
}

router.post('/zapi/:tenantId', authenticateTenant, handleZapiWebhook);

module.exports = router;
