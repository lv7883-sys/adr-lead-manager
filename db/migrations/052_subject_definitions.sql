-- ============================================================
-- ADR-029 — Eixo de assunto (genérico por tenant). ADITIVA: só cria tabela nova.
-- A implementação só usa lead/not_lead agora, mas o schema nasce genérico (futuros
-- 'renovacao'/'reclamacao'…). O comportamento decorre da PROPRIEDADE `lead_bearing`,
-- não do `key`. O vocabulário vem do seed por tenant.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 052_subject_definitions.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.subject_definition (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  key          text NOT NULL,
  label        text NOT NULL,
  lead_bearing boolean NOT NULL DEFAULT false,
  sort_order   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
ALTER TABLE lead_manager.subject_definition ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.subject_definition;
CREATE POLICY tenant_isolation ON lead_manager.subject_definition
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.subject_definition TO lead_manager_user;

-- ROLLBACK:
--   DROP TABLE IF EXISTS lead_manager.subject_definition;
