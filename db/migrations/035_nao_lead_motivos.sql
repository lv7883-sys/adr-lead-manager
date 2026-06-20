-- ============================================================================
-- Motivos de "não é lead" POR TENANT (rótulo content-based pra IA aprender).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 035_nao_lead_motivos.sql
--
-- Config por TÓPICO (nunca por identidade). Vive em tenant_lead_config — mesma casa
-- da definição de lead do tenant (futuro lead_definition), pra não espalhar config.
-- A recepção, ao marcar "não é lead" na Revisar, escolhe um motivo; ele entra em
-- classification_feedback.correction_context (o few-shot que calibra o classificador).
-- "Outro (digitar)" é texto livre adicionado em runtime — NÃO fica nesta lista.
--
-- Aditiva e idempotente. Default no código (tenant.js) cobre quem ficar com NULL.
-- ============================================================================

ALTER TABLE lead_manager.tenant_lead_config
    ADD COLUMN IF NOT EXISTS nao_lead_motivos jsonb;

-- Seed do tenant ADR Valinhos — tópicos (não identidade).
UPDATE lead_manager.tenant_lead_config
   SET nao_lead_motivos = '[
         {"value":"renovacao_cobranca","label":"Renovação / cobrança"},
         {"value":"remarcacao_agenda","label":"Remarcação / reposição / agenda"},
         {"value":"aviso_ausencia","label":"Aviso de ausência"},
         {"value":"assunto_interno","label":"Assunto interno"},
         {"value":"fornecedor","label":"Fornecedor"},
         {"value":"sem_intencao_matricula","label":"Sem intenção de matrícula"},
         {"value":"spam","label":"Spam"}
       ]'::jsonb,
       updated_at = now()
 WHERE tenant_id = 'ed731a58-62e5-45ad-acba-a5502ff39e92';
