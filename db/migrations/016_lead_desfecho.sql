-- ============================================================
-- ADR-011 Fase 1 — desfecho do lead (resultado final capturado pela recepção).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 016_lead_desfecho.sql
-- ============================================================

ALTER TABLE lead_manager.leads
    ADD COLUMN IF NOT EXISTS desfecho text CHECK (desfecho IN (
        'matriculado',
        'nao_matriculado_preco',
        'nao_matriculado_horario',
        'nao_matriculado_concorrente',
        'nao_matriculado_desistiu',
        'nao_compareceu_aula',
        'outro'
    ));

ALTER TABLE lead_manager.leads
    ADD COLUMN IF NOT EXISTS desfecho_notas text;

ALTER TABLE lead_manager.leads
    ADD COLUMN IF NOT EXISTS desfecho_em timestamptz;
