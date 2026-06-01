-- ============================================================
-- E9-01 | RBAC (roles por user+tenant) + assinaturas (ADR-004).
-- Executar como superuser "postgres".
--
-- Isolamento (ADR-001): tudo no schema lead_manager. NÃO toca app.usuario
-- (Scheduler). users aqui é o registro próprio do Lead Manager.
-- ============================================================

-- ---- Usuários (registro próprio; NÃO é tenant-scoped -> sem RLS) ----
CREATE TABLE IF NOT EXISTS lead_manager.users (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email             text,
    is_platform_admin boolean NOT NULL DEFAULT false,   -- Leo (global, cruza tenants)
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email
    ON lead_manager.users (lower(email)) WHERE email IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.users TO lead_manager_user;

-- ---- Membership: papel de um usuário DENTRO de um tenant (RLS) ----
CREATE TABLE IF NOT EXISTS lead_manager.tenant_members (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES lead_manager.users(id) ON DELETE CASCADE,
    tenant_id  uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    role       text NOT NULL CHECK (role IN ('TENANT_ADMIN', 'RECEPCAO', 'VISUALIZADOR')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant ON lead_manager.tenant_members (tenant_id);

ALTER TABLE lead_manager.tenant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.tenant_members FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.tenant_members;
CREATE POLICY tenant_isolation ON lead_manager.tenant_members
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.tenant_members TO lead_manager_user;

-- ---- Stripe (Fase 3): colunas nullable agora, inertes até o Stripe entrar ----
ALTER TABLE lead_manager.tenants ADD COLUMN IF NOT EXISTS stripe_customer_id text;

-- ---- Assinatura por (tenant, feature) — estrutura; máquina de estado é E9-02 ----
CREATE TABLE IF NOT EXISTS lead_manager.tenant_subscriptions (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    feature                text NOT NULL CHECK (feature IN ('SCHEDULER', 'LEAD_MANAGER')),
    status                 text NOT NULL DEFAULT 'TRIALING'
                           CHECK (status IN ('TRIALING','ACTIVE','PAST_DUE','GRACE','EXPIRED','SUSPENDED','CANCELED')),
    trial_started_at       timestamptz,
    valid_until            timestamptz,
    grace_until            timestamptz,
    converted_at           timestamptz,
    canceled_at            timestamptz,
    stripe_subscription_id text,   -- nullable até a Fase 3
    stripe_price_id        text,   -- nullable até a Fase 3
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, feature)
);

ALTER TABLE lead_manager.tenant_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.tenant_subscriptions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.tenant_subscriptions;
CREATE POLICY tenant_isolation ON lead_manager.tenant_subscriptions
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.tenant_subscriptions TO lead_manager_user;

-- ---- Auditoria de impersonation do PLATFORM_ADMIN (plataforma; sem RLS) ----
-- Sem FK em tenant_id de propósito: a trilha de auditoria sobrevive à exclusão
-- do tenant. platform_user_id encadeia com users para integridade do ator.
CREATE TABLE IF NOT EXISTS lead_manager.impersonation_audit (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform_user_id uuid NOT NULL REFERENCES lead_manager.users(id) ON DELETE CASCADE,
    tenant_id        uuid NOT NULL,
    action           text,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_impersonation_audit_tenant ON lead_manager.impersonation_audit (tenant_id);
GRANT SELECT, INSERT ON lead_manager.impersonation_audit TO lead_manager_user;

-- ---- Mapeamento de papéis legados (Scheduler app.usuario) ----
-- Papéis reais na origem: admin | gerente | recepcionista (NÃO há visualizador).
-- Decisão E9-01: admin/gerente -> TENANT_ADMIN ; recepcionista -> RECEPCAO.
-- O BACKFILL está ADIADO: não existe vínculo franquia(int) <-> tenants(uuid),
-- e lead_manager.tenants está vazia. Quando o vínculo existir, um script de
-- migração lê app.usuario, mapeia via esta função e insere em tenant_members.
CREATE OR REPLACE FUNCTION lead_manager.map_legacy_role(papel text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE papel
        WHEN 'admin'         THEN 'TENANT_ADMIN'
        WHEN 'gerente'       THEN 'TENANT_ADMIN'
        WHEN 'recepcionista' THEN 'RECEPCAO'
        ELSE NULL
    END
$$;
GRANT EXECUTE ON FUNCTION lead_manager.map_legacy_role(text) TO lead_manager_user;
