-- ============================================================================
-- Citação ("responder mensagem anterior") — backend casado com o front do Scheduler.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 033_quoted_reply.sql
--
-- Coluna nullable reply_to_message_id, FK -> messages.id (a mensagem CITADA — em
-- geral o inbound do lead, que carrega a key do WhatsApp em raw->'data'->'key').
-- Adicionada nas 3 tabelas que alimentam a timeline, pois cada linha OUTBOUND
-- citante vive numa delas neste codebase:
--   - messages                 (inbound do lead / ASSISTANT da IA)
--   - staff_outbound_samples   (envios da recepção: /mensagem e /mensagem-meta)
--   - pending_approvals        (resposta aprovada da IA: /approve)
-- ON DELETE SET NULL: apagar a citada nunca quebra o histórico do citante.
-- Aditiva e idempotente.
-- ============================================================================

ALTER TABLE lead_manager.messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id uuid
    REFERENCES lead_manager.messages(id) ON DELETE SET NULL;

ALTER TABLE lead_manager.staff_outbound_samples
  ADD COLUMN IF NOT EXISTS reply_to_message_id uuid
    REFERENCES lead_manager.messages(id) ON DELETE SET NULL;

ALTER TABLE lead_manager.pending_approvals
  ADD COLUMN IF NOT EXISTS reply_to_message_id uuid
    REFERENCES lead_manager.messages(id) ON DELETE SET NULL;
