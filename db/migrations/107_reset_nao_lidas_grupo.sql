-- ============================================================================
-- 107_reset_nao_lidas_grupo.sql — zera o acúmulo de "não-lidas" fantasma dos GRUPOS.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 107_reset_nao_lidas_grupo.sql
--
-- POR QUÊ
--   O mecanismo "responder = ler" (staffSamples.captureOutbound) tinha um `!isGroup`: responder
--   num grupo NÃO avançava `conversations.last_read_at`. E o recibo de leitura do WhatsApp Web —
--   que deveria cobrir isso — é justamente o que não volta de forma confiável (é a razão de o
--   "responder = ler" existir). Com as duas portas fechadas, o cursor dos grupos só andava por
--   acaso, quando algum recibo chegava.
--
--   Medido em produção (2026-08-27): 13 grupos com não-lidas, ~128 mensagens no total. Não eram
--   conversas ignoradas — era LAG. Um grupo estava "lido até 24/ago" com mensagens até 27/ago,
--   acumulando 61. Isso ia inflar o badge da Caixa de Entrada de 25 para 150 assim que grupo
--   passasse a contar (decisão de paridade com o WhatsApp).
--
--   O código já foi corrigido (o `!isGroup` saiu). Esta migração limpa o passivo que se acumulou
--   enquanto o mecanismo estava quebrado — sem ela, as fantasmas continuam lá para sempre, porque
--   nada no passado vai gerar um recibo retroativo.
--
-- O QUE FAZ
--   Para cada conversa de GRUPO, avança last_read_at até a mensagem mais recente. Só avança
--   (GREATEST), nunca recua.
--
-- ⚠ ISTO MARCA COMO LIDO O QUE TALVEZ NÃO TENHA SIDO. É deliberado e é a única saída: o mecanismo
--   esteve quebrado, então não existe dado que distinga "lida" de "não lida" nesses grupos — o
--   cursor é ficção. Zerar dá um ponto de partida limpo e, daqui pra frente, o mecanismo novo
--   mantém em dia. Grupo não é fila de lead: o custo de marcar um a mais como lido é baixo, e o
--   custo de deixar 128 fantasmas é um badge inútil.
--
-- NÃO TOCA em conversa DIRETA: lá o mecanismo sempre funcionou e as não-lidas são reais.
--
-- Idempotente (re-rodar é no-op depois da 1ª vez). Só mexe em last_read_at de grupo.
-- ============================================================================

BEGIN;

-- Antes/depois na mesma transação, pra ficar no log do deploy.
\echo '-- não-lidas de GRUPO antes:'
SELECT count(*) AS nao_lidas_grupo
  FROM lead_manager.conversations cv
  JOIN lead_manager.messages m ON m.conversation_id = cv.id
 WHERE cv.conversation_kind = 'GROUP' AND m.role = 'USER'
   AND (cv.last_read_at IS NULL OR m.received_at > cv.last_read_at);

UPDATE lead_manager.conversations cv
   SET last_read_at = GREATEST(COALESCE(cv.last_read_at, 'epoch'::timestamptz), u.ultima)
  FROM (SELECT conversation_id, max(received_at) AS ultima
          FROM lead_manager.messages WHERE role = 'USER' GROUP BY 1) u
 WHERE u.conversation_id = cv.id
   AND cv.conversation_kind = 'GROUP'
   AND (cv.last_read_at IS NULL OR cv.last_read_at < u.ultima);

\echo '-- não-lidas de GRUPO depois (tem de ser 0):'
SELECT count(*) AS nao_lidas_grupo
  FROM lead_manager.conversations cv
  JOIN lead_manager.messages m ON m.conversation_id = cv.id
 WHERE cv.conversation_kind = 'GROUP' AND m.role = 'USER'
   AND (cv.last_read_at IS NULL OR m.received_at > cv.last_read_at);

COMMIT;

-- ---- VERIFICAÇÃO ------------------------------------------------------------------------------
-- O badge inteiro depois do reset (é o que a recepção vai ver quando o código novo subir):
--   SELECT count(*) AS badge
--     FROM lead_manager.conversations cv
--     JOIN lead_manager.messages m ON m.conversation_id = cv.id
--    WHERE m.role='USER' AND cv.renovacao_draft IS NOT TRUE
--      AND coalesce(m.body,'') NOT LIKE '[reação]%'
--      AND (cv.last_read_at IS NULL OR m.received_at > cv.last_read_at);
--
-- ---- ROLLBACK ---------------------------------------------------------------------------------
-- Não há: o cursor anterior dos grupos era ficção (o mecanismo que o alimentava estava quebrado),
-- então não existe estado "correto" para voltar. Reverter o CÓDIGO faz os grupos voltarem a
-- acumular lag — o que é o bug, não a correção.
