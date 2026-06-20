-- ============================================================================
-- SUGESTÃO DE ETAPA PELA IA (suggestion-only) — eixo de POSIÇÃO no funil.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 038_stage_suggestion.sql
--
-- A IA (classifyConversa) lê a conversa e SUGERE mover o lead para uma etapa do
-- kanban (ex.: detectou agendamento de experimental → sugere a coluna "experimental").
-- SEMPRE sugestão + confirmação humana 1-clique — NUNCA move sozinho. Distinto de
-- lead-ness (is_lead) e de temperatura: aqui é só POSIÇÃO.
--
-- Config por tenant (sem hardcode de etapa na lógica):
--   tenant_lead_config.stage_definitions (jsonb) = { "<key estável da etapa>": "<o que
--   dispara a etapa, em linguagem natural>" }. As keys referenciam o stages.js do
--   dashboard (fonte única das colunas). Só as etapas que faz sentido a IA sugerir.
--   'perdido' fica DE FORA de propósito: exige motivo (desfecho) e é decisão humana.
--
-- No lead:
--   suggested_stage           = etapa sugerida pela IA (key do stages.js) ou NULL
--   stage_reasoning           = 1 frase citando o trecho da conversa que disparou
--   stage_suggested_at        = quando a IA emitiu a sugestão
--   suggested_stage_dismissed = última etapa dispensada pela recepção (não re-sugerir
--                               o MESMO evento dispensado; uma etapa diferente é novo)
--
-- Aditiva e idempotente.
-- ============================================================================

ALTER TABLE lead_manager.tenant_lead_config
    ADD COLUMN IF NOT EXISTS stage_definitions jsonb;

ALTER TABLE lead_manager.leads
    ADD COLUMN IF NOT EXISTS suggested_stage           text,
    ADD COLUMN IF NOT EXISTS stage_reasoning           text,
    ADD COLUMN IF NOT EXISTS stage_suggested_at        timestamptz,
    ADD COLUMN IF NOT EXISTS suggested_stage_dismissed text;

-- Índice parcial: o filtro "só com sugestão pendente" varre por suggested_stage não-nulo.
CREATE INDEX IF NOT EXISTS leads_suggested_stage_idx
    ON lead_manager.leads (tenant_id)
    WHERE suggested_stage IS NOT NULL;

-- Seed do tenant ADR Valinhos — descrições naturais por etapa (keys = stages.js).
-- Só as etapas de progresso que a IA consegue inferir da conversa com segurança.
UPDATE lead_manager.tenant_lead_config
   SET stage_definitions = '{
         "qualificado": "o lead demonstrou interesse real e já forneceu os dados básicos (instrumento de interesse e/ou disponibilidade de horário), mas ainda NÃO há uma aula experimental agendada com data/horário.",
         "experimental": "a recepção confirmou o agendamento de uma aula experimental com este lead, com data e/ou horário definidos na conversa.",
         "convertido": "o lead confirmou a matrícula / fechou a contratação das aulas (efetivou, vai pagar/pagou, ou disse explicitamente que quer matricular)."
       }'::jsonb,
       updated_at = now()
 WHERE tenant_id = 'ed731a58-62e5-45ad-acba-a5502ff39e92';
