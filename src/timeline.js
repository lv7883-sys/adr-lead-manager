'use strict';

// FONTE ÚNICA da timeline de uma conversa (ADR-031). Mescla as 3 fontes reais que capturamos:
//   - 'lead'     : entrada do lead (messages role USER)
//   - 'recepcao' : respostas REAIS da recepção no WhatsApp/redes (fromMe, staff_outbound_samples)
//   - 'ia'       : respostas da IA APROVADAS/enviadas (pending_approvals, deduplicadas pelo eco)
// Casamento por dígitos do external_id (não há FK conversa↔lead). Extraída de tenant.js
// (/leads/:id) p/ ser reusada pelo inbox conversation-centric (ADR-042 / E12-05) SEM duplicar.
//
// Parâmetros da query: $1 = tenantId · $2 = ident (dígitos) · $3 = leadId (uuid | null).
// leadId só é usado no ramo 'ia' (pending_approvals) e no dedup do 'recepcao'. Passando NULL
// (conversa de NÃO-LEAD), esses ramos ficam vazios e a timeline traz só lead + recepção.

const TIMELINE_SQL = `WITH reac AS (
                   -- ADR-031 item 3: reações em escopo, com emoji e id da mensagem-alvo.
                   SELECT m.raw#>>'{data,message,reactionMessage,text}'   AS emoji,
                          m.raw#>>'{data,message,reactionMessage,key,id}'  AS target_key,
                          m.received_at
                     FROM messages m
                     JOIN conversations cv ON cv.id = m.conversation_id
                    WHERE cv.tenant_id = $1
                      AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = $2
                      AND m.role = 'USER'
                      AND coalesce(m.raw#>>'{data,message,reactionMessage,text}','') <> ''
                 ),
                 bubkeys AS (
                   -- external_message_ids das bolhas que podem RECEBER reação
                   -- (recepcao + mensagem do lead que NAO e reacao).
                   SELECT s.external_message_id AS k
                     FROM staff_outbound_samples s
                    WHERE s.tenant_id = $1 AND regexp_replace(s.external_id, '[^0-9]', '', 'g') = $2
                      AND s.external_message_id IS NOT NULL
                   UNION
                   SELECT m.external_message_id
                     FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
                    WHERE cv.tenant_id = $1 AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = $2
                      AND m.role = 'USER' AND m.external_message_id IS NOT NULL
                      AND coalesce(m.raw#>>'{data,message,reactionMessage,text}','') = ''
                 )
                 SELECT t.id, t.received_at, t.kind, t.sender, t.body,
                        t.media_url, t.media_type, t.media_filename, t.media_transcription, t.reactions, t.ack_status, t.edited_at, t.deleted_at,
                        t.reply_to_id, rt.role AS rt_role, rt.body AS rt_body, rt.media_type AS rt_media_type
                   FROM (
                   -- Entrada do LEAD (USER). Rascunhos da IA (ASSISTANT) NAO entram na
                   -- conversa: os pendentes pertencem ao bloco "Resposta sugerida".
                   SELECT m.id, m.reply_to_message_id AS reply_to_id, m.received_at, 'lead' AS kind, m.sender, m.body,
                          m.media_url, m.media_type, m.media_filename, m.media_transcription,
                          (SELECT array_agg(r.emoji ORDER BY r.received_at) FROM reac r
                            WHERE r.target_key = m.external_message_id) AS reactions,
                          NULL::text AS ack_status,   -- inbound (lead) nao tem check
                          m.edited_at,                -- Fatia 2: marcador "editada"
                          m.deleted_at                -- Fatia 3: marcador "apagada"
                     FROM messages m
                     JOIN conversations cv ON cv.id = m.conversation_id
                    WHERE cv.tenant_id = $1
                      AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = $2
                      AND m.role = 'USER'
                      -- ADR-031 item 3: some da lista a reacao QUE GRUDOU num alvo visivel; a
                      -- que nao casou (sem alvo capturado) permanece como bolha "[reacao] X".
                      AND NOT ( coalesce(m.raw#>>'{data,message,reactionMessage,text}','') <> ''
                                AND m.raw#>>'{data,message,reactionMessage,key,id}' IN (SELECT k FROM bubkeys) )
                   UNION ALL
                   -- Respostas REAIS da recepcao (fromMe). Exclui GRUPOS (@g.us — nunca
                   -- sao conversa com o lead) e os textos que a IA ja enviou (mostrados
                   -- abaixo como 'ia', pra nao duplicar).
                   SELECT s.id, s.reply_to_message_id AS reply_to_id, s.received_at, 'recepcao' AS kind, s.sender, s.body,
                          s.media_url, s.media_type, s.media_filename, NULL AS media_transcription,
                          (SELECT array_agg(r.emoji ORDER BY r.received_at) FROM reac r
                            WHERE r.target_key = s.external_message_id) AS reactions,
                          s.ack_status,   -- check da recepcao (direto da saida)
                          s.edited_at,   -- ACAO-2: edicao da recepcao (direto da saida)
                          s.deleted_at   -- ACAO-1: exclusao da recepcao (direto da saida)
                     FROM staff_outbound_samples s
                    WHERE s.tenant_id = $1
                      AND regexp_replace(s.external_id, '[^0-9]', '', 'g') = $2
                      AND coalesce(s.raw->'data'->'key'->>'remoteJid', '') NOT LIKE '%@g.us'
                      AND s.body NOT IN (
                        SELECT pa.suggested_response FROM pending_approvals pa
                         WHERE pa.tenant_id = $1 AND pa.lead_id = $3
                           AND pa.status IN ('APPROVED', 'EDITED')
                           AND pa.suggested_response IS NOT NULL
                      )
                   UNION ALL
                   -- Respostas da IA que foram APROVADAS/ENVIADAS ao cliente (tag "IA").
                   -- received_at = hora do ENVIO real (eco, mesmo JOIN por corpo do ack/edited/
                   -- deleted); so cai em pa.created_at se ainda nao houver eco (rascunho nao
                   -- enviado). Isso alinha a janela de 15min do editar, o horario exibido e a
                   -- ordenacao cronologica ao envio real, nao a geracao do rascunho.
                   SELECT pa.id, pa.reply_to_message_id AS reply_to_id,
                          COALESCE((SELECT so.received_at FROM staff_outbound_samples so
                                     WHERE so.tenant_id = $1
                                       AND regexp_replace(so.external_id, '[^0-9]', '', 'g') = $2
                                       AND so.body = pa.suggested_response
                                     ORDER BY so.received_at DESC LIMIT 1), pa.created_at) AS received_at,
                          'ia' AS kind, NULL AS sender,
                          pa.suggested_response AS body,
                          NULL AS media_url, NULL AS media_type, NULL AS media_filename, NULL AS media_transcription,
                          NULL::text[] AS reactions,
                          -- check da IA: o id da Evolution esta na saida (eco), deduplicada
                          -- fora da timeline; casa pelo corpo (mesmo criterio do NOT IN acima).
                          (SELECT so.ack_status FROM staff_outbound_samples so
                            WHERE so.tenant_id = $1
                              AND regexp_replace(so.external_id, '[^0-9]', '', 'g') = $2
                              AND so.body = pa.suggested_response
                            ORDER BY so.received_at DESC LIMIT 1) AS ack_status,
                          -- ACAO-2: edicao da IA — edited_at vive no eco (mesmo JOIN por corpo)
                          (SELECT so.edited_at FROM staff_outbound_samples so
                            WHERE so.tenant_id = $1
                              AND regexp_replace(so.external_id, '[^0-9]', '', 'g') = $2
                              AND so.body = pa.suggested_response
                            ORDER BY so.received_at DESC LIMIT 1) AS edited_at,
                          -- ACAO-1: exclusao da IA — deleted_at vive no eco (mesmo JOIN por corpo do ack)
                          (SELECT so.deleted_at FROM staff_outbound_samples so
                            WHERE so.tenant_id = $1
                              AND regexp_replace(so.external_id, '[^0-9]', '', 'g') = $2
                              AND so.body = pa.suggested_response
                            ORDER BY so.received_at DESC LIMIT 1) AS deleted_at
                     FROM pending_approvals pa
                    WHERE pa.tenant_id = $1 AND pa.lead_id = $3
                      AND pa.status IN ('APPROVED', 'EDITED')
                      AND pa.suggested_response IS NOT NULL
                 ) t
                 LEFT JOIN messages rt ON rt.id = t.reply_to_id
                 ORDER BY t.received_at ASC`;

// Monta reply_to {id, author:"lead"|"staff", preview}. author vem do papel da citada
// (USER=lead; ASSISTANT=escola/IA=staff). preview: ~80 chars ou "[midia]".
function mapTimelineRow(r) {
  const row = {
    id: r.id, received_at: r.received_at, kind: r.kind, sender: r.sender, body: r.body,
    media_url: r.media_url, media_type: r.media_type, media_filename: r.media_filename,
    media_transcription: r.media_transcription,
    reactions: Array.isArray(r.reactions) ? r.reactions : null,   // ADR-031 item 3
    ack_status: r.ack_status || null,   // Fatia 1 — check so nas saidas (null no inbound)
    edited_at: r.edited_at || null,      // Fatia 2 — marcador "editada" (inbound)
    deleted_at: r.deleted_at || null,    // Fatia 3 — marcador "apagada" (inbound)
    reply_to: null,
  };
  if (r.reply_to_id) {
    const txt = r.rt_body && r.rt_body.trim() ? r.rt_body.trim() : null;
    row.reply_to = {
      id: r.reply_to_id,
      author: r.rt_role === 'USER' ? 'lead' : 'staff',
      preview: txt ? txt.slice(0, 80) : (r.rt_media_type ? '[mídia]' : ''),
    };
  }
  return row;
}

// Roda a timeline dentro de um client já no contexto (RLS no handler; postgres no itest).
// ident = dígitos do telefone/psid. leadId opcional (null p/ conversa de não-lead).
async function fetchTimeline(c, { tenantId, ident, leadId = null }) {
  if (!ident) return [];
  const rows = (await c.query(TIMELINE_SQL, [tenantId, ident, leadId])).rows;
  return rows.map(mapTimelineRow);
}

module.exports = { TIMELINE_SQL, mapTimelineRow, fetchTimeline };
