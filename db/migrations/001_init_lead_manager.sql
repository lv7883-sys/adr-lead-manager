-- ============================================================
-- E6-01 | AI Lead Manager — schema base + RLS
-- Isolado do Scheduler (schema "app"). Executar como superuser
-- "postgres", pois lead_manager_user não tem CREATE no database.
-- ============================================================

-- 1. Schema próprio, de posse do usuário da aplicação.
CREATE SCHEMA IF NOT EXISTS lead_manager AUTHORIZATION lead_manager_user;

-- 2. search_path padrão do app: nunca enxerga o schema "app" do Scheduler.
ALTER ROLE lead_manager_user SET search_path = lead_manager, public;

GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;

-- 3. Tabela de tenants (raiz do isolamento multi-tenant).
CREATE TABLE IF NOT EXISTS lead_manager.tenants (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Tabela de leads, sempre vinculada a um tenant.
CREATE TABLE IF NOT EXISTS lead_manager.leads (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    name       text NOT NULL,
    phone      text,
    email      text,
    status     text NOT NULL DEFAULT 'new',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_tenant ON lead_manager.leads (tenant_id);

-- 5. Row Level Security.
--    ENABLE  -> ativa a política.
--    FORCE   -> aplica RLS até para o dono da tabela (lead_manager_user),
--               garantindo o isolamento mesmo no usuário da aplicação.
ALTER TABLE lead_manager.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.tenants FORCE  ROW LEVEL SECURITY;
ALTER TABLE lead_manager.leads   ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.leads   FORCE  ROW LEVEL SECURITY;

-- 6. Políticas baseadas na variável de sessão app.current_tenant.
--    O backend faz: SET app.current_tenant = '<uuid>' por request.
--    NULLIF(...,'') trata tanto a var ausente (NULL) quanto resetada ('')
--    como "sem contexto" -> nenhuma linha = deny por padrão, sem erro de cast.
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.leads;
CREATE POLICY tenant_isolation ON lead_manager.leads
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

DROP POLICY IF EXISTS tenant_self ON lead_manager.tenants;
CREATE POLICY tenant_self ON lead_manager.tenants
    USING (id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- 7. Privilégios de dados para o usuário da aplicação.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA lead_manager TO lead_manager_user;
GRANT USAGE, SELECT                  ON ALL SEQUENCES  IN SCHEMA lead_manager TO lead_manager_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA lead_manager
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO lead_manager_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA lead_manager
    GRANT USAGE, SELECT                  ON SEQUENCES TO lead_manager_user;
