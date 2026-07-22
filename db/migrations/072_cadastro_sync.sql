-- ============================================================
-- ADR-037 — CRON de sincronização de contratos/alunos (molde ADR-026). ADITIVA.
-- 2 colunas em service_account (marca de sync + soft-delete "sumiu da fonte", NUNCA apaga) +
-- 1 tabela de log de execução (espelha resources.resource_sync_log). RLS FORCE.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 072_cadastro_sync.sql
--
-- ROLLBACK: DROP TABLE cadastro_sync_log; ALTER TABLE service_account DROP COLUMN last_synced_at, DROP COLUMN fonte_ausente_em;
-- ============================================================

-- Marca de sync + SOFT-DELETE do contrato. `fonte_ausente_em` = quando o contrato sumiu da
-- Extranet (NULL = presente). Nunca deletamos o espelho: a linha fica, marcada, e é reportada.
ALTER TABLE lead_manager.service_account
  ADD COLUMN IF NOT EXISTS last_synced_at   timestamptz,
  ADD COLUMN IF NOT EXISTS fonte_ausente_em timestamptz;

COMMENT ON COLUMN lead_manager.service_account.fonte_ausente_em IS
  'Soft-delete do cron (ADR-037): quando o contrato deixou de aparecer na fonte (Extranet). NULL = presente. Nunca apaga a linha (espelho); reaparecer → volta a NULL.';

-- Log de execução do cron (1 linha/run), espelha resources.resource_sync_log. Saúde + auditoria.
CREATE TABLE IF NOT EXISTS lead_manager.cadastro_sync_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL,                          -- 'SCRAPE_EXTRANET' (reusa o binding de recursos)
  status       text NOT NULL,                          -- OK | ERROR | SKIPPED | SAFEGUARD
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  duration_ms  integer,
  stats        jsonb,                                  -- {contratos_novos, atualizados, inalterados, soft_deleted, pessoas_alertas, fetches, ...}
  error        text,
  error_kind   text,                                   -- CREDENTIAL | TRANSIENT | SAFEGUARD | UNKNOWN
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lead_manager.cadastro_sync_log OWNER TO lead_manager_user;
ALTER TABLE lead_manager.cadastro_sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.cadastro_sync_log FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.cadastro_sync_log;
CREATE POLICY tenant_isolation ON lead_manager.cadastro_sync_log
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_cadastro_sync_log_tenant_created
  ON lead_manager.cadastro_sync_log (tenant_id, created_at DESC);

COMMENT ON TABLE lead_manager.cadastro_sync_log IS
  'ADR-037 cron de cadastro: histórico de execução (molde resources.resource_sync_log). Saúde/auditoria do sync diário de contratos/alunos.';
