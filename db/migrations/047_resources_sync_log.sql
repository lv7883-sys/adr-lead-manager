-- ============================================================================
-- 047_resources_sync_log.sql
-- ADR-026 §2.4 (Parte 3) — INFRA do sincronizador diário. GENÉRICA/agnóstica de fonte.
--   (1) colunas de SAÚDE no binding (visibilidade de falha p/ dashboard futuro);
--   (2) tabela resource_sync_log (histórico de execuções, 1 linha por binding/run).
--
-- ADITIVA e IDEMPOTENTE: ADD COLUMN IF NOT EXISTS / CREATE ... IF NOT EXISTS /
-- DROP POLICY IF EXISTS. NÃO altera nada do schema lead_manager. Espelha o padrão de
-- RLS por tenant do 046 (ENABLE+FORCE+policy por app.current_tenant).
--
-- NÃO inclui a fatia DATADA (occupation_snapshot/resource_exception) — essa é a 048.
--
-- RODAR COMO postgres (migrations manuais, sem runner; ver memória):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 047_resources_sync_log.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Saúde da última sincronização, no próprio binding (DP-D). `status` segue sendo
--    o flag de ciclo (ACTIVE/…); a SAÚDE vai em colunas próprias pra um erro
--    transitório (429/Extranet fora) NÃO desligar o binding do próximo run.
-- ---------------------------------------------------------------------------
ALTER TABLE resources.resource_source_binding
    ADD COLUMN IF NOT EXISTS last_sync_at     timestamptz,
    ADD COLUMN IF NOT EXISTS last_sync_status text,            -- 'OK' | 'ERROR'
    ADD COLUMN IF NOT EXISTS last_error       text,
    -- categoria da falha: CREDENTIAL = humano precisa resolver (login rejeitado);
    -- TRANSIENT = se auto-resolve (429/Extranet fora/timeout); SAFEGUARD/UNKNOWN.
    ADD COLUMN IF NOT EXISTS last_error_kind  text;

-- ---------------------------------------------------------------------------
-- 2. resource_sync_log — histórico de execuções (1 linha por binding por run).
--    stats jsonb = contagens do core (inserted/updated/softDeleted/links/availability).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resources.resource_sync_log (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    source_binding_id  uuid REFERENCES resources.resource_source_binding(id) ON DELETE SET NULL,
    kind               text,                                   -- SCRAPE_EXTRANET | API | NATIVE
    status             text NOT NULL,                          -- 'OK' | 'ERROR' | 'SKIPPED'
    started_at         timestamptz NOT NULL,
    finished_at        timestamptz NOT NULL DEFAULT now(),
    duration_ms        integer,
    stats              jsonb,                                  -- contagens do core
    error              text,                                   -- mensagem em falha
    error_kind         text,                                   -- CREDENTIAL|TRANSIENT|SAFEGUARD|UNKNOWN
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resource_sync_log_tenant_started_idx
    ON resources.resource_sync_log (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS resource_sync_log_binding_idx
    ON resources.resource_sync_log (source_binding_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- 3. RLS na tabela nova (mesmo padrão do 046).
-- ---------------------------------------------------------------------------
ALTER TABLE resources.resource_sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources.resource_sync_log FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON resources.resource_sync_log;
CREATE POLICY tenant_isolation ON resources.resource_sync_log
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 4. Privilégios (ALTER DEFAULT PRIVILEGES do 046 já cobre tabelas novas, mas
--    explicitamos por garantia/idempotência).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON resources.resource_sync_log TO lead_manager_user;
