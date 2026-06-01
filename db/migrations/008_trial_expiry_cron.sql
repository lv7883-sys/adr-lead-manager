-- ============================================================
-- E9-03 | Cron de expiração de trial: marcos de lembrete + enumeração
-- cross-tenant controlada. Executar como superuser "postgres".
-- ============================================================

-- ---- Idempotência de lembretes (plataforma; sem RLS) ----
CREATE TABLE IF NOT EXISTS lead_manager.reminder_sent (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id uuid NOT NULL REFERENCES lead_manager.tenant_subscriptions(id) ON DELETE CASCADE,
    marco           text NOT NULL CHECK (marco IN ('D-3', 'D-1', 'EXPIRED')),
    sent_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (subscription_id, marco)
);
GRANT SELECT, INSERT ON lead_manager.reminder_sent TO lead_manager_user;

-- ---- Enumeração cross-tenant para o cron (SECURITY DEFINER) ----
-- O job roda como lead_manager_user, que sob RLS só veria o tenant corrente.
-- Esta função, de posse do superuser "postgres", roda como postgres
-- (bypassa RLS) e devolve SOMENTE a leitura mínima necessária (TRIALING/GRACE).
-- É a travessia cross-tenant controlada e auditável — alternativa estreita ao
-- papel platform_reader (BYPASSRLS), que segue ADIADO (DP-001).
CREATE OR REPLACE FUNCTION lead_manager.trial_lifecycle_due()
RETURNS TABLE (
    subscription_id uuid,
    tenant_id       uuid,
    feature         text,
    status          text,
    valid_until     timestamptz,
    grace_until     timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = lead_manager, public
AS $$
    SELECT id, tenant_id, feature, status, valid_until, grace_until
      FROM lead_manager.tenant_subscriptions
     WHERE status IN ('TRIALING', 'GRACE');
$$;

REVOKE ALL ON FUNCTION lead_manager.trial_lifecycle_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lead_manager.trial_lifecycle_due() TO lead_manager_user;
