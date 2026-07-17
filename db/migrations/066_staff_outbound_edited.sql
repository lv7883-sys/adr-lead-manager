-- ============================================================
-- Fatia AÇÃO-2 — EDITAR nossa mensagem a partir do LM (updateMessage), igual WhatsApp.
-- Refletir a edição do NOSSO lado: as Fatias 2 marcaram só messages (inbound); as nossas
-- saídas ficam em staff_outbound_samples. ADITIVA e não-destrutiva. NÃO toca no que a
-- Ação-1 fez (staff_outbound_samples.deleted_at, mig 065).
--
--   - edited_at    : quando NÓS editamos a mensagem enviada (NULL = não editada). É o que a
--                    timeline usa p/ o marcador "editada". Só é setado APÓS a Evolution
--                    confirmar a edição no WhatsApp.
--   - original_body: 1º corpo antes da 1ª edição (AUDITORIA interna, NÃO exibido). COALESCE
--                    na 1ª edição; re-edição mantém.
--
-- Migrations manuais, sem runner (NUNCA db push):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 066_staff_outbound_edited.sql
-- ============================================================

ALTER TABLE lead_manager.staff_outbound_samples
  ADD COLUMN IF NOT EXISTS edited_at     timestamptz,
  ADD COLUMN IF NOT EXISTS original_body text;

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.staff_outbound_samples DROP COLUMN IF EXISTS edited_at;
--   ALTER TABLE lead_manager.staff_outbound_samples DROP COLUMN IF EXISTS original_body;
