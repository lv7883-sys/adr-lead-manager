-- ============================================================
-- ADR-037 fatia 037.1 — CADASTRO-MESTRE de pessoas (multi-tenant). GREENFIELD, ADITIVA:
-- só cria tabelas novas + 1 ALTER aditivo em contact_role_member + seed de 2 papéis.
-- NADA de DROP, nada destrutivo. NÃO popula person/contact_point/service_account/etc.
--
-- Padrão de RLS confirmado no read-only (2026-07-07): policy
--   tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid  (cmd ALL).
-- Toda tabela NOVA: posse do lead_manager_user + ENABLE + FORCE ROW LEVEL SECURITY + policy
-- (FORCE porque o dono é a app; sem FORCE o próprio dono leria sem filtro — lição do audit_log).
--
-- Numeração: 059 já é periodos_ocupacao (ADR-032); esta virou 060.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 060_cadastro_mestre.sql
-- ============================================================

-- ---------------------------------------------------------------------------
-- 1) PESSOA — âncora. Dedup por telefone (matchKeys, tenant-scoped) via contact_point.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_manager.person (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lead_manager.person OWNER TO lead_manager_user;
ALTER TABLE lead_manager.person ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.person FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.person;
CREATE POLICY tenant_isolation ON lead_manager.person
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 2) CONTATO — telefone/email; alegado (Extranet) vs provado (WhatsApp), LINHAS SEPARADAS.
--    Guarda o valor CRU; o match é por matchKeys no lookup (não muta a base).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_manager.contact_point (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES lead_manager.person(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('phone','email')),
  value_raw   text NOT NULL,
  source      text NOT NULL CHECK (source IN ('extranet','api_extranet','whatsapp','native','conversa')),
  confidence  text NOT NULL CHECK (confidence IN ('alegado','provado')),
  proven_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lead_manager.contact_point OWNER TO lead_manager_user;
ALTER TABLE lead_manager.contact_point ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.contact_point FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.contact_point;
CREATE POLICY tenant_isolation ON lead_manager.contact_point
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
-- índice de match por dígitos (BR-aware acontece no lookup; aqui é o índice-base tenant-scoped)
CREATE INDEX IF NOT EXISTS idx_contact_point_phone
  ON lead_manager.contact_point (tenant_id, regexp_replace(value_raw, '[^0-9]', '', 'g'));

-- ---------------------------------------------------------------------------
-- 3) CONTA = CONTRATO (grão aluno×curso×período — confirmado no read-only do contrato 1096).
--    status/servico_label/plano_label/status_renovacao = ESPELHO (texto livre da fonte).
--    periodicidade = de-para controlado do adapter.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_manager.service_account (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  status           text,            -- ativo|inativo|cancelado (espelho)
  servico_label    text,            -- "Baixo","Bateria" (linha de serviço legível, espelho)
  plano_label      text,            -- "Mensal 1h/sem"... (espelho)
  periodicidade    text CHECK (periodicidade IS NULL OR periodicidade IN ('mensal','trimestral','semestral','anual','outro')),
  ini_vigencia     date,
  fim_vigencia     date,
  status_renovacao text,            -- âncora do módulo de renovação (Prometeu Renovar / Em Negociação / …)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lead_manager.service_account OWNER TO lead_manager_user;
ALTER TABLE lead_manager.service_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.service_account FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.service_account;
CREATE POLICY tenant_isolation ON lead_manager.service_account
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 4) ACCOUNT_MEMBER — pessoas ↔ conta com vínculo (beneficiário/pagador/professor).
--    "alunos do professor X" vira QUERY, sem coluna de Extranet no core.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_manager.account_member (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES lead_manager.service_account(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES lead_manager.person(id) ON DELETE CASCADE,
  bond        text NOT NULL CHECK (bond IN ('beneficiario','pagador','professor')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, account_id, person_id, bond)
);
ALTER TABLE lead_manager.account_member OWNER TO lead_manager_user;
ALTER TABLE lead_manager.account_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.account_member FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.account_member;
CREATE POLICY tenant_isolation ON lead_manager.account_member
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 5) EXTERNAL_REF — ids externos, GENÉRICO e tipado (anti-leakage). entity_id é polimórfico
--    (person|account) — sem FK possível de propósito. Significado de external_type vive no provedor.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_manager.external_ref (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  entity_kind   text NOT NULL CHECK (entity_kind IN ('person','account')),
  entity_id     uuid NOT NULL,
  source        text NOT NULL,
  external_type text NOT NULL,      -- 'contrato'|'aluno'|'professor'|'curso'|'turma' (extensível por fonte)
  external_id   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, external_type, external_id)
);
ALTER TABLE lead_manager.external_ref OWNER TO lead_manager_user;
ALTER TABLE lead_manager.external_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.external_ref FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.external_ref;
CREATE POLICY tenant_isolation ON lead_manager.external_ref
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_external_ref_entity
  ON lead_manager.external_ref (tenant_id, entity_kind, entity_id);

-- ---------------------------------------------------------------------------
-- 6) CONTACT_ROLE_MEMBER (já existe; o gate lê) — ADITIVO: liga o membro à Pessoa do cadastro.
--    RLS/posse dessa tabela NÃO mudam aqui (segue como no 051). Só adiciona a coluna.
-- ---------------------------------------------------------------------------
ALTER TABLE lead_manager.contact_role_member
  ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES lead_manager.person(id) ON DELETE SET NULL;

-- Papéis 'aluno' e 'responsavel' (eixo 'known') para Valinhos. suppression='hard' em modo de
-- OBSERVAÇÃO: NÃO liga supressão real — quem age é o MODO DO GATE (tenant-level: off/shadow/on),
-- e contact_role_member fica VAZIA (nada casa até a população 037.2). contact_role não tem coluna
-- de 'modo'; usa-se o mesmo default das linhas existentes (lead_weight=0). Popular NADA além disto.
INSERT INTO lead_manager.contact_role (tenant_id, key, label, axis, suppression, lead_weight) VALUES
  ('ed731a58-62e5-45ad-acba-a5502ff39e92','aluno',       'Aluno',       'known','hard', 0),
  ('ed731a58-62e5-45ad-acba-a5502ff39e92','responsavel', 'Responsável', 'known','hard', 0)
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.contact_role_member DROP COLUMN IF EXISTS person_id;
--   DELETE FROM lead_manager.contact_role WHERE key IN ('aluno','responsavel')
--     AND tenant_id='ed731a58-62e5-45ad-acba-a5502ff39e92';
--   DROP TABLE IF EXISTS lead_manager.external_ref;
--   DROP TABLE IF EXISTS lead_manager.account_member;
--   DROP TABLE IF EXISTS lead_manager.service_account;
--   DROP TABLE IF EXISTS lead_manager.contact_point;
--   DROP TABLE IF EXISTS lead_manager.person;
