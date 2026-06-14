-- ============================================================
-- PARTE 3 — retomada de leads silenciosos. Registra cada tentativa de reabordagem
-- enviada pela recepção/gestão (texto + sugestão usada). `respondeu` fica null no
-- envio; a taxa de retomada é calculada na leitura (lead respondeu depois?).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 028_reabordagem.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.reabordagem_tentativas (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  lead_id             uuid NOT NULL,
  texto               text NOT NULL,
  enviado_em          timestamptz DEFAULT now(),
  respondeu           boolean,
  respondeu_em        timestamptz,
  sugestao_estrategia text,
  sugestao_rascunho   text
);
CREATE INDEX IF NOT EXISTS idx_reabordagem_tenant
  ON lead_manager.reabordagem_tentativas (tenant_id, enviado_em);
CREATE INDEX IF NOT EXISTS idx_reabordagem_lead
  ON lead_manager.reabordagem_tentativas (lead_id);

-- Tabela de log interno (sem RLS) — o app escreve como lead_manager_user.
GRANT SELECT, INSERT, UPDATE ON lead_manager.reabordagem_tentativas TO lead_manager_user;
