-- ============================================================
-- E9-04 | Painel comercial: leituras cross-tenant (SECURITY DEFINER).
-- Executar como superuser "postgres".
--
-- Mesmo padrão da E9-03: o painel roda como lead_manager_user (sob RLS só
-- veria 1 tenant). Estas funções, de posse do "postgres", rodam como postgres
-- (bypassam RLS) e devolvem SOMENTE leitura agregada — alternativa estreita e
-- auditável ao platform_reader (BYPASSRLS), que segue ADIADO (DP-001).
-- ============================================================

-- Visão tenant x assinatura (uma linha por feature; LEFT JOIN inclui tenant
-- ainda sem assinatura).
CREATE OR REPLACE FUNCTION lead_manager.admin_tenant_overview()
RETURNS TABLE (
    tenant_id         uuid,
    tenant_name       text,
    tenant_created_at timestamptz,
    stripe_customer_id text,
    feature           text,
    status            text,
    valid_until       timestamptz,
    grace_until       timestamptz,
    trial_started_at  timestamptz,
    converted_at      timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = lead_manager, public
AS $$
    SELECT t.id, t.name, t.created_at, t.stripe_customer_id,
           s.feature, s.status, s.valid_until, s.grace_until, s.trial_started_at, s.converted_at
      FROM lead_manager.tenants t
      LEFT JOIN lead_manager.tenant_subscriptions s ON s.tenant_id = t.id
     ORDER BY t.created_at DESC, s.feature;
$$;
REVOKE ALL ON FUNCTION lead_manager.admin_tenant_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lead_manager.admin_tenant_overview() TO lead_manager_user;

-- Métricas comerciais agregadas.
--  conversions/expirations vêm do histórico append-only subscription_events
--  (a verdade do funil; ADR-004 §3). MRR estimado = Σ preço das ACTIVE.
CREATE OR REPLACE FUNCTION lead_manager.admin_commercial_metrics()
RETURNS TABLE (
    active_trials bigint,
    active_paid   bigint,
    conversions   bigint,
    expirations   bigint,
    estimated_mrr numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = lead_manager, public
AS $$
    SELECT
      (SELECT count(*) FROM lead_manager.tenant_subscriptions
         WHERE status = 'TRIALING' AND valid_until > now()),
      (SELECT count(*) FROM lead_manager.tenant_subscriptions
         WHERE status = 'ACTIVE'),
      (SELECT count(DISTINCT (tenant_id, feature)) FROM lead_manager.subscription_events
         WHERE type = 'ACTIVATED'),
      (SELECT count(DISTINCT (tenant_id, feature)) FROM lead_manager.subscription_events
         WHERE type = 'EXPIRED'),
      COALESCE((SELECT sum(fp.monthly_amount)
                  FROM lead_manager.tenant_subscriptions s
                  JOIN lead_manager.feature_prices fp ON fp.feature = s.feature
                 WHERE s.status = 'ACTIVE'), 0);
$$;
REVOKE ALL ON FUNCTION lead_manager.admin_commercial_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lead_manager.admin_commercial_metrics() TO lead_manager_user;
