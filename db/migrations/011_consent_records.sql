-- ============================================================
-- LGPD (item de segurança 2) — registro de consentimento.
-- Aplicável pelo lead_manager_user (tabela nova, sem ALTER em `leads`).
-- Sem FKs de propósito: o app não tem privilégio REFERENCES sobre tenants/leads
-- (são do postgres) e, para um LOG de consentimento, é desejável que o registro
-- PERSISTA mesmo após anonimização/remoção do lead (prova de consentimento).
-- O opt-out em si é o status 'OPTED_OUT' em leads (status é texto livre).
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.consent_records (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    lead_id      uuid NOT NULL,
    channel      text NOT NULL DEFAULT 'whatsapp',
    text_version text NOT NULL,                 -- versão do texto/rodapé apresentado
    created_at   timestamptz NOT NULL DEFAULT now()
    -- Consentimento IMPLÍCITO: o registro é criado no 1º contato (rodapé de
    -- opt-out apresentado). Não ter clicado no opt-out configura o consentimento.
);

CREATE INDEX IF NOT EXISTS idx_consent_records_lead
    ON lead_manager.consent_records (tenant_id, lead_id);

ALTER TABLE lead_manager.consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.consent_records FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.consent_records;
CREATE POLICY tenant_isolation ON lead_manager.consent_records
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON lead_manager.consent_records TO lead_manager_user;
