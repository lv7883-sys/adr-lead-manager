-- ============================================================
-- ADR-020 (parcial) — detecção diária de leads silenciosos.
-- A reabordagem deixa de ser só "registro de envio": ganha um STATUS para
-- suportar sugestões geradas pelo job que AGUARDAM aprovação da recepção.
--   pendente : sugestão da IA na fila, ainda não enviada.
--   enviado  : reabordagem efetivamente enviada ao lead (default — compatível
--              com o fluxo manual de gestão, que já inseria como envio).
--   ignorado : a recepção descartou a sugestão.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 031_reabordagem_status.sql
-- ============================================================

ALTER TABLE lead_manager.reabordagem_tentativas
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'enviado'
    CHECK (status IN ('pendente','enviado','ignorado'));

CREATE INDEX IF NOT EXISTS idx_reabordagem_pendente
  ON lead_manager.reabordagem_tentativas (tenant_id, status)
  WHERE status = 'pendente';

-- Enumeração cross-tenant dos tenants com Lead Manager ativo, para o cron de
-- detecção (sem contexto RLS). Mesmo padrão SECURITY DEFINER de
-- tenants_for_retention() / tenant_by_meta_page().
CREATE OR REPLACE FUNCTION lead_manager.tenants_active()
RETURNS TABLE(tenant_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path = lead_manager AS $$
  SELECT id FROM lead_manager.tenants WHERE lead_manager_active;
$$;
GRANT EXECUTE ON FUNCTION lead_manager.tenants_active() TO lead_manager_user;
