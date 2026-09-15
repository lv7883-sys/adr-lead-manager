-- ============================================================
-- 118 — PARIDADE COM O WHATSAPP: conversa ARQUIVADA, FIXADA e SILENCIADA.
--
-- A recepção pediu para arquivar conversas no Regente, e o que é feito no celular/WhatsApp Web (marcar como
-- não lida, arquivar, fixar, silenciar) passa a valer no Regente — a Evolution foi corrigida (15/09/2026) para
-- repassar o chats.update completo. Estado espelhado do WhatsApp:
--   arquivada_em   — quando foi arquivada (NULL = na lista principal). Fica arquivada até desarquivar, como o
--                    padrão atual do WhatsApp ("manter conversas arquivadas").
--   fixada_em      — quando foi fixada no topo (NULL = não fixada).
--   silenciada_ate — até quando está silenciada ('infinity' = sempre; NULL ou passado = não silenciada).
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 118_conversa_arquivada_fixada_silenciada.sql
-- ============================================================
BEGIN;

ALTER TABLE lead_manager.conversations
  ADD COLUMN IF NOT EXISTS arquivada_em   timestamptz,
  ADD COLUMN IF NOT EXISTS fixada_em      timestamptz,
  ADD COLUMN IF NOT EXISTS silenciada_ate timestamptz;

-- a lista (caminho rápido) corta por tenant + arquivada antes de ordenar pela atividade
CREATE INDEX IF NOT EXISTS idx_conversations_arquivada
  ON lead_manager.conversations (tenant_id, last_activity_at DESC)
  WHERE arquivada_em IS NOT NULL;

COMMIT;

-- ROLLBACK:
--   DROP INDEX IF EXISTS lead_manager.idx_conversations_arquivada;
--   ALTER TABLE lead_manager.conversations DROP COLUMN IF EXISTS arquivada_em, DROP COLUMN IF EXISTS fixada_em,
--     DROP COLUMN IF EXISTS silenciada_ate;
