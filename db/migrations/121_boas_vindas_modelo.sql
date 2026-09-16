-- ============================================================
-- 121 — BOAS-VINDAS (ADR-050, E17-01): CATÁLOGO GLOBAL de modelos de régua.
--
-- Um modelo é uma régua pronta para um ramo ("Escola de música — Academia do Rock", futuramente
-- "Clínica", "Academia de ginástica"…). Ao ligar o módulo, a unidade COPIA um modelo para as suas
-- próprias etapas (boas_vindas_etapa, migr. 123) e edita a cópia. Mudar o modelo depois não altera
-- quem já copiou.
--
-- Catálogo da PLATAFORMA: sem tenant_id, sem RLS, SOMENTE LEITURA para o lead_manager_user.
-- Escrita só por migration.
--
-- ÂNCORAS (genéricas, qualquer ramo):
--   inicio_contrato       contratação fechada (matrícula)
--   atendimento_agendado  próximo atendimento marcado (próxima aula / consulta)
--   primeiro_atendimento  primeiro atendimento realizado (1ª aula dada)
-- QUANDO (jsonb):
--   {"tipo":"dias","valor":N}      N dias após a âncora, no primeiro horário de atendimento do dia
--   {"tipo":"vespera"}             dia anterior ao atendimento, fim do expediente (só atendimento_agendado)
--   {"tipo":"proximo_expediente"}  primeiro horário de atendimento depois do atendimento
-- As travas completas (R1–R10) vivem em src/boasVindasRegua.js; os CHECKs abaixo são a rede de
-- segurança estrutural.
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 121_boas_vindas_modelo.sql
-- ROLLBACK:
--   DROP TABLE IF EXISTS lead_manager.boas_vindas_modelo_etapa; DROP TABLE IF EXISTS lead_manager.boas_vindas_modelo;
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS lead_manager.boas_vindas_modelo (
  slug       text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  nome       text NOT NULL,
  ramo       text,                                  -- rótulo do ramo; casa com automacao_config.ramo_atividade (119)
  descricao  text,
  ativo      boolean NOT NULL DEFAULT true,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_manager.boas_vindas_modelo_etapa (
  modelo_slug        text     NOT NULL REFERENCES lead_manager.boas_vindas_modelo (slug) ON DELETE CASCADE,
  ordem              smallint NOT NULL CHECK (ordem BETWEEN 1 AND 10),
  nome               text     NOT NULL,
  ancora             text     NOT NULL
                       CHECK (ancora IN ('inicio_contrato', 'atendimento_agendado', 'primeiro_atendimento')),
  quando             jsonb    NOT NULL,
  repeticoes         smallint NOT NULL DEFAULT 1 CHECK (repeticoes BETWEEN 1 AND 3),
  contrato_curto     boolean  NOT NULL DEFAULT false,  -- roda também em contrato de até 45 dias
  texto_titular      text,
  texto_responsavel  text,                             -- NULL = usa o texto do titular
  anexo_sugerido     text,                             -- o arquivo que a unidade deve subir, em palavras
  anexo_tipo         text CHECK (anexo_tipo IS NULL OR anexo_tipo IN ('imagem', 'video', 'audio', 'documento')),
  entregue_por       text     NOT NULL DEFAULT 'regente' CHECK (entregue_por IN ('regente', 'externo')),
  PRIMARY KEY (modelo_slug, ordem),
  CONSTRAINT bv_modelo_etapa_quando_chk CHECK (
       (coalesce(quando->>'tipo', '') = 'dias' AND coalesce(quando->>'valor', '') ~ '^[0-9]{1,2}$')
    OR (coalesce(quando->>'tipo', '') = 'vespera' AND ancora = 'atendimento_agendado')
    OR (coalesce(quando->>'tipo', '') = 'proximo_expediente' AND ancora IN ('atendimento_agendado', 'primeiro_atendimento'))
  ),
  CONSTRAINT bv_modelo_etapa_repeticoes_chk CHECK (repeticoes = 1 OR ancora = 'atendimento_agendado'),
  CONSTRAINT bv_modelo_etapa_conteudo_chk CHECK (texto_titular IS NOT NULL OR entregue_por = 'externo')
);

-- Catálogo da plataforma: o dono continua sendo quem aplica a migration (superusuário), e o app só
-- recebe SELECT. De propósito NÃO é OWNER TO lead_manager_user — dono poderia reescrever o catálogo.
GRANT SELECT ON lead_manager.boas_vindas_modelo, lead_manager.boas_vindas_modelo_etapa TO lead_manager_user;

COMMIT;
