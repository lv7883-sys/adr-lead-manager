-- ============================================================
-- E1-01 | Motor conversacional: funil de triagem (ADR-003).
-- Executar como superuser "postgres".
-- ============================================================

-- ---- Portão 0: contatos conhecidos (nunca tratados como lead) ----
CREATE TABLE IF NOT EXISTS lead_manager.known_contacts (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    phone      text NOT NULL,                              -- E.164
    type       text NOT NULL CHECK (type   IN ('STAFF', 'STUDENT', 'SUPPLIER', 'OTHER')),
    source     text NOT NULL CHECK (source IN ('MANUAL', 'EXTRANET_SYNC')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, phone)
);

ALTER TABLE lead_manager.known_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.known_contacts FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.known_contacts;
CREATE POLICY tenant_isolation ON lead_manager.known_contacts
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---- Portão 2: leads identificados por telefone ----
-- Reaproveita lead_manager.leads (migration 001). Padroniza status e permite
-- "identificar ou criar lead pelo número".
ALTER TABLE lead_manager.leads ALTER COLUMN status SET DEFAULT 'NEW';
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_tenant_phone
    ON lead_manager.leads (tenant_id, phone)
    WHERE phone IS NOT NULL;

-- ---- Mensagens: papel USER/ASSISTANT e raw opcional (resposta do bot não tem payload) ----
ALTER TABLE lead_manager.messages ADD COLUMN IF NOT EXISTS role text
    CHECK (role IN ('USER', 'ASSISTANT'));
ALTER TABLE lead_manager.messages ALTER COLUMN raw DROP NOT NULL;

-- ---- Modo observação: respostas sugeridas aguardando aprovação ----
CREATE TABLE IF NOT EXISTS lead_manager.pending_approvals (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    lead_id            uuid NOT NULL REFERENCES lead_manager.leads(id) ON DELETE CASCADE,
    conversation_id    uuid NOT NULL REFERENCES lead_manager.conversations(id) ON DELETE CASCADE,
    suggested_response text NOT NULL,
    status             text NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EDITED')),
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_tenant_status
    ON lead_manager.pending_approvals (tenant_id, status);

ALTER TABLE lead_manager.pending_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.pending_approvals FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.pending_approvals;
CREATE POLICY tenant_isolation ON lead_manager.pending_approvals
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---- Privilégios ----
GRANT SELECT, INSERT, UPDATE, DELETE
    ON lead_manager.known_contacts, lead_manager.pending_approvals
    TO lead_manager_user;
