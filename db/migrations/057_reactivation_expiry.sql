-- ============================================================
-- ADR-027 Reativação Etapa 1 — "dias até Perdido" por tenant. O lead em reativação que
-- não reengaja após esse tempo é considerado PERDIDO (derivado por TEMPO, nunca por clique).
-- ADITIVA + INERTE: default 45 (escola tem ciclo lento). Editável em Configurações de Leads
-- → Regras. Mesmo molde do dormancy_days. Lido sempre da config, nunca cravado.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 057_reactivation_expiry.sql
-- ============================================================

ALTER TABLE lead_manager.tenant_lead_config
  ADD COLUMN IF NOT EXISTS reactivation_expiry_days int NOT NULL DEFAULT 45
    CHECK (reactivation_expiry_days BETWEEN 1 AND 365);

-- ROLLBACK:
--   ALTER TABLE lead_manager.tenant_lead_config DROP COLUMN IF EXISTS reactivation_expiry_days;
