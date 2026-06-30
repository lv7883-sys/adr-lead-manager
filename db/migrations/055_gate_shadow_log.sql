-- ============================================================
-- ADR-029 fatia 3 — log do MODO SOMBRA do Portão 0. ADITIVA. Append-only, tabela própria
-- (não toca a quente `messages`). Registra o que o gate FARIA sem agir + o desfecho do
-- crivo na MESMA linha, para dimensionar o trade-off ANTES de ligar o 'on':
--   presignal que ADICIONARIA ao Revisar  = would_action='presignal' AND crivo_outcome='not_lead'
--   hard que ENGOLIRIA um lead real        = would_action='hard'      AND crivo_outcome='lead'
-- not_lead_presignal/role_hard são RÓTULOS DE DECISÃO aqui — presignal NUNCA toca
-- messages.discard_reason. Truncável após o período de observação.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 055_gate_shadow_log.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.gate_shadow_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  phone               text,
  channel             text,
  would_action        text NOT NULL CHECK (would_action IN ('hard','presignal')),
  role_id             uuid REFERENCES lead_manager.contact_role(id) ON DELETE SET NULL,
  reason              text,                                            -- role.key | 'history_notlead_within_ttl'
  crivo_outcome       text CHECK (crivo_outcome IN ('lead','not_lead')),  -- preenchido pós-classify
  external_message_id text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lead_manager.gate_shadow_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.gate_shadow_log;
CREATE POLICY tenant_isolation ON lead_manager.gate_shadow_log
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON lead_manager.gate_shadow_log TO lead_manager_user;
CREATE INDEX IF NOT EXISTS idx_gate_shadow_log_tenant_created
  ON lead_manager.gate_shadow_log (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gate_shadow_log_tradeoff
  ON lead_manager.gate_shadow_log (tenant_id, would_action, crivo_outcome);

-- ROLLBACK:
--   DROP TABLE IF EXISTS lead_manager.gate_shadow_log;
