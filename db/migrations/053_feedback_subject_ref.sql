-- ============================================================
-- ADR-029 — veredito referencia o assunto (eixo de assunto). ADITIVA: coluna nullable
-- SEM default → mudança de catálogo instantânea (sem rewrite/lock longo). `correct_label`
-- segue intacto (back-compat); `subject_id` só será populado pelos handlers na fatia 3+.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 053_feedback_subject_ref.sql
-- ============================================================

ALTER TABLE lead_manager.classification_feedback
  ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES lead_manager.subject_definition(id);

-- ROLLBACK:
--   ALTER TABLE lead_manager.classification_feedback DROP COLUMN IF EXISTS subject_id;
