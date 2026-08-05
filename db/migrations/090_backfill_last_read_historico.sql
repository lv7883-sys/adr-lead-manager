-- ============================================================
-- ADR-042 (Central de Mensagens) — BACKFILL: desinflar "não-lidas" do histórico importado.
--
-- CONTEXTO: o importador de histórico (Fase B, commit ec1c5c5) insere mensagens antigas
-- como role='USER' mas NÃO setava conversations.last_read_at. Como NULL = "nunca lida"
-- (migr. 080), TODO o histórico importado passou a contar como não-lido — inflando o
-- badge por-conversa e o total de /inbox/nao-lidas (ex.: Valinhos ~806 em 05/ago/2026).
--
-- CORREÇÃO no código (importHistorico.js): a partir de agora o import já avança o cursor.
-- Esta migr. conserta o ACERVO já importado antes do fix.
--
-- CRITÉRIO (conservador — só histórico): avança last_read_at até a mensagem HISTÓRICA
-- mais nova de cada conversa (raw.source='historico'). MONOTÔNICO: só avança (nunca recua),
-- então NÃO esconde não-lidas legítimas — qualquer inbound recebido via webhook com
-- received_at > essa marca continua contando como não-lido.
--
-- IDEMPOTENTE (reexecutar não muda nada além do 1º run). Roda como postgres (bypass RLS →
-- pega todos os tenants). Migrations manuais, sem runner (NUNCA db push):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 090_backfill_last_read_historico.sql
-- ============================================================

UPDATE lead_manager.conversations c
   SET last_read_at = sub.max_hist
  FROM (
    SELECT conversation_id, max(received_at) AS max_hist
      FROM lead_manager.messages
     WHERE role = 'USER'
       AND raw->>'source' = 'historico'
     GROUP BY conversation_id
  ) sub
 WHERE c.id = sub.conversation_id
   AND (c.last_read_at IS NULL OR c.last_read_at < sub.max_hist);

-- Conferência (opcional, não altera nada):
--   SELECT count(*) FROM lead_manager.conversations WHERE last_read_at IS NULL;

-- ROLLBACK: não há rollback seguro/automático — o valor anterior (NULL) não é preservado.
-- Reverter significaria voltar a contar histórico como não-lido (o bug). Se necessário para
-- uma conversa específica: UPDATE lead_manager.conversations SET last_read_at = NULL WHERE id = '<uuid>';
