-- ============================================================
-- 115 — PARIDADE COM O WHATSAPP (etapa 2): edições cifradas deixam de virar bolha.
--
-- O WhatsApp manda edição de mensagem cifrada (secretEncryptedMessage). O Regente gravava cada uma como
-- uma bolha nova "[mensagem de visualização única]" — 785 até 15/09/2026 — e a original seguia com o
-- texto velho. src/waEdicao.js decifra e aplica o texto novo na original; aqui ficam as duas tabelas
-- de apoio. As bolhas falsas saem das conversas pelo backfill (deploy/backfill-edicoes-cifradas.js),
-- que ARQUIVA cada linha removida em wa_linha_arquivada (nada se perde; dá para restaurar).
--
--   wa_lid              — mapa @lid <-> número. O WhatsApp passou a identificar contas por um @lid de
--                         privacidade; a chave da edição usa o @lid de quem editou. proprio = @lid da
--                         própria escola (necessário p/ as edições que ela faz).
--   wa_linha_arquivada  — cópia integral de linhas retiradas de messages/staff_outbound_samples por não
--                         serem mensagens (eventos sobre outras mensagens).
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 115_wa_lid_e_linhas_arquivadas.sql
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS lead_manager.wa_lid (
  tenant_id  uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  lid        text NOT NULL,
  pn         text,
  proprio    boolean NOT NULL DEFAULT false,
  visto_em   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, lid)
);
CREATE INDEX IF NOT EXISTS idx_wa_lid_pn ON lead_manager.wa_lid (tenant_id, pn);
ALTER TABLE lead_manager.wa_lid OWNER TO lead_manager_user;
ALTER TABLE lead_manager.wa_lid ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.wa_lid FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.wa_lid;
CREATE POLICY tenant_isolation ON lead_manager.wa_lid
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TABLE IF NOT EXISTS lead_manager.wa_linha_arquivada (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  tabela        text NOT NULL,
  linha_id      uuid NOT NULL,
  motivo        text NOT NULL,
  linha         jsonb NOT NULL,
  arquivado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_linha_arquivada ON lead_manager.wa_linha_arquivada (tenant_id, tabela, linha_id);
ALTER TABLE lead_manager.wa_linha_arquivada OWNER TO lead_manager_user;
ALTER TABLE lead_manager.wa_linha_arquivada ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.wa_linha_arquivada FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.wa_linha_arquivada;
CREATE POLICY tenant_isolation ON lead_manager.wa_linha_arquivada
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

COMMIT;

-- ROLLBACK (manual): restaurar linhas com
--   INSERT INTO lead_manager.<tabela> SELECT * FROM jsonb_populate_record(NULL::lead_manager.<tabela>, linha)
--     FROM lead_manager.wa_linha_arquivada WHERE tabela = '<tabela>';
--   DROP TABLE lead_manager.wa_linha_arquivada; DROP TABLE lead_manager.wa_lid;
