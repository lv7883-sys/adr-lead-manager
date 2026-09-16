-- ============================================================
-- 126 — BOAS-VINDAS (ADR-050, E17-05): alerta de cliente que não começou + momento da ativação.
--
-- boas_vindas_alerta: um aviso por contrato para a recepção quando o 1º atendimento não acontece em N
-- dias (automacao_config.boas_vindas_alerta_dias). A rotina abre, atualiza e fecha sozinha quando o
-- cliente começa; a recepção pode dispensar com uma observação ("viajou, começa dia 10"). Dispensado
-- não reabre. Só existe para unidades com agenda/presença integrada.
--
-- automacao_config.boas_vindas_ativado_em: quando a unidade saiu de 'desligado'. O que já estava
-- devido antes desse instante vira fora_da_janela (anterior_a_ativacao) — a família nunca recebe de
-- uma vez o atraso acumulado, mesmo que a gestão ligue pela tela sem rodar o --ativar (R6). Voltar a
-- desligar e ligar de novo marca um instante novo.
--
-- Aditiva: não altera nenhuma coluna existente; nenhum outro módulo lê estas tabelas.
-- Numeração: 120–126 pertencem ao ADR-050; o ADR-051 reserva 127–139.
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 126_boas_vindas_alerta_e_ativacao.sql
-- ROLLBACK:
--   DROP TABLE IF EXISTS lead_manager.boas_vindas_alerta;
--   ALTER TABLE lead_manager.automacao_config DROP COLUMN IF EXISTS boas_vindas_ativado_em;
-- ============================================================
BEGIN;

ALTER TABLE lead_manager.automacao_config
  ADD COLUMN IF NOT EXISTS boas_vindas_ativado_em timestamptz;

CREATE TABLE IF NOT EXISTS lead_manager.boas_vindas_alerta (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid     NOT NULL REFERENCES lead_manager.tenants (id) ON DELETE CASCADE,
  account_id           uuid     NOT NULL REFERENCES lead_manager.service_account (id) ON DELETE CASCADE,
  tipo                 text     NOT NULL DEFAULT 'sem_primeiro_atendimento'
                         CHECK (tipo IN ('sem_primeiro_atendimento')),
  status               text     NOT NULL DEFAULT 'aberto'
                         CHECK (status IN ('aberto', 'resolvido', 'dispensado')),
  ini_vigencia         date     NOT NULL,
  dias                 smallint NOT NULL CHECK (dias >= 0),   -- dias desde o início do contrato na última rodada
  phone                text,
  destinatario_nome    text,
  cliente_nome         text,
  proximo_atendimento  timestamptz,                           -- próximo agendado conhecido (informativo)
  criado_em            timestamptz NOT NULL DEFAULT now(),
  atualizado_em        timestamptz NOT NULL DEFAULT now(),
  resolvido_em         timestamptz,
  resolvido_por        text,                                  -- 'sistema' ou quem dispensou
  observacao           text,
  CONSTRAINT boas_vindas_alerta_uq UNIQUE (tenant_id, account_id, tipo),
  CONSTRAINT bv_alerta_fechado_chk CHECK ((status = 'aberto') = (resolvido_em IS NULL))
);
ALTER TABLE lead_manager.boas_vindas_alerta OWNER TO lead_manager_user;
ALTER TABLE lead_manager.boas_vindas_alerta ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.boas_vindas_alerta FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.boas_vindas_alerta;
CREATE POLICY tenant_isolation ON lead_manager.boas_vindas_alerta
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE INDEX IF NOT EXISTS idx_boas_vindas_alerta_abertos
  ON lead_manager.boas_vindas_alerta (tenant_id, criado_em) WHERE status = 'aberto';

COMMIT;
