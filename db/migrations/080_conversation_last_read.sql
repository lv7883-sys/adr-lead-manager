-- ============================================================
-- ADR-042 (Central de Mensagens / E12-08) — cursor de "lido" da recepção.
-- Não existia NENHUM rastreio de "lido pela recepção" (ack_status da migr. 062 é o
-- check de ENTREGA do NOSSO outbound, ✓/✓✓, não "a recepção leu o inbound"). O inbox
-- precisa de `nao_lidas` por conversa.
--
-- DECISÃO (Leo, 2026-07-28): "lido" é COMPARTILHADO POR TENANT (caixa compartilhada,
-- estilo número único) — NÃO por operador. Logo, 1 cursor por conversa, direto na linha
-- de `conversations`, sem tabela por-usuário.
--
--   nao_lidas(conversa) = count(messages role='USER' WHERE received_at > last_read_at)
--   marcar-lido        => UPDATE conversations SET last_read_at = now() (ou até um ts dado)
--
-- ADITIVA. RLS herdada de `conversations` (policy tenant_isolation já ENABLE+FORCE na
-- migr. 002). NULL = nunca lida (todas as mensagens contam como não-lidas).
--
-- Migrations manuais, sem runner (NUNCA db push):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 080_conversation_last_read.sql
-- ============================================================

ALTER TABLE lead_manager.conversations
  ADD COLUMN IF NOT EXISTS last_read_at timestamptz;

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.conversations DROP COLUMN IF EXISTS last_read_at;
