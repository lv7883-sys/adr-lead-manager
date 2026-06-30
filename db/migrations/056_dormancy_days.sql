-- ============================================================
-- ADR-028 — N de dormência por tenant ("lead ativo" = última interação <= N dias).
-- O "N único" do §6/§5: fonte única, lido sempre da config (nunca constante no código).
-- ADITIVA + INERTE: default 7 = o valor que estava cravado no dashboard. Editável por
-- gerente/admin na tela /configuracoes/gate.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 056_dormancy_days.sql
-- ============================================================

ALTER TABLE lead_manager.tenant_lead_config
  ADD COLUMN IF NOT EXISTS dormancy_days int NOT NULL DEFAULT 7
    CHECK (dormancy_days BETWEEN 1 AND 365);

-- ROLLBACK:
--   ALTER TABLE lead_manager.tenant_lead_config DROP COLUMN IF EXISTS dormancy_days;
