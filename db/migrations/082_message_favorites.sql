-- ============================================================
-- 082 — ADR-042: FAVORITAR mensagens da Caixa de Entrada (estrela, estilo WhatsApp).
-- A timeline une 3 fontes (lead=messages, recepcao=staff_outbound_samples, ia=pending_approvals);
-- o favorito referencia a BOLHA por (message_kind, message_id) — o id é o da linha da fonte.
-- Toggle: existe=desfavorita (DELETE), nao existe=favorita (INSERT). SELECT lista p/ marcar
-- a thread e preencher o painel de detalhes ("Mensagens favoritas").
-- ADITIVA. Executar como superuser "postgres".
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 082_message_favorites.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.message_favorites (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL,
    message_kind    text NOT NULL,   -- 'lead' | 'recepcao' | 'ia'
    message_id      uuid NOT NULL,   -- id da linha na fonte (messages/staff_outbound_samples/pending_approvals)
    favorited_by    text,
    favorited_at    timestamptz NOT NULL DEFAULT now()
);
-- Um favorito por bolha (message_id e globalmente unico entre as fontes, mas o tenant escopa).
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_fav_tenant_msg
    ON lead_manager.message_favorites (tenant_id, message_id);
CREATE INDEX IF NOT EXISTS idx_msg_fav_conv
    ON lead_manager.message_favorites (tenant_id, conversation_id);

ALTER TABLE lead_manager.message_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.message_favorites FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.message_favorites;
CREATE POLICY tenant_isolation ON lead_manager.message_favorites
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON lead_manager.message_favorites TO lead_manager_user;

-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS lead_manager.message_favorites;
