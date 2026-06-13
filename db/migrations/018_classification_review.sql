-- ============================================================
-- Bloco 2 — score de confiança + fila de revisão (zero lead perdido).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 018_classification_review.sql
-- ============================================================

ALTER TABLE lead_manager.leads
    ADD COLUMN IF NOT EXISTS classification_confidence decimal(4,3),
    ADD COLUMN IF NOT EXISTS classification_reasoning  text,
    ADD COLUMN IF NOT EXISTS classification_signals    jsonb,
    ADD COLUMN IF NOT EXISTS review_queue boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS review_result text
        CHECK (review_result IN ('confirmed_lead', 'confirmed_not_lead')),
    ADD COLUMN IF NOT EXISTS review_em timestamptz,
    ADD COLUMN IF NOT EXISTS review_by text;

-- Índice parcial: a fila de revisão (lista frequente, filtra esses dois campos).
CREATE INDEX IF NOT EXISTS leads_review_queue_idx
    ON lead_manager.leads (tenant_id)
    WHERE review_queue = true AND review_result IS NULL;
