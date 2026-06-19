-- ============================================================================
-- Grant de leitura cross-schema: o engine do lead-manager precisa checar se um
-- telefone é de PROFESSOR (contato de relacionamento) para o roteamento vivo —
-- professor NUNCA auto-promove pro funil (classifyConversa → Revisar).
-- Fonte única é app.professor_notificacao (schema do Scheduler), sem duplicar/sync.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f professor_notificacao_read.sql
--
-- READ-ONLY, uma tabela. Idempotente.
-- ============================================================================
GRANT USAGE ON SCHEMA app TO lead_manager_user;
GRANT SELECT ON app.professor_notificacao TO lead_manager_user;
