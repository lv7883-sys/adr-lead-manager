-- ============================================================
-- Feedback de classificação (aprendizado — ADR-011 Fase 2). Quando a recepção
-- marca desfecho 'nao_e_lead', registramos o rótulo correto pra ajustar o
-- classificador no futuro.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 023_classification_feedback.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.classification_feedback (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  lead_id       uuid NOT NULL,
  correct_label text NOT NULL,           -- 'not_lead' | 'lead'
  feedback_by   text,
  feedback_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_classification_feedback_tenant
  ON lead_manager.classification_feedback (tenant_id, feedback_at);

-- O app escreve como lead_manager_user (sem RLS nesta tabela de log interno).
GRANT SELECT, INSERT ON lead_manager.classification_feedback TO lead_manager_user;
