-- ============================================================
-- E6-02 | Integração Z-API por tenant + persistência de mensagens.
-- Executar como superuser "postgres".
-- ============================================================

-- 1. Configuração da integração no próprio tenant.
ALTER TABLE lead_manager.tenants
    ADD COLUMN IF NOT EXISTS lead_manager_active boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS zapi_token          text;

COMMENT ON COLUMN lead_manager.tenants.lead_manager_active IS
    'Se false, o webhook ignora o tenant e responde 200 silencioso.';
COMMENT ON COLUMN lead_manager.tenants.zapi_token IS
    'Token esperado no header X-ZAPI-TOKEN para autenticar o webhook deste tenant.';

-- 2. Conversa = thread de um contato (telefone) dentro de um tenant/canal.
CREATE TABLE IF NOT EXISTS lead_manager.conversations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    channel     text NOT NULL DEFAULT 'whatsapp',
    external_id text NOT NULL,                       -- telefone / remoteJid
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, channel, external_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON lead_manager.conversations (tenant_id);

-- 3. Mensagem recebida/enviada dentro de uma conversa.
CREATE TABLE IF NOT EXISTS lead_manager.messages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    conversation_id     uuid NOT NULL REFERENCES lead_manager.conversations(id) ON DELETE CASCADE,
    direction           text NOT NULL DEFAULT 'inbound',
    external_message_id text,
    sender              text,
    body                text,
    raw                 jsonb NOT NULL,
    received_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON lead_manager.messages (conversation_id);
-- Idempotência: webhooks reentregues não duplicam a mensagem.
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_tenant_extid
    ON lead_manager.messages (tenant_id, external_message_id)
    WHERE external_message_id IS NOT NULL;

-- 4. RLS (ENABLE + FORCE) e política de isolamento por tenant.
ALTER TABLE lead_manager.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.conversations FORCE  ROW LEVEL SECURITY;
ALTER TABLE lead_manager.messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.messages      FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON lead_manager.conversations;
CREATE POLICY tenant_isolation ON lead_manager.conversations
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON lead_manager.messages;
CREATE POLICY tenant_isolation ON lead_manager.messages
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- 5. Privilégios para o usuário da aplicação.
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.conversations, lead_manager.messages TO lead_manager_user;
