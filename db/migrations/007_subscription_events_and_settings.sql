-- ============================================================
-- E9-02 | Eventos de assinatura (append-only) + settings de plataforma.
-- Executar como superuser "postgres".
-- ============================================================

-- ---- Histórico append-only de transições (verdade do funil — ADR-004 §3) ----
CREATE TABLE IF NOT EXISTS lead_manager.subscription_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    feature         text NOT NULL,
    type            text NOT NULL,                 -- TRIAL_STARTED | ACTIVATED | SUSPENDED | ...
    from_status     text,
    to_status       text NOT NULL,
    source          text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'STRIPE', 'SYSTEM')),
    actor           text,
    external_ref    text,                          -- ex.: stripe_subscription_id
    idempotency_key text,
    metadata        jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);
-- Idempotência: a mesma idempotency_key nunca gera dois eventos.
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_events_idem
    ON lead_manager.subscription_events (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscription_events_tenant_feature
    ON lead_manager.subscription_events (tenant_id, feature, created_at);

ALTER TABLE lead_manager.subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.subscription_events FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.subscription_events;
CREATE POLICY tenant_isolation ON lead_manager.subscription_events
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
-- Append-only no nível de privilégio: apenas SELECT/INSERT (sem UPDATE/DELETE).
GRANT SELECT, INSERT ON lead_manager.subscription_events TO lead_manager_user;

-- ---- Settings da plataforma (linha única; não tenant-scoped -> sem RLS) ----
CREATE TABLE IF NOT EXISTS lead_manager.platform_settings (
    id                 boolean PRIMARY KEY DEFAULT true CHECK (id),   -- garante 1 linha
    default_trial_days int NOT NULL DEFAULT 7  CHECK (default_trial_days > 0),
    grace_days         int NOT NULL DEFAULT 3  CHECK (grace_days >= 0),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO lead_manager.platform_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
GRANT SELECT, UPDATE ON lead_manager.platform_settings TO lead_manager_user;

-- ---- Preços por feature (para MRR estimado; não tenant-scoped -> sem RLS) ----
CREATE TABLE IF NOT EXISTS lead_manager.feature_prices (
    feature        text PRIMARY KEY CHECK (feature IN ('SCHEDULER', 'LEAD_MANAGER')),
    monthly_amount numeric(10,2) NOT NULL DEFAULT 0,
    currency       text NOT NULL DEFAULT 'BRL',
    updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO lead_manager.feature_prices (feature, monthly_amount, currency) VALUES
    ('LEAD_MANAGER', 0, 'BRL'),
    ('SCHEDULER',    0, 'BRL')
ON CONFLICT (feature) DO NOTHING;
GRANT SELECT, INSERT, UPDATE ON lead_manager.feature_prices TO lead_manager_user;
