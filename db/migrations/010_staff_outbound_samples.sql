-- ============================================================
-- Captura de amostras de OUTBOUND da recepção (aprendizado de estilo).
-- As mensagens fromMe da instância (Késsia/recepção) já chegam pelo webhook;
-- em vez de só descartar, guardamos o texto para refinar o system_prompt.
-- Executar como superuser "postgres".
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.staff_outbound_samples (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    channel             text NOT NULL DEFAULT 'whatsapp',
    external_id         text,    -- contato/cliente (thread)
    external_message_id text,
    source              text,    -- device da Evolution: android|ios|web|desktop|unknown (api = automático)
    sender              text,    -- pushName, se houver
    body                text NOT NULL,
    raw                 jsonb,
    received_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_samples_tenant ON lead_manager.staff_outbound_samples (tenant_id, received_at);
-- Idempotência: webhooks reentregues não duplicam a amostra.
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_samples_tenant_extid
    ON lead_manager.staff_outbound_samples (tenant_id, external_message_id)
    WHERE external_message_id IS NOT NULL;

ALTER TABLE lead_manager.staff_outbound_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.staff_outbound_samples FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.staff_outbound_samples;
CREATE POLICY tenant_isolation ON lead_manager.staff_outbound_samples
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON lead_manager.staff_outbound_samples TO lead_manager_user;
