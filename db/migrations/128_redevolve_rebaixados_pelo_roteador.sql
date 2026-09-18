-- ============================================================================
-- 128_redevolve_rebaixados_pelo_roteador.sql
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 128_....sql
--
-- POR QUÊ
--   A migração 127 (2026-09-17) devolveu ao funil 36 pessoas que o filtro tinha descartado e que
--   a Extranet mostrava marcando aula, fazendo aula ou matriculando. Menos de 24h depois, 4 delas
--   estavam de volta a NOT_LEAD — cada uma no segundo exato em que mandou mensagem nova:
--
--     Ana Cristina     "Anual"                                      18/09 10:35:47
--     Wagner Mesquita  combinando horário da aula da filha           18/09 11:07:46
--     ~helo            "avisa o hícaro q eu vou chegar atrasada??"   17/09 19:00:23
--     Viviane          remarcando a aula do Gabriel                  18/09 (manhã)
--
--   Causa: engine.captureRoutedEstablished — o roteador de conversa estabelecida — só preservava
--   o status de quem tinha review_result ou desfecho. A 127 limpou review_result (a revisão
--   afirmava "não é lead", o que a Extranet desmentia) e com isso tirou a ÚNICA trava. O
--   classificador leu as mensagens como conversa de aluno — e estava certo sobre a conversa —,
--   mas NOT_LEAD quer dizer "nunca foi lead".
--
--   O mesmo commit corrige o roteador: fato da Extranet agora também protege. Esta migração só
--   desfaz o estrago nos 4.
--
-- ESCOPO: SÓ quem a 127 devolveu (tem evento autor='migracao-127') e voltou a NOT_LEAD/REVIEW_QUEUE.
--   ⚠ NÃO inclui os casos NOVOS do alerta (hoje: Taize e Camila Santana). Esses nunca passaram pela
--   127, e o de Camila foi confirmado como "não é lead" em 17/09 17:29 com review_by='SERVICE' — que
--   é a credencial do DASHBOARD, ou seja, pode ter sido alguém da recepção clicando. Sobrescrever
--   isso em silêncio não é correção de regressão; é decisão do Leo.
--
-- Idempotente.
-- ============================================================================

BEGIN;
\set tid 'ed731a58-62e5-45ad-acba-a5502ff39e92'

CREATE TEMP TABLE _re AS
SELECT l.id, left(l.name, 24) AS nome, l.status AS status_antes,
       EXISTS (SELECT 1 FROM lead_manager.extranet_lead e WHERE e.lead_id = l.id
                AND lower(e.situacao) IN ('ganhou','matricula','matriculado')) AS ganhou
  FROM lead_manager.leads l
 WHERE l.tenant_id = :'tid'
   AND l.status IN ('NOT_LEAD','REVIEW_QUEUE')
   AND l.desfecho IS NULL
   AND EXISTS (SELECT 1 FROM lead_manager.lead_eventos ev
                WHERE ev.lead_id = l.id AND ev.autor = 'migracao-127');

\echo '-- rebaixados de novo desde a 127:'
SELECT nome, status_antes FROM _re ORDER BY nome;

UPDATE lead_manager.leads l
   SET status = CASE WHEN r.ganhou THEN 'CONVERTED' ELSE 'EXPERIMENTAL_AGENDADA' END,
       review_queue = false, updated_at = now()
  FROM _re r WHERE l.id = r.id;

INSERT INTO lead_manager.lead_eventos (tenant_id, lead_id, tipo, autor, conteudo)
SELECT :'tid'::uuid, r.id, 'nota', 'migracao-128',
       'Devolvido ao funil de novo: uma mensagem de aluno fez o roteador marcar NÃO-LEAD por cima '
       || 'do fato da Extranet. O roteador foi corrigido para respeitar o fato.'
  FROM _re r;

\echo '-- depois:'
SELECT r.nome, l.status FROM _re r JOIN lead_manager.leads l ON l.id = r.id ORDER BY r.nome;

DROP TABLE _re;
COMMIT;

-- ROLLBACK: UPDATE lead_manager.leads SET status='NOT_LEAD' WHERE id IN
--   (SELECT lead_id FROM lead_manager.lead_eventos WHERE autor='migracao-128');
