'use strict';

// FONTE ÚNICA do caminho de saída (outbound) do WhatsApp. Extraído de tenant.js p/ ser
// reusado pelo inbox conversation-centric (ADR-042 / E12-06) sem duplicar. Comportamento
// idêntico ao inline anterior.

const { withTenant } = require('./db');
const { decrypt } = require('./crypto');
const { isUuid } = require('./validation');

// Registra a saída REAL (fromMe) em staff_outbound_samples (source='api'). O eco do webhook
// deduplica por (tenant_id, external_message_id). channel fixo 'whatsapp' (Fase 1).
//
// is_group (migr. 103): AQUI é obrigatório marcar. O eco do webhook deduz do remoteJid do `raw`, mas
// esta linha nasce sem raw (source='api') e sempre chega ANTES do eco — que então cai no ON CONFLICT
// e não corrige nada. Sem a marca, uma resposta mandada no GRUPO pelo Regente ficava indistinguível
// de uma conversa privada: aparecia na thread de quem tivesse os mesmos dígitos e ressuscitava a
// conversa na Caixa de Entrada (era a "mensagem duplicada" que a recepção via). O chamador manda
// `isGroup` (sabe o tipo da conversa); o sufixo @g.us do destino serve de rede.
async function registrarSaida(tenantId, { phone, externalMessageId, sender, body, media, replyToMessageId, isGroup }) {
  const ehGrupo = isGroup === true || /@g\.us$/i.test(String(phone || ''));
  await withTenant(tenantId, (c) => c.query(
    `INSERT INTO staff_outbound_samples
       (tenant_id, channel, external_id, external_message_id, source, sender, body, raw,
        media_url, media_type, media_filename, reply_to_message_id, is_group)
     VALUES ($1, 'whatsapp', $2, $3, 'api', $4, $5, NULL, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING`,
    [tenantId, phone, externalMessageId || null, sender || 'Recepção', body || null,
     (media && media.url) || null, (media && media.type) || null, (media && media.filename) || null,
     replyToMessageId || null, ehGrupo]
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

// Resolve a KEY do WhatsApp de uma bolha OUTBOUND nossa a partir do `mid` (id-da-linha).
// Serve p/ APAGAR e EDITAR (mesma key). Cobre recepcao (staff_outbound_samples) e IA
// (pending_approvals → eco em staff_outbound). Tenant-scoped (NÃO precisa de lead) — por
// isso serve o inbox conversation-centric. Devolve { key, soId, deleted_at, phone, paId } ou
// null (não é saída nossa / bolha do lead / sem id da Evolution). Extraído de tenant.js.
async function resolverKeyMensagem(c, tenantId, mid) {
  let r = (await c.query(
    `SELECT id AS so_id, external_message_id AS msg_id,
            raw#>>'{data,key,remoteJid}' AS remote_jid,
            regexp_replace(external_id, '[^0-9]', '', 'g') AS phone,
            deleted_at, NULL::uuid AS pa_id
       FROM staff_outbound_samples
      WHERE tenant_id = $1 AND id = $2`, [tenantId, mid])).rows[0];
  if (!r) {
    r = (await c.query(
      `SELECT s.id AS so_id, s.external_message_id AS msg_id,
              s.raw#>>'{data,key,remoteJid}' AS remote_jid,
              regexp_replace(s.external_id, '[^0-9]', '', 'g') AS phone,
              s.deleted_at, pa.id AS pa_id
         FROM pending_approvals pa
         JOIN staff_outbound_samples s
           ON s.tenant_id = pa.tenant_id AND s.body = pa.suggested_response
        WHERE pa.tenant_id = $1 AND pa.id = $2 AND pa.status IN ('APPROVED', 'EDITED')
        ORDER BY s.received_at DESC LIMIT 1`, [tenantId, mid])).rows[0];
  }
  if (!r || !r.msg_id) return null;
  const remoteJid = r.remote_jid || (r.phone ? `${r.phone}@s.whatsapp.net` : null);
  if (!remoteJid) return null;
  return { key: { id: r.msg_id, remoteJid, fromMe: true }, soId: r.so_id, deleted_at: r.deleted_at, phone: r.phone, paId: r.pa_id };
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

module.exports = { registrarSaida, msgCitada, credsForTenant, resolverKeyMensagem };
