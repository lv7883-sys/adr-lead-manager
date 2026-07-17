-- ============================================================
-- Fatia AÇÃO-1 — APAGAR nossa mensagem a partir do LM (deleteMessageForEveryone).
-- Refletir a exclusão do NOSSO lado: as fatias 3 marcaram só messages (inbound); as
-- nossas saídas ficam em staff_outbound_samples. ADITIVA e não-destrutiva.
--
--   - deleted_at : quando NÓS apagamos a mensagem enviada (NULL = não apagada). É o que a
--                  timeline usa p/ trocar a bolha outbound por "🚫 Esta mensagem foi apagada".
--                  Só é setado APÓS a Evolution confirmar o apagamento no WhatsApp.
--
-- Migrations manuais, sem runner (NUNCA db push):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 065_staff_outbound_deleted.sql
-- ============================================================

ALTER TABLE lead_manager.staff_outbound_samples
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.staff_outbound_samples DROP COLUMN IF EXISTS deleted_at;
