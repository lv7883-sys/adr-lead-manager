-- ============================================================
-- ADR-029 fatia 3 — flag de supressão do Portão 0 por tenant + TTL da pré-sinalização.
-- ADITIVA. `gate_suppression_mode` default 'off' = INERTE (nenhum tenant muda o gate até
-- alguém setar 'shadow'/'on'). `presignal_ttl_days` = parâmetro de Regras de Leads
-- (ADR-028 §5.2); 30d é DEFAULT DE SEED, lido sempre da config (nunca constante no código);
-- a edição por UI vem na fatia 5. NOT NULL DEFAULT constante = catálogo-only em PG11+
-- (tabela de 1 linha por tenant — sem custo de rewrite relevante).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 054_gate_flag.sql
-- ============================================================

ALTER TABLE lead_manager.tenant_lead_config
  ADD COLUMN IF NOT EXISTS gate_suppression_mode text NOT NULL DEFAULT 'off'
    CHECK (gate_suppression_mode IN ('off','shadow','on')),
  ADD COLUMN IF NOT EXISTS presignal_ttl_days int NOT NULL DEFAULT 30
    CHECK (presignal_ttl_days BETWEEN 1 AND 365);

-- ROLLBACK:
--   ALTER TABLE lead_manager.tenant_lead_config
--     DROP COLUMN IF EXISTS gate_suppression_mode,
--     DROP COLUMN IF EXISTS presignal_ttl_days;
