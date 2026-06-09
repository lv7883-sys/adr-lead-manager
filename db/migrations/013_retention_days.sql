-- ============================================================
-- Retenção automática (item de segurança 4). RODAR COMO SUPERUSER postgres
-- (ALTER em tenants/platform_settings, que são do postgres).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 013_retention_days.sql
-- ============================================================

-- retention_days por tenant (NULL = usa o default global).
ALTER TABLE lead_manager.tenants
    ADD COLUMN IF NOT EXISTS retention_days int;

-- default global (2 anos).
ALTER TABLE lead_manager.platform_settings
    ADD COLUMN IF NOT EXISTS default_retention_days int NOT NULL DEFAULT 730;

-- Lista (tenant, retention_days) cruzando RLS — para o cron mensal iterar.
-- SECURITY DEFINER (owned by postgres) — mesmo padrão de trial_lifecycle_due().
CREATE OR REPLACE FUNCTION lead_manager.tenants_for_retention()
RETURNS TABLE(tenant_id uuid, retention_days int)
LANGUAGE sql SECURITY DEFINER SET search_path = lead_manager AS $$
  SELECT id, retention_days FROM lead_manager.tenants;
$$;
GRANT EXECUTE ON FUNCTION lead_manager.tenants_for_retention() TO lead_manager_user;
