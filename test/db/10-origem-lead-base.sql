-- 10-origem-lead-base.sql — roda no banco `lm_origem`.
--
-- O mínimo de produção que as migrações 170/171 precisam: schema, `tenants` e `leads`.
-- `leads` nasce com a MESMA RLS de produção (ENABLE + FORCE + policy por
-- app.current_tenant), senão o teste de vínculo do lead provaria menos do que parece.
--
-- Não recria `br_phone_key`: essa vem da migração 085 verbatim, aplicada pelo Makefile.

CREATE SCHEMA IF NOT EXISTS lead_manager;
GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;

CREATE TABLE IF NOT EXISTS lead_manager.tenants (
  id                  uuid PRIMARY KEY,
  name                text,
  lead_manager_active boolean NOT NULL DEFAULT true
);
GRANT SELECT ON lead_manager.tenants TO lead_manager_user;

INSERT INTO lead_manager.tenants (id, name) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Unidade A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Unidade B')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS lead_manager.leads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  phone      text,
  status     text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lead_manager.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.leads FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.leads;
CREATE POLICY tenant_isolation ON lead_manager.leads
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON lead_manager.leads TO lead_manager_user;
