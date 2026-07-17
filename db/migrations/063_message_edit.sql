-- ============================================================
-- Fatia 2 WhatsApp-like — refletir EDIÇÃO de mensagem (cliente edita o que mandou).
-- Mostra o texto NOVO com rótulo "editada" (igual WhatsApp: sem histórico visível).
-- ADITIVA e não-destrutiva.
--
--   - edited_at    : quando a mensagem foi editada (NULL = nunca editada). É o que a
--                    timeline usa p/ desenhar o marcador "editada".
--   - original_body: 1º corpo antes da 1ª edição (AUDITORIA interna, NÃO exibido).
--                    Preenchido só na 1ª edição (COALESCE no handler); re-edição mantém.
--
-- Casa pelo external_message_id (= key.id da Evolution), que o inbound tem em 100% das
-- linhas. Outbound (external_message_id NULL em messages) não casa → foco no inbound.
--
-- Migrations manuais, sem runner (NUNCA db push):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 063_message_edit.sql
-- ============================================================

ALTER TABLE lead_manager.messages
  ADD COLUMN IF NOT EXISTS edited_at     timestamptz,
  ADD COLUMN IF NOT EXISTS original_body text;

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.messages DROP COLUMN IF EXISTS edited_at;
--   ALTER TABLE lead_manager.messages DROP COLUMN IF EXISTS original_body;
