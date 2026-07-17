-- ============================================================
-- Fatia 3 WhatsApp-like — refletir EXCLUSÃO de mensagem ("apagar para todos").
-- Mostra "🚫 Esta mensagem foi apagada" (igual WhatsApp), SEM apagar a linha nem o body
-- (body preservado p/ auditoria interna; a UI substitui o conteúdo pela frase). ADITIVA.
--
--   - deleted_at : quando a mensagem foi apagada (NULL = não apagada). É o que a timeline
--                  usa p/ trocar o conteúdo da bolha pela frase de apagada.
--
-- Casa pelo external_message_id (= key.id da Evolution), que o inbound tem em 100% das
-- linhas. Outbound (external_message_id NULL em messages) não casa → foco no inbound.
--
-- Migrations manuais, sem runner (NUNCA db push):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 064_message_deleted.sql
-- ============================================================

ALTER TABLE lead_manager.messages
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.messages DROP COLUMN IF EXISTS deleted_at;
