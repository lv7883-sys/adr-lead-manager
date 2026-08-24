'use strict';

// Captura amostras de mensagens OUTBOUND da recepção (fromMe) para aprendizado
// contínuo do estilo (ex.: voz da Késsia). Best-effort: falha aqui nunca afeta
// o webhook (que já respondeu 200). Idempotente por external_message_id.

const { withTenant } = require('./db');
const logger = require('./logger');

// "Responder = ler" (badge de não-lidas): quando a recepção responde por um app WhatsApp real
// (WhatsApp Web/celular), a LEITURA não volta como recibo (leitura no Web não propaga) — mas a
// RESPOSTA volta pelo eco fromMe. Então uma saída HUMANA (source de device) marca a conversa como
// lida até o instante da resposta. NÃO usamos 'api' (Regente já marca lido ao abrir) nem 'unknown'
// (pode ser envio automático — NPS/campanha) p/ nunca esconder uma não-lida genuína.
const FONTES_HUMANAS = new Set(['web', 'android', 'ios', 'desktop']);

async function captureOutbound(tenantId, msg, rawBody) {
  if (!msg) return;
  // Antes só capturava TEXTO. Agora uma saída só-mídia (áudio/imagem/doc) também vira
  // resposta: o body ganha placeholder legível ('[áudio]'/'[imagem]'/…) e grava media_*
  // (sem baixar o arquivo nem transcrever aqui — isso fica pro próximo pacote). O que
  // importa p/ "virar a bola" é ter uma linha com received_at. media_url fica NULL: o
  // front só renderiza player quando há url, então mostra apenas o placeholder.
  const media = msg.media || null;
  const body = msg.body || (media && (media.placeholder || '[mídia]')) || null;
  if (!body && !media) return null; // nada aproveitável (sem texto e sem mídia)
  // migr. 103: marca saída para GRUPO (@g.us) a partir do remoteJid cru do eco. A lista da
  // Caixa de Entrada exclui grupos por esta coluna (sem reabrir o JSON `raw` por linha).
  const remoteJid = (rawBody && rawBody.data && rawBody.data.key && rawBody.data.key.remoteJid) || '';
  const isGroup = String(remoteJid).endsWith('@g.us');
  try {
    const inserted = await withTenant(tenantId, async (c) => {
      const ins = await c.query(
        `INSERT INTO staff_outbound_samples
           (tenant_id, channel, external_id, external_message_id, source, sender, body, raw,
            media_type, media_filename, is_group)
         VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, external_message_id)
           WHERE external_message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [tenantId, msg.externalId, msg.externalMessageId, msg.source ?? null, msg.sender ?? null, body, rawBody,
         media ? (media.kind || null) : null, media ? (media.filename || null) : null, isGroup]
      );
      // "Responder = ler": saída HUMANA 1:1 avança o last_read_at até o instante da resposta (roda
      // sempre, mesmo no ON CONFLICT — a resposta aconteceu). Usa o timestamp do eco (não now())
      // p/ não marcar lida uma entrada que chegou entre a resposta e o processamento do webhook.
      if (!isGroup && FONTES_HUMANAS.has(msg.source)) {
        const dig = String(msg.externalId || '').replace(/\D/g, '');
        const tsUnix = rawBody && rawBody.data && rawBody.data.messageTimestamp;
        const readAt = tsUnix ? new Date(Number(tsUnix) * 1000) : new Date();
        if (dig) await c.query(
          `UPDATE conversations SET last_read_at = $3
             WHERE tenant_id = $1 AND regexp_replace(external_id, '[^0-9]', '', 'g') = $2
               AND (last_read_at IS NULL OR last_read_at < $3)`,
          [tenantId, dig, readAt]
        );
      }
      return ins;
    });
    if (inserted.rowCount > 0) {
      logger.info('staff_sample.captured', { tenant_id: tenantId, source: msg.source ?? null });
    }
    // ADR-030 Passo 2: expõe rowCount/id p/ o enganche da classificação de saída só
    // disparar em linha NOVA (rowCount>0), nunca no eco duplicado (ON CONFLICT DO NOTHING).
    return { rowCount: inserted.rowCount, id: inserted.rows[0] ? inserted.rows[0].id : null };
  } catch (err) {
    logger.warn('staff_sample.error', { tenant_id: tenantId, error: err.message });
    return null;
  }
}

module.exports = { captureOutbound };
