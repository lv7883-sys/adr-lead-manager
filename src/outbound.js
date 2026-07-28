'use strict';

// FONTE ÚNICA do caminho de saída (outbound) do WhatsApp. Extraído de tenant.js p/ ser
// reusado pelo inbox conversation-centric (ADR-042 / E12-06) sem duplicar. Comportamento
// idêntico ao inline anterior.

const { withTenant } = require('./db');
const { decrypt } = require('./crypto');
const { isUuid } = require('./validation');

// Registra a saída REAL (fromMe) em staff_outbound_samples (source='api'). O eco do webhook
// deduplica por (tenant_id, external_message_id). channel fixo 'whatsapp' (Fase 1).
async function registrarSaida(tenantId, { phone, externalMessageId, sender, body, media, replyToMessageId }) {
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

// Resolve a mensagem citada (linha de messages). Devolve { id, role, body, media_type, wa_key }
// ou null. wa_key = key do WhatsApp (raw->data->key) usada no quoted da Evolution.
async function msgCitada(tenantId, replyToMessageId) {
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

// Credenciais Evolution do tenant (instance + apikey decifrada). Sem lead — chave por tenant.
async function credsForTenant(tenantId) {
  return withTenant(tenantId, async (c) => {
    const tnt = (await c.query(
      'SELECT evolution_instance, evolution_token_enc FROM tenants WHERE id = $1', [tenantId]
    )).rows[0] || {};
    return { instance: tnt.evolution_instance, apikey: decrypt(tnt.evolution_token_enc) };
  });
}

module.exports = { registrarSaida, msgCitada, credsForTenant };
