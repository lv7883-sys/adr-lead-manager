-- ============================================================
-- Requalificação pela recepção + few-shot learning. Campos novos que o esboço
-- referencia mas não existiam (correction_context/corrected_temperature no
-- feedback; temperatura_manual no lead).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 025_requalificacao.sql
-- ============================================================

ALTER TABLE lead_manager.classification_feedback
  ADD COLUMN IF NOT EXISTS correction_context   text,
  ADD COLUMN IF NOT EXISTS corrected_temperature text;

-- Override manual de temperatura (recepção). NULL = temperatura derivada (padrão).
ALTER TABLE lead_manager.leads
  ADD COLUMN IF NOT EXISTS temperatura_manual text
    CHECK (temperatura_manual IN ('quente', 'morno', 'frio'));
