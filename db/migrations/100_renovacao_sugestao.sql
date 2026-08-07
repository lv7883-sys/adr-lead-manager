-- ============================================================
-- 100 — RENOVAÇÃO Fase D2: SUGESTÃO da IA para a situação do contrato (renovou / não vai renovar).
-- Um passe diário (renovacao-sweep) lê a conversa dos contratos vencidos/vencendo e grava aqui o que
-- a IA ACHA que aconteceu. É só SUGESTÃO — NÃO mexe nas estatísticas (isso é a renovacao_dismiss, que
-- só a recepção confirma). A tela do gráfico mostra a sugestão ("💡 IA: parece que renovou") com um
-- botão de aceitar. 1 linha por CONTRATO (tenant, br_key, venc) — igual à dismiss (migr. 099).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 100_renovacao_sugestao.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.renovacao_sugestao (
  tenant_id uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  br_key    text NOT NULL,
  venc      date,
  situacao  text,                     -- 'renovou' | 'nao_renovou' | 'indefinido'
  motivo    text,                     -- trecho curto que embasa a leitura
  em        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS renovacao_sugestao_ciclo_uk
  ON lead_manager.renovacao_sugestao (tenant_id, br_key, COALESCE(venc, '1900-01-01'::date));

ALTER TABLE lead_manager.renovacao_sugestao ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.renovacao_sugestao FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.renovacao_sugestao;
CREATE POLICY tenant_isolation ON lead_manager.renovacao_sugestao
  USING (tenant_id = (NULLIF(current_setting('app.current_tenant', true), ''))::uuid)
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.current_tenant', true), ''))::uuid);

-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS lead_manager.renovacao_sugestao;
