-- ============================================================
-- 119 — PERFIL DA ASSISTENTE por unidade/empresa (multi-tenant, qualquer ramo de atividade).
--
-- Pedido do dono (16/09/2026): além do que já existe em Configurações de Leads, a assistente precisa de
-- CONTEXTO, TIPO COMPORTAMENTAL e de um campo para o que ela NÃO DEVE FALAR — pensado para empresas de
-- outros ramos, não só escola de música.
--   ramo_atividade    — "Escola de música", "Clínica odontológica"… (NULL = legado: escola de música)
--   objetivo_conversa — próximo passo que ela busca com interessados ("agendar uma aula experimental
--                       gratuita", "agendar uma avaliação"). NULL = legado (aula experimental).
--   estilo_ia         — tipo comportamental: acolhedora | consultiva | profissional | objetiva | descontraida
--                       (NULL = sem perfil definido; vale o tom padrão de hoje).
--   comportamento_ia  — instruções livres de comportamento/tom (ex.: "não use emojis").
--   nao_falar         — assuntos que ela nunca deve tratar. Na resposta automática viram TRAVA (aviso fixo).
-- O contexto da empresa reaproveita contexto_ia (088), que passa a valer em TODAS as respostas.
-- Tudo NULL/vazio = comportamento idêntico ao anterior (nenhuma unidade muda sem configurar).
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 119_perfil_assistente.sql
-- ROLLBACK:
--   ALTER TABLE lead_manager.automacao_config DROP COLUMN IF EXISTS ramo_atividade, DROP COLUMN IF EXISTS objetivo_conversa,
--     DROP COLUMN IF EXISTS estilo_ia, DROP COLUMN IF EXISTS comportamento_ia, DROP COLUMN IF EXISTS nao_falar;
-- ============================================================
BEGIN;

ALTER TABLE lead_manager.automacao_config
  ADD COLUMN IF NOT EXISTS ramo_atividade    text,
  ADD COLUMN IF NOT EXISTS objetivo_conversa text,
  ADD COLUMN IF NOT EXISTS estilo_ia         text,
  ADD COLUMN IF NOT EXISTS comportamento_ia  text,
  ADD COLUMN IF NOT EXISTS nao_falar         text[] NOT NULL DEFAULT '{}';

ALTER TABLE lead_manager.automacao_config DROP CONSTRAINT IF EXISTS automacao_config_estilo_ia_chk;
ALTER TABLE lead_manager.automacao_config ADD CONSTRAINT automacao_config_estilo_ia_chk
  CHECK (estilo_ia IS NULL OR estilo_ia IN ('acolhedora','consultiva','profissional','objetiva','descontraida'));

COMMIT;
