-- ============================================================================
-- DEFINIÇÃO DE NEGÓCIO/LEAD POR TENANT (generalização multi-tenant do classificador).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 039_lead_definition.sql
--
-- O classifyConversa deixa de ter a definição de lead CRAVADA no prompt (escola de
-- música / aula / matrícula / renovação). O prompt vira um TEMPLATE genérico de "negócio"
-- que injeta `lead_definition` do tenant. Mesma casa da config de classificação
-- (tenant_lead_config — junto de nao_lead_motivos e stage_definitions), pra não espalhar.
--
-- SEM UI de config (adiado pro 2º tenant): por ora só o campo + seed do ADR via SQL.
-- NULL/vazio → o prompt cai num default genérico mínimo (nenhum domínio assumido).
--
-- Aditiva e idempotente.
-- ============================================================================

ALTER TABLE lead_manager.tenant_lead_config
    ADD COLUMN IF NOT EXISTS lead_definition text;

-- Seed do tenant ADR Valinhos — o domínio que ANTES estava cravado no prompt.
UPDATE lead_manager.tenant_lead_config
   SET lead_definition = 'Negócio: escola de música. LEAD = interesse em nova matrícula/curso, aula experimental, indicação, novo aluno (inclusive de cliente existente para 2º curso ou outro filho). ROTINA/NÃO-LEAD = remarcação de aula, renovação, cobrança, evento interno, agradecimento, ausência de aluno existente.',
       updated_at = now()
 WHERE tenant_id = 'ed731a58-62e5-45ad-acba-a5502ff39e92';
