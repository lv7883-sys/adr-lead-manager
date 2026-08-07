-- ============================================================
-- 095 — RENOVAÇÃO "resolvida" pela recepção (RETIRA da aba). Quando a recepção marca renovou /
-- não-renovou (dashboard: desfecho-renovacao), grava aqui; o filtro view=renovacoes do inbox EXCLUI.
-- Reversível: "desfazer" apaga a linha e a conversa VOLTA pra aba.
--
-- CHAVE = br_phone_key do telefone. venc = vencimento NO MOMENTO (amarra ao ciclo): se o contrato
-- renovar, o novo fim_vigencia NÃO casa com este venc → a conversa reaparece sozinha no próximo ciclo.
-- venc NULL = resolvido sem contrato (entrou por contexto/toque). 1 linha por telefone (upsert).
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 095_renovacao_dismiss.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.renovacao_dismiss (
  tenant_id uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  br_key    text NOT NULL,
  venc      date,                 -- vencimento amarrado ao ciclo (NULL = sem contrato)
  situacao  text,                 -- 'renovou' | 'nao_renovou' (ou futuro 'retirado')
  por       text,
  em        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, br_key)
);
ALTER TABLE lead_manager.renovacao_dismiss OWNER TO lead_manager_user;
ALTER TABLE lead_manager.renovacao_dismiss ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.renovacao_dismiss FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.renovacao_dismiss;
CREATE POLICY tenant_isolation ON lead_manager.renovacao_dismiss
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS lead_manager.renovacao_dismiss;
