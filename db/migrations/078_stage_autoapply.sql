-- ============================================================
-- APLICAÇÃO AUTOMÁTICA DA SUGESTÃO DE ETAPA. A IA já detecta e sinaliza (suggested_stage, motivos com
-- data/hora extraídos da conversa — prova dada). Decisão do Leo: aplicar AUTOMÁTICO, SEM shadow, para
-- as etapas de baixo risco (reversíveis/erro barato). 'convertido' fica FORA por padrão (terminal,
-- contamina métrica de conversão) — segue suggestion-only p/ julgamento manual.
-- Molde bola_mode/gate_suppression_mode: flag por-tenant + log de auditoria com REVERTER (Monitor).
-- ADITIVA. Kill-switch = stage_autoapply_mode='off'.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 078_stage_autoapply.sql
-- ============================================================

-- (a) CONFIG por-tenant — molde bola_mode (mode off/on) + a LISTA de etapas elegíveis.
--   stage_autoapply_mode:   'off' (suggestion-only, como hoje) | 'on' (aplica no evento).
--   stage_autoapply_stages: quais KEYS de etapa podem ser aplicadas sozinhas. Default EXCLUI
--                           'convertido' e 'perdido' (terminais). Régua canônica = stages.js.
ALTER TABLE lead_manager.tenant_lead_config
  ADD COLUMN IF NOT EXISTS stage_autoapply_mode text NOT NULL DEFAULT 'off'
    CHECK (stage_autoapply_mode IN ('off','on')),
  ADD COLUMN IF NOT EXISTS stage_autoapply_stages text[] NOT NULL DEFAULT '{experimental,qualificado}';

-- Rollout: Valinhos LIGA (decisão do Leo: sem shadow — a observação já aconteceu). Idempotente.
-- 'convertido' propositalmente FORA da lista.
UPDATE lead_manager.tenant_lead_config
   SET stage_autoapply_mode = 'on',
       stage_autoapply_stages = '{experimental,qualificado}',
       updated_at = now()
 WHERE tenant_id = 'ed731a58-62e5-45ad-acba-a5502ff39e92'
   AND stage_autoapply_mode <> 'on';

-- (b) LOG de auditoria (append-only, RLS) — molde bola_shadow_log. Uma linha por MOVIMENTO automático.
--     Guarda o SNAPSHOT do estado ANTERIOR (status/desfecho/desfecho_em) + o evento de mudança criado,
--     para o REVERTER do Monitor restaurar EXATO (igual ao Undo do toast de /sugestao-etapa/restaurar).
--     source: 'event' (fluxo ao vivo) | 'backfill' (as 55 pendentes existentes).
CREATE TABLE IF NOT EXISTS lead_manager.stage_autoapply_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  lead_id             uuid NOT NULL REFERENCES lead_manager.leads(id) ON DELETE CASCADE,
  from_stage          text NOT NULL,                 -- etapa (key) ANTES do movimento
  to_stage            text NOT NULL,                 -- etapa (key) aplicada (= suggested_stage)
  reasoning           text,                          -- motivo que a IA registrou (stage_reasoning)
  source              text NOT NULL DEFAULT 'event' CHECK (source IN ('event','backfill')),
  external_message_id text,                          -- msg que disparou (quando via evento)
  prior_status        text,                          -- SNAPSHOT p/ o reverter restaurar EXATO
  prior_desfecho      text,
  prior_desfecho_em   timestamptz,
  evento_id           uuid,                          -- lead_eventos criado (o reverter apaga)
  reverted            boolean NOT NULL DEFAULT false, -- recepção reverteu no Monitor?
  reverted_at         timestamptz,
  reverted_by         text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lead_manager.stage_autoapply_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.stage_autoapply_log;
CREATE POLICY tenant_isolation ON lead_manager.stage_autoapply_log
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON lead_manager.stage_autoapply_log TO lead_manager_user;
CREATE INDEX IF NOT EXISTS idx_stage_autoapply_log_tenant_created
  ON lead_manager.stage_autoapply_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stage_autoapply_log_lead
  ON lead_manager.stage_autoapply_log (tenant_id, lead_id);

-- ROLLBACK:
--   DROP TABLE IF EXISTS lead_manager.stage_autoapply_log;
--   ALTER TABLE lead_manager.tenant_lead_config
--     DROP COLUMN IF EXISTS stage_autoapply_mode, DROP COLUMN IF EXISTS stage_autoapply_stages;
