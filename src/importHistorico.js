'use strict';
//
// importHistorico.js — ADR-042: backfill do HISTÓRICO do WhatsApp na timeline do inbox.
// É SÓ importação (histórico + contatos): NÃO roda triagem, NÃO cria/altera lead, NÃO aciona a
// Janis. A IA/funil só entram quando a conversa é RETOMADA (mensagem nova, fluxo normal do webhook).
//
// Fonte = mensagens do Evolution (findMessages) OU do lote de sincronização. Aqui só o "destino":
// recebe mensagens já normalizadas e grava idempotentemente (dedup por external_message_id):
//   - fromMe=false -> messages (role USER)             [mensagem do contato]
//   - fromMe=true  -> staff_outbound_samples (nossa saída antiga), source='historico'
// Marca as inbound com raw.source='historico'. Best-effort por mensagem; nunca lança.
//
const { withTenant } = require('./db');
const logger = require('./logger');

// Registro cru do Evolution (findMessages) -> { externalMessageId, fromMe, body, sender, atMs }.
// Retorna null p/ registro sem id de mensagem. atMs = epoch ms (Evolution manda em segundos).
function mapEvolutionMsg(rec) {
  if (!rec || !rec.key) return null;
  const m = rec.message || {};
  const body = (m.conversation != null ? m.conversation
    : (m.extendedTextMessage && m.extendedTextMessage.text != null ? m.extendedTextMessage.text : null));
  return {
    externalMessageId: rec.key.id ? String(rec.key.id) : null,
    fromMe: !!rec.key.fromMe,
    body: body || '',
    sender: rec.pushName || null,
    atMs: rec.messageTimestamp ? Number(rec.messageTimestamp) * 1000 : null,
  };
}

// Importa uma leva de mensagens de UMA conversa. msgs = [{externalMessageId, fromMe, body, sender, atMs}].
// externalId = número/jid do contato. Idempotente. Retorna { conv, inseridos, pulados }.
async function importarConversa(tenantId, { channel = 'whatsapp', externalId, msgs = [] }, deps = {}) {
  if (!tenantId || !externalId || !Array.isArray(msgs) || !msgs.length) return { conv: null, inseridos: 0, pulados: 0 };
  const run = deps.withTenant || withTenant;
  try {
    return await run(tenantId, async (c) => {
      const conv = (await c.query(
        `INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, channel, external_id) DO UPDATE SET updated_at = conversations.updated_at
         RETURNING id`, [tenantId, channel, String(externalId)])).rows[0];
      let inseridos = 0; let pulados = 0;
      for (const m of msgs) {
        if (!m || !m.externalMessageId || (!m.body && !m.sender)) { pulados++; continue; }
        const at = m.atMs ? new Date(Number(m.atMs)) : new Date();
        let r;
        if (m.fromMe) {
          r = await c.query(
            `INSERT INTO staff_outbound_samples (tenant_id, channel, external_id, external_message_id, source, sender, body, raw, received_at)
             VALUES ($1,$2,$3,$4,'historico',$5,$6,'{}'::jsonb,$7)
             ON CONFLICT (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING`,
            [tenantId, channel, String(externalId), String(m.externalMessageId), m.sender || null, m.body || '', at]);
        } else {
          r = await c.query(
            `INSERT INTO messages (tenant_id, conversation_id, direction, role, external_message_id, sender, body, raw, received_at)
             VALUES ($1,$2,'inbound','USER',$3,$4,$5,$6,$7)
             ON CONFLICT (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING`,
            [tenantId, conv.id, String(m.externalMessageId), m.sender || null, m.body || '', JSON.stringify({ source: 'historico' }), at]);
        }
        if (r.rowCount) inseridos++; else pulados++;
      }
      return { conv: conv.id, inseridos, pulados };
    });
  } catch (e) {
    logger.warn('historico.import_failed', { tenant_id: tenantId, external_id: String(externalId), error: e.message });
    return { conv: null, inseridos: 0, pulados: (msgs || []).length, erro: e.message };
  }
}

module.exports = { mapEvolutionMsg, importarConversa };
