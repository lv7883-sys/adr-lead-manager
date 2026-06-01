'use strict';

// Captura amostras de mensagens OUTBOUND da recepção (fromMe) para aprendizado
// contínuo do estilo (ex.: voz da Késsia). Best-effort: falha aqui nunca afeta
// o webhook (que já respondeu 200). Idempotente por external_message_id.

const { withTenant } = require('./db');
const logger = require('./logger');

async function captureOutbound(tenantId, msg, rawBody) {
  if (!msg || !msg.body) return; // só interessa texto
  try {
    const inserted = await withTenant(tenantId, (c) =>
      c.query(
        `INSERT INTO staff_outbound_samples
           (tenant_id, channel, external_id, external_message_id, source, sender, body, raw)
         VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, external_message_id)
           WHERE external_message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [tenantId, msg.externalId, msg.externalMessageId, msg.source ?? null, msg.sender ?? null, msg.body, rawBody]
      )
    );
    if (inserted.rowCount > 0) {
      logger.info('staff_sample.captured', { tenant_id: tenantId, source: msg.source ?? null });
    }
  } catch (err) {
    logger.warn('staff_sample.error', { tenant_id: tenantId, error: err.message });
  }
}

module.exports = { captureOutbound };
