-- ============================================================================
-- 186_boas_vindas_inclusao_manual.sql
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 186_....sql
--
-- POR QUÊ
--   Pedido das recepcionistas (16/10/2026, via Leo): "a possibilidade de incluir um novo aluno
--   manualmente". A régua decide sozinha quem entra no plano de boas-vindas — e quando ela erra, ou
--   quando o caso é fora da curva, hoje não há porta: o aluno simplesmente não aparece na aba e
--   ninguém sabe por quê.
--
--   A régua vai continuar errando de vez em quando (ela depende do cadastro da Extranet, que atrasa e
--   tem contrato cancelado, contrato de teste, aluno com dois cadastros). O conserto não é adivinhar
--   melhor: é deixar quem atende decidir, vendo o motivo.
--
-- O QUE FAZ
--   Uma linha por contrato que a recepção mandou incluir. Guarda QUEM incluiu e qual era o motivo da
--   exclusão no momento (renovação, contato interno…), que é o que permite medir depois se a régua
--   está errando sempre no mesmo ponto.
--
--   Quem lê: o planejamento (src/boasVindas/planejar.js) trata o contrato incluído como elegível.
--   Não força nada além disso — as regras de prazo, teto e dados que faltam continuam valendo, e um
--   contrato sem titular segue de fora (não há para quem mandar).
--
-- ROLLBACK
--   DROP TABLE lead_manager.boas_vindas_inclusao;
--
-- Aditiva e idempotente. Sem ela, o sistema funciona exatamente como hoje.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS lead_manager.boas_vindas_inclusao (
  tenant_id       uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES lead_manager.service_account(id) ON DELETE CASCADE,
  motivo_original text,
  incluido_por    text NOT NULL,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id)
);

COMMENT ON TABLE lead_manager.boas_vindas_inclusao IS
  'Contratos que a recepção mandou incluir no plano de boas-vindas apesar da régua os ter deixado de fora (ADR-050 §21).';
COMMENT ON COLUMN lead_manager.boas_vindas_inclusao.motivo_original IS
  'Por que a régua tinha deixado de fora quando a pessoa incluiu (renovacao, contato_interno…). Serve para medir onde a régua erra.';

ALTER TABLE lead_manager.boas_vindas_inclusao ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.boas_vindas_inclusao FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON lead_manager.boas_vindas_inclusao;
CREATE POLICY tenant_isolation ON lead_manager.boas_vindas_inclusao
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON lead_manager.boas_vindas_inclusao TO lead_manager_user;

COMMIT;
