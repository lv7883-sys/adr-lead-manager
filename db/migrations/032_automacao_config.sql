-- ============================================================
-- ADR-006 — configuração de automação de atendimento por tenant.
-- Define o quanto a IA pode agir sozinha (manual / semi / auto) por período
-- (comercial, fora do horário, fim de semana) e por tipo de ação. Toda mudança
-- é auditada em automacao_log. Tabelas novas (sem ALTER em tabelas do postgres),
-- aplicáveis pelo lead_manager_user. Mesmo padrão RLS de consent_records.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 032_automacao_config.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.automacao_config (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE,
  modo_comercial text DEFAULT 'manual'
    CHECK (modo_comercial IN ('manual','semi','auto')),
  modo_fora_horario text DEFAULT 'semi'
    CHECK (modo_fora_horario IN ('manual','semi','auto')),
  modo_fds text DEFAULT 'semi'
    CHECK (modo_fds IN ('manual','semi','auto')),
  primeira_resposta_auto boolean DEFAULT true,
  qualificacao_auto boolean DEFAULT true,
  proposta_sempre_manual boolean DEFAULT true,
  agendamento_sempre_manual boolean DEFAULT true,
  updated_at timestamptz DEFAULT now(),
  updated_by text
);

CREATE TABLE IF NOT EXISTS lead_manager.automacao_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid NOT NULL,
  usuario text NOT NULL,
  modo_anterior jsonb,
  modo_novo jsonb,
  motivo text,
  criado_em timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automacao_log_tenant
  ON lead_manager.automacao_log (tenant_id, criado_em DESC);

-- RLS: isolamento por tenant via app.current_tenant (igual consent_records).
ALTER TABLE lead_manager.automacao_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.automacao_config FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.automacao_config;
CREATE POLICY tenant_isolation ON lead_manager.automacao_config
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE lead_manager.automacao_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.automacao_log FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.automacao_log;
CREATE POLICY tenant_isolation ON lead_manager.automacao_log
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON lead_manager.automacao_config TO lead_manager_user;
GRANT SELECT, INSERT         ON lead_manager.automacao_log    TO lead_manager_user;

-- Popula Valinhos com os defaults pedidos (manual no comercial, semi fora/fds).
INSERT INTO lead_manager.automacao_config (tenant_id, modo_comercial, modo_fora_horario, modo_fds)
VALUES ('ed731a58-62e5-45ad-acba-a5502ff39e92', 'manual', 'semi', 'semi')
ON CONFLICT (tenant_id) DO NOTHING;
