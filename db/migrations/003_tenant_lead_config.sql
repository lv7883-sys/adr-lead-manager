-- ============================================================
-- E7-01 | Configuração de Lead Manager por tenant (admin API).
-- Executar como superuser "postgres".
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.tenant_lead_config (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL UNIQUE REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    school_name            text  NOT NULL,
    system_prompt_override text,                              -- nullable: null = usa template padrão
    available_instruments  text[] NOT NULL DEFAULT '{}',
    business_hours         jsonb  NOT NULL DEFAULT '{}',      -- { "mon": "09:00-18:00", ... }
    notification_whatsapp  text,                              -- E.164, ex: +5511999998888
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

-- RLS (ENABLE + FORCE) + isolamento por tenant, consistente com as demais tabelas.
ALTER TABLE lead_manager.tenant_lead_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.tenant_lead_config FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON lead_manager.tenant_lead_config;
CREATE POLICY tenant_isolation ON lead_manager.tenant_lead_config
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.tenant_lead_config TO lead_manager_user;
