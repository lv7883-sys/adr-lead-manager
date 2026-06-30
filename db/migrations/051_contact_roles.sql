-- ============================================================
-- ADR-029 — Papéis de contato (genérico, multi-tenant). ADITIVA: só cria tabelas
-- novas; NÃO altera internal_contacts/leads/messages/known_contacts. O vocabulário
-- ("professor"…) NÃO entra aqui — vem do seed por tenant. O comportamento decorre das
-- PROPRIEDADES (axis / suppression / lead_weight), nunca do nome.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 051_contact_roles.sql
-- ============================================================

-- Definição de papel: propriedades genéricas. `key` = slug estável p/ referência
-- (não dispara comportamento); `label` = vocabulário do tenant (seed).
CREATE TABLE IF NOT EXISTS lead_manager.contact_role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  label       text NOT NULL,
  axis        text NOT NULL CHECK (axis IN ('internal','known','unknown')),
  suppression text NOT NULL CHECK (suppression IN ('hard','presignal','none')),
  lead_weight numeric(4,3) NOT NULL DEFAULT 0 CHECK (lead_weight >= 0 AND lead_weight <= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
ALTER TABLE lead_manager.contact_role ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.contact_role;
CREATE POLICY tenant_isolation ON lead_manager.contact_role
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.contact_role TO lead_manager_user;

-- Associação contato (telefone) -> papel. Estrutura NOVA, independente de
-- internal_contacts (que segue intocada e plugada no Portão 0). 1 papel por telefone
-- por ora (multi-papel = futuro). Backfill/aposentadoria de internal_contacts = fora deste escopo.
CREATE TABLE IF NOT EXISTS lead_manager.contact_role_member (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  phone      text NOT NULL,
  role_id    uuid NOT NULL REFERENCES lead_manager.contact_role(id) ON DELETE RESTRICT,
  source     text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','extranet_sync','system')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);
ALTER TABLE lead_manager.contact_role_member ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.contact_role_member;
CREATE POLICY tenant_isolation ON lead_manager.contact_role_member
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.contact_role_member TO lead_manager_user;
CREATE INDEX IF NOT EXISTS idx_contact_role_member_phone
  ON lead_manager.contact_role_member (tenant_id, regexp_replace(phone, '[^0-9]', '', 'g'));

-- ROLLBACK:
--   DROP TABLE IF EXISTS lead_manager.contact_role_member;
--   DROP TABLE IF EXISTS lead_manager.contact_role;
