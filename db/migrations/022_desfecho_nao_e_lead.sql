-- ============================================================
-- Desfecho "não é lead" — recepção marca um lead como não-lead pelo desfecho.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 022_desfecho_nao_e_lead.sql
-- ============================================================

ALTER TABLE lead_manager.leads
  DROP CONSTRAINT IF EXISTS leads_desfecho_check,
  ADD CONSTRAINT leads_desfecho_check CHECK (desfecho IN (
    'matriculado',
    'nao_matriculado_preco',
    'nao_matriculado_horario',
    'nao_matriculado_concorrente',
    'nao_matriculado_desistiu',
    'nao_compareceu_aula',
    'nao_e_lead',
    'outro'
  ));
