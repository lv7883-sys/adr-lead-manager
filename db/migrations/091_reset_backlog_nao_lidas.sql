-- ============================================================
-- ADR-042 Fase 2 — RESET ÚNICO do backlog de "não-lidas" (declara lido o acervo).
--
-- CONTEXTO: até o commit 0341a81 o LM não sabia das leituras feitas no WhatsApp Web, então o
-- "não-lida" só crescia (causa ②; Valinhos ~954 em 05/ago/2026). O handler novo
-- (marcarLidoPorRecibo em src/routes/webhook.js) passou a avançar last_read_at a cada recibo de
-- leitura do inbound (messages.update status=READ, key.fromMe=false) — mas só DALI PRA FRENTE.
-- As mensagens já lidas ANTES do deploy não emitem recibo novo, então o acervo velho não se cura
-- sozinho.
--
-- Este reset marca cada conversa como lida até a mensagem INBOUND mais recente. DEFENSÁVEL: o
-- badge é "não-VISTO", e a recepção já viu tudo no WhatsApp Web. O handler mantém honesto daqui
-- pra frente (inbound novo conta como não-lido até ser lido em algum aparelho).
--
-- MONOTÔNICO (GREATEST — nunca recua) e IDEMPOTENTE (rerodar não muda nada). role='USER' = só
-- inbound. Roda como postgres (bypass RLS → todos os tenants). Migrations manuais, sem runner:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 091_reset_backlog_nao_lidas.sql
--
-- SEM rollback seguro: o last_read_at anterior (NULL / cursor velho) era o número inflado (ficção).
-- ============================================================

UPDATE lead_manager.conversations cv
   SET last_read_at = GREATEST(COALESCE(cv.last_read_at, 'epoch'::timestamptz), sub.max_at)
  FROM (
    SELECT conversation_id, max(received_at) AS max_at
      FROM lead_manager.messages
     WHERE role = 'USER'
     GROUP BY conversation_id
  ) sub
 WHERE cv.id = sub.conversation_id
   AND (cv.last_read_at IS NULL OR cv.last_read_at < sub.max_at);

-- Conferência (não altera nada) — o total deve cair pra ~0 + o que chegou depois deste run:
--   SELECT COALESCE(SUM(n),0)::int FROM (
--     SELECT (SELECT count(*) FROM lead_manager.messages m
--              WHERE m.conversation_id = cv.id AND m.role='USER'
--                AND (cv.last_read_at IS NULL OR m.received_at > cv.last_read_at)) AS n
--       FROM lead_manager.conversations cv
--      WHERE coalesce(cv.external_id,'') NOT LIKE '%@g.us') u;
