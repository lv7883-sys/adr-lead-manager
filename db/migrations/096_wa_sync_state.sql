-- ============================================================
-- 096 — RECONEXÃO: estado de conexão + cursor de backfill do WhatsApp por tenant.
--
-- PROBLEMA. O Regente é receptor PASSIVO do webhook da Evolution. Quando a instância cai (queda
-- de rede, sessão expirada) e a recepção continua a conversa em OUTRA plataforma (WhatsApp Web /
-- celular), as respostas dela (fromMe=true) chegam ao Baileys por history-sync na reconexão — que
-- a Evolution NÃO reencaminha como messages.upsert. Resultado: a conversa fica TRUNCADA no Regente.
--
-- SOLUÇÃO. Detectar a volta pra 'open' e PUXAR o histórico do store da Evolution (findMessages),
-- mesclando idempotentemente (importHistorico.importarConversa, dedup por external_message_id).
-- Esta tabela guarda, por tenant: o último estado visto (p/ detectar a transição → 'open'), quando
-- foi a última reconexão e quando rodou o último backfill (p/ o safety-net periódico).
--
-- 1 linha por tenant. Escrita/leitura pelo job de reconexão (waSync) via withTenant (RLS).
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 096_wa_sync_state.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.wa_sync_state (
  tenant_id         uuid PRIMARY KEY REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  last_state        text,                 -- último connectionState visto ('open'|'connecting'|'close'|…)
  last_state_at     timestamptz,          -- quando esse estado foi observado
  last_reconnect_at timestamptz,          -- última transição p/ 'open' (disparou backfill profundo)
  last_sync_at      timestamptz,          -- fim do último backfill bem-sucedido (âncora do safety-net)
  last_error        text,                 -- último erro de sync (diagnóstico), NULL quando ok
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lead_manager.wa_sync_state OWNER TO lead_manager_user;
ALTER TABLE lead_manager.wa_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.wa_sync_state FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.wa_sync_state;
CREATE POLICY tenant_isolation ON lead_manager.wa_sync_state
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS lead_manager.wa_sync_state;
