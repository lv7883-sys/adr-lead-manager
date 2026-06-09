'use strict';

const crypto = require('crypto');

// Anonimiza um lead (LGPD). Roda DENTRO de uma transação que já tem o contexto
// de tenant ativo (withTenant). Reusado por /forget (manual) e pelo job de
// retenção (automático). Mantém métricas (status, datas, intent, completude);
// remove PII (nome, telefone, email) e o conteúdo das mensagens; audita.
async function anonymizeLead(client, { tenantId, leadId, phone, actor, action, details }) {
  const anonPhone = 'anonimizado_' +
    crypto.createHash('sha256').update(String(phone || leadId)).digest('hex').slice(0, 16);

  if (phone) {
    await client.query(
      `UPDATE messages SET body = '[removido]', sender = NULL, raw = NULL
        WHERE conversation_id IN (SELECT id FROM conversations WHERE external_id = $1)`,
      [phone]
    );
    // O external_id da conversa continha o telefone -> anonimiza também.
    await client.query('UPDATE conversations SET external_id = $2 WHERE external_id = $1', [phone, anonPhone]);
  }
  // Nome extraído é PII -> remove (mantém instrumento/disponibilidade/completude).
  await client.query('UPDATE lead_qualifications SET name = NULL WHERE lead_id = $1', [leadId]);
  // Anonimiza o lead. MANTÉM status, datas e intent (métricas).
  await client.query(
    "UPDATE leads SET name = 'Anonimizado', phone = $2, email = NULL, updated_at = now() WHERE id = $1",
    [leadId, anonPhone]
  );
  // Trilha de auditoria (sem PII).
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor, action, target_type, target_id, details)
     VALUES ($1, $2, $3, 'lead', $4, $5)`,
    [tenantId, actor ?? null, action || 'lead.forget', leadId, JSON.stringify(details || {})]
  );
  return anonPhone;
}

module.exports = { anonymizeLead };
