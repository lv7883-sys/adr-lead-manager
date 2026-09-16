-- ============================================================
-- 120 — BOAS-VINDAS (ADR-050, E17-01): configuração por tenant.
--
-- Régua de mensagens para o cliente novo, da contratação até a pesquisa de satisfação. Multi-tenant
-- e multi-ramo: nada aqui fala de "aula" ou "professor".
--
--   boas_vindas_modo         desligado | avisa | auto. PADRÃO 'desligado': subir esta migration não
--                            muda o comportamento de nenhuma unidade.
--   boas_vindas_alerta_dias  dias sem o 1º atendimento até avisar a recepção (padrão 21, faixa 7–30).
--   boas_vindas_variaveis    variáveis livres da unidade para os textos, ex.: {"link_ead": "https://…"}.
--   boas_vindas_modelo       slug do modelo de régua de onde a unidade partiu (auditoria).
--
-- REGRA DE NÃO REGRESSÃO (ADR-050 §13.3): estas colunas são gravadas por endpoint PRÓPRIO, com UPDATE
-- só delas. Nunca entram no upsert do PUT /automacao (src/routes/tenant.js).
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 120_boas_vindas_config.sql
-- ROLLBACK:
--   ALTER TABLE lead_manager.automacao_config DROP COLUMN IF EXISTS boas_vindas_modo,
--     DROP COLUMN IF EXISTS boas_vindas_alerta_dias, DROP COLUMN IF EXISTS boas_vindas_variaveis,
--     DROP COLUMN IF EXISTS boas_vindas_modelo;
-- ============================================================
BEGIN;

ALTER TABLE lead_manager.automacao_config
  ADD COLUMN IF NOT EXISTS boas_vindas_modo        text     NOT NULL DEFAULT 'desligado',
  ADD COLUMN IF NOT EXISTS boas_vindas_alerta_dias smallint NOT NULL DEFAULT 21,
  ADD COLUMN IF NOT EXISTS boas_vindas_variaveis   jsonb    NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS boas_vindas_modelo      text;

ALTER TABLE lead_manager.automacao_config DROP CONSTRAINT IF EXISTS automacao_config_bv_modo_chk;
ALTER TABLE lead_manager.automacao_config ADD CONSTRAINT automacao_config_bv_modo_chk
  CHECK (boas_vindas_modo IN ('desligado', 'avisa', 'auto'));

ALTER TABLE lead_manager.automacao_config DROP CONSTRAINT IF EXISTS automacao_config_bv_alerta_chk;
ALTER TABLE lead_manager.automacao_config ADD CONSTRAINT automacao_config_bv_alerta_chk
  CHECK (boas_vindas_alerta_dias BETWEEN 7 AND 30);

ALTER TABLE lead_manager.automacao_config DROP CONSTRAINT IF EXISTS automacao_config_bv_variaveis_chk;
ALTER TABLE lead_manager.automacao_config ADD CONSTRAINT automacao_config_bv_variaveis_chk
  CHECK (jsonb_typeof(boas_vindas_variaveis) = 'object');

COMMENT ON COLUMN lead_manager.automacao_config.boas_vindas_modo IS
  'ADR-050: desligado | avisa (rascunho para a recepção) | auto. Padrão desligado.';
COMMENT ON COLUMN lead_manager.automacao_config.boas_vindas_alerta_dias IS
  'ADR-050: dias sem o 1º atendimento até alertar a recepção (7–30, padrão 21).';

COMMIT;
