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
  // Origem do lead (mídia paga). Apaga TUDO que pode carregar a pessoa:
  //   • telefone            -> sentinela
  //   • payload_bruto       -> o payload inteiro do webhook (telefone, nome de perfil,
  //                            texto da mensagem). É o campo mais sensível da tabela.
  //   • anuncio_url         -> costuma trazer parâmetros de rastreio
  //   • anuncio_titulo/texto-> reconstituíveis a partir do anuncio_id; não fazem falta
  // SOBREVIVEM só os nove que respondem "de qual anúncio veio": anuncio_id,
  // codigo_campanha, campanha_ref, motor, objetivo, publico, criativo, metodo,
  // capturado_em. Esquecer uma pessoa não pode reescrever a leitura da mídia paga.
  // O gatilho da migr. 171 exige exatamente esta forma — qualquer outra combinação
  // levanta exceção, então esta consulta e aquele gatilho mudam juntos.
  //
  // ⚠ TOLERA A MIGRAÇÃO 171 AINDA NÃO APLICADA, e só isso. Sem esta guarda, publicar o
  // código antes de aplicar a migração quebraria a exclusão de dados INTEIRA — /forget e a
  // retenção passariam a falhar por causa de uma tabela que ainda não existe. A ordem
  // correta continua sendo migração primeiro; a guarda é para o dia em que alguém inverter,
  // ou em que um rollback deixar código novo com banco antigo.
  // Só `undefined_table` (42P01) é tolerado: qualquer outro erro (permissão, gatilho,
  // restrição) PROPAGA, porque aí existe dado pessoal que deveria ter sido apagado e não foi.
  try {
    await client.query(
      `UPDATE origem_lead
          SET telefone = $2,
              payload_bruto = '{}'::jsonb,
              anuncio_url = NULL,
              anuncio_titulo = NULL,
              anuncio_texto = NULL
        WHERE tenant_id = $3
          AND (lead_id = $1 OR ($4 <> '' AND chave_contato = br_phone_key($4)))
          AND telefone NOT LIKE 'anonimizado\\_%'`,
      [leadId, anonPhone, tenantId, phone || '']
    );
  } catch (e) {
    if (e && e.code === '42P01') {
      // eslint-disable-next-line global-require
      require('./logger').warn('anonimizacao.origem_lead_ausente', {
        tenant_id: tenantId, lead_id: leadId,
        aviso: 'migração 171 não aplicada — a origem deste lead não foi anonimizada',
      });
    } else {
      throw e;
    }
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
