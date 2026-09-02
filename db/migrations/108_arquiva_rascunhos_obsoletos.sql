-- ============================================================================
-- 108_arquiva_rascunhos_obsoletos.sql — arquiva o rascunho que a recepção já ultrapassou.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 108_arquiva_rascunhos_obsoletos.sql
--
-- POR QUÊ
--   O Leo olhou a tela de Leads e disse "256 leads é muito, isso está errado". Está mesmo, e a
--   causa é esta.
--
--   `classificarLead` marca como ATIVO todo lead com rascunho pendente, e essa checagem vem ANTES
--   da dormência. Então um lead parado há 90 dias, com um rascunho da IA que ninguém aprovou,
--   continua "ativo" para sempre. Medido em produção (2026-09-02): dos 274 leads ativos, 104 estão
--   parados há mais de 30 dias — e 88 deles seguem ativos SÓ por causa de rascunho.
--
--   E a maioria desses rascunhos não vale mais nada:
--     238 rascunhos PENDING no total
--     217 (91%) — a recepção JÁ RESPONDEU ao lead DEPOIS de o rascunho nascer
--      94       — o lead falou de novo depois (o rascunho responde uma mensagem velha)
--      95       — criados há mais de 30 dias
--
--   Em 2026-08-27 o gatilho certo foi ligado (staffSamples: resposta humana arquiva o rascunho
--   daquela conversa no ato). Mas ele só vale para respostas NOVAS — nada arquiva o passivo que se
--   acumulou enquanto o único mecanismo era uma varredura periódica que nunca foi ligada no cron.
--   Esta migração é esse acerto de contas, o mesmo papel da 107 para as não-lidas de grupo.
--
-- O QUE FAZ
--   Arquiva o rascunho PENDING quando houve saída NOSSA depois de ele ser criado — a prova de que
--   a recepção já cuidou da conversa com o texto dela.
--
-- ⚠ NÃO arquiva por IDADE. Um rascunho de 40 dias sobre uma conversa em que ninguém respondeu ainda
--   é trabalho pendente legítimo, e apagá-lo esconderia um lead esquecido — o oposto do que se quer.
--   O critério é "alguém já respondeu", não "está velho".
--
-- Reversível: só muda `status` PENDING→ARCHIVED. O texto do rascunho continua na linha.
-- Idempotente (re-rodar é no-op).
-- ============================================================================

BEGIN;

\echo '-- rascunhos PENDING antes:'
SELECT count(*) AS pendentes FROM lead_manager.pending_approvals WHERE status = 'PENDING';

WITH saida AS (
  SELECT regexp_replace(s.external_id, '[^0-9]', '', 'g') AS ident, max(s.received_at) AS last_out
    FROM lead_manager.staff_outbound_samples s
   -- Só saída HUMANA de device: 'api' é o próprio Regente enviando (aprovação/campanha) e
   -- 'historico' é importação — nenhum dos dois prova que a recepção cuidou da conversa AGORA.
   WHERE s.source IN ('web', 'android', 'ios', 'desktop')
   GROUP BY 1
)
UPDATE lead_manager.pending_approvals pa
   SET status = 'ARCHIVED'
  FROM lead_manager.leads l
  JOIN saida sa ON sa.ident = regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g')
 WHERE pa.lead_id = l.id
   AND pa.tenant_id = l.tenant_id
   AND pa.status = 'PENDING'
   AND sa.last_out > pa.created_at;

\echo '-- rascunhos PENDING depois:'
SELECT count(*) AS pendentes FROM lead_manager.pending_approvals WHERE status = 'PENDING';

\echo '-- e a idade dos que sobraram (estes SÃO trabalho pendente de verdade):'
SELECT CASE WHEN created_at > now() - interval '7 days'  THEN 'ate 7 dias'
            WHEN created_at > now() - interval '30 days' THEN '8 a 30 dias'
            ELSE 'mais de 30 dias' END AS idade, count(*) AS n
  FROM lead_manager.pending_approvals WHERE status = 'PENDING'
 GROUP BY 1 ORDER BY 2 DESC;

COMMIT;

-- ---- VERIFICAÇÃO ------------------------------------------------------------------------------
-- O efeito esperado na tela de Leads: "LEADS ATIVOS" cai (o lead parado deixa de ser mantido vivo
-- por rascunho velho) e "N dos ativos já têm resposta pronta" passa a refletir trabalho real.
--
-- Nenhum rascunho é perdido: o texto continua na linha, só o status muda.
--   SELECT count(*) FROM lead_manager.pending_approvals WHERE status='ARCHIVED';
--
-- ---- ROLLBACK ---------------------------------------------------------------------------------
-- ⚠ NÃO HÁ ROLLBACK PRECISO, e é melhor saber disso antes: a tabela não tem `updated_at`, e tanto
-- esta migração quanto o gatilho de 2026-08-27 gravam o mesmo ARCHIVED. Depois do COMMIT não dá
-- para distinguir o que foi arquivado aqui do que o dia a dia arquivou.
--
-- O que dá para reverter é TUDO que está arquivado sem decisão humana — o que devolveria também os
-- arquivados legitimamente pelo gatilho:
--   UPDATE lead_manager.pending_approvals SET status='PENDING'
--    WHERE status='ARCHIVED' AND decided_at IS NULL;
--
-- Antes de aceitar isso, note que o custo de errar aqui é baixo nos dois sentidos: o rascunho é uma
-- SUGESTÃO da IA, o texto continua na linha, e um rascunho a mais ou a menos não muda nenhum dado
-- do lead. O que muda é a contagem de "leads ativos" — que é justamente o que se veio corrigir.
