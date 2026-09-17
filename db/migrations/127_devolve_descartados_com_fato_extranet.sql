-- ============================================================================
-- 127_devolve_descartados_com_fato_extranet.sql
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 127_....sql
--
-- POR QUÊ
--   O card Plantão › Filtro avisava: "40 descartado(s) marcaram aula ou matricularam na Extranet".
--   São pessoas que o gate classificou como NÃO-LEAD e que depois apareceram na Extranet marcando
--   aula, fazendo a aula ou com situação 'Ganhou'. O gate errou, e isso é FATO, não opinião.
--
--   O dano é concreto: quem está NOT_LEAD não aparece em Leads, Kanban nem Reativação. A recepção
--   não vê essas pessoas. O BI de Leads já as contava (a régua de lá faz o fato vencer a
--   classificação desde 2026-08-28), mas as telas de TRABALHO não — então ninguém fala com elas.
--
--   Medido em 2026-09-17, tenant Valinhos: 40 casos, chegados em jun (23), jul (8) e ago (9) —
--   nenhum de setembro. Em 29 deles uma revisão automática (review_by='SERVICE') confirmou o
--   descarte: o erro passou por duas etapas.
--
-- NEM TODO CASO É ERRO DO FILTRO — e foi o Leo quem mostrou isso, lendo a lista em 2026-09-17:
--     • Leo Vecchi       — o dono; fez uma aula experimental de canto sem nunca trocar mensagem.
--     • Allan Azevedo    — professor da casa; avaliou aula para o filho.
--     • Guilherme Datovo — já é aluno (renovou projeto de banda em ago/2026).
--   Nesses o filtro ACERTOU; errado estava o alerta, que não sabia distinguir.
--
-- ⚠ POR ISSO A REGRA AQUI É POR PROPRIEDADE, NÃO POR NOME. A primeira versão desta migração
--   excluía três telefones escritos à mão. Ao conferir a base, dois fatos derrubaram isso:
--     1. Leo Vecchi JÁ ESTAVA em internal_contacts (como '554199511313', sem o '+'), e o meu
--        NOT EXISTS comparava o texto exato — teria criado uma segunda linha para a mesma pessoa.
--     2. DANIELE também é contato interno e estava entre os 40. Uma lista de nomes a devolveria
--        ao funil por engano. Regra por nome erra silenciosamente em quem ninguém olhou.
--   Agora: contato interno é quem casa por DÍGITOS com internal_contacts, seja quem for.
--
-- O QUE FAZ
--   • Registra Allan Azevedo como contato interno (Leo já estava; Daniele já estava).
--   • Marca Guilherme Datovo com desfecho='cliente' — o terminal do pagante PRÉ-EXISTENTE
--     (stages.js CLIENTE_DESFECHO): fora da fila E fora da taxa, sem ser contado como perda.
--   • Devolve os demais ao funil, no estágio que o fato prova.
--
--   ⚠ NÃO ESCREVE `desfecho` NOS DEVOLVIDOS. A tentação era carimbar 'matriculado' em quem tem
--   'Ganhou'. Não faço: contractConvert.js decide entre 'matriculado' (conversão) e 'cliente'
--   (pagante pré-existente) pela data do contrato, e o próprio arquivo diz que
--   "desfecho='matriculado' posto por humano NUNCA vira 'cliente'". Carimbar aqui BLOQUEARIA essa
--   correção e poderia inflar a conversão com gente que já era aluna. Status CONVERTED com desfecho
--   nulo basta: o funil conta a matrícula pelo FATO da Extranet, e o contractConvert segue livre.
--
-- Idempotente: só toca lead ainda NOT_LEAD/REVIEW_QUEUE com fato; re-rodar é no-op.
-- ============================================================================

BEGIN;

\set tid 'ed731a58-62e5-45ad-acba-a5502ff39e92'

-- Allan Azevedo — professor. (type tem CHECK: gestor|recepcionista|professor|funcionario|parceiro|outro.)
-- Casa por DÍGITOS para não duplicar quem já está lá com outro formato de telefone.
INSERT INTO lead_manager.internal_contacts (tenant_id, phone, name, type)
SELECT :'tid'::uuid, '+5519997615601', 'Allan Azevedo', 'professor'
 WHERE NOT EXISTS (
   SELECT 1 FROM lead_manager.internal_contacts ic
    WHERE ic.tenant_id = :'tid'::uuid
      AND regexp_replace(ic.phone, '\D', '', 'g') = '5519997615601');

\echo '-- contatos internos do tenant:'
SELECT name, phone, type FROM lead_manager.internal_contacts WHERE tenant_id = :'tid'::uuid ORDER BY name;

-- Guilherme Datovo — aluno pré-existente.
UPDATE lead_manager.leads
   SET desfecho = 'cliente', desfecho_em = COALESCE(desfecho_em, now()), updated_at = now()
 WHERE tenant_id = :'tid' AND desfecho IS NULL
   AND regexp_replace(COALESCE(phone,''), '\D', '', 'g') = '5511976010231';

-- Universo a DEVOLVER: descartado com fato, que NÃO é interno e NÃO é cliente pré-existente.
CREATE TEMP TABLE _dev AS
SELECT l.id,
       EXISTS (SELECT 1 FROM lead_manager.extranet_lead e WHERE e.lead_id = l.id
                AND lower(e.situacao) IN ('ganhou','matricula','matriculado')) AS ganhou,
       EXISTS (SELECT 1 FROM lead_manager.extranet_lead e WHERE e.lead_id = l.id
                AND e.exp_realizada_em IS NOT NULL) AS fez_aula
  FROM lead_manager.leads l
 WHERE l.tenant_id = :'tid'
   AND l.status IN ('NOT_LEAD','REVIEW_QUEUE')
   AND COALESCE(l.desfecho, '') <> 'cliente'
   AND NOT EXISTS (SELECT 1 FROM lead_manager.internal_contacts ic
                    WHERE ic.tenant_id = l.tenant_id
                      AND regexp_replace(ic.phone, '\D', '', 'g')
                        = regexp_replace(COALESCE(l.phone, ''), '\D', '', 'g'))
   AND EXISTS (SELECT 1 FROM lead_manager.extranet_lead e WHERE e.lead_id = l.id
                AND (e.exp_agendada_em IS NOT NULL OR e.exp_realizada_em IS NOT NULL
                     OR lower(e.situacao) IN ('ganhou','matricula','matriculado')));

\echo '-- quantos serao devolvidos, e por qual prova:'
SELECT CASE WHEN ganhou THEN '1) matriculou (Ganhou)'
            WHEN fez_aula THEN '2) fez a aula'
            ELSE '3) marcou aula' END AS prova, count(*) AS leads
  FROM _dev GROUP BY 1 ORDER BY 1;

-- Devolve. `review_*` é limpo porque a revisão concluiu o CONTRÁRIO do que a Extranet mostra —
-- manter 'confirmed_not_lead' deixaria o registro afirmando algo que sabemos ser falso.
UPDATE lead_manager.leads l
   SET status = CASE WHEN d.ganhou THEN 'CONVERTED' ELSE 'EXPERIMENTAL_AGENDADA' END,
       review_result = NULL, review_em = NULL, review_by = NULL, review_queue = false,
       updated_at = now()
  FROM _dev d
 WHERE l.id = d.id;

-- AUDITORIA: cada devolução vira evento na linha do tempo do lead.
INSERT INTO lead_manager.lead_eventos (tenant_id, lead_id, tipo, autor, conteudo)
SELECT :'tid'::uuid, d.id, 'nota', 'migracao-127',
       'Devolvido ao funil: o filtro havia marcado como NÃO-LEAD, mas a Extranet registra '
       || CASE WHEN d.ganhou THEN 'MATRÍCULA (Ganhou)'
               WHEN d.fez_aula THEN 'aula experimental REALIZADA'
               ELSE 'aula experimental AGENDADA' END
       || '. Fato vence classificação.'
  FROM _dev d;

\echo '-- o alerta do Plantao, pela regra NOVA (deve zerar):'
SELECT count(*) AS ainda_no_alerta
  FROM lead_manager.leads l
 WHERE l.tenant_id = :'tid'
   AND l.status IN ('NOT_LEAD','REVIEW_QUEUE')
   AND COALESCE(l.desfecho, '') <> 'cliente'
   AND NOT EXISTS (SELECT 1 FROM lead_manager.internal_contacts ic
                    WHERE ic.tenant_id = l.tenant_id
                      AND regexp_replace(ic.phone, '\D', '', 'g')
                        = regexp_replace(COALESCE(l.phone, ''), '\D', '', 'g'))
   AND EXISTS (SELECT 1 FROM lead_manager.extranet_lead e WHERE e.lead_id = l.id
                AND (e.exp_agendada_em IS NOT NULL OR e.exp_realizada_em IS NOT NULL
                     OR lower(e.situacao) IN ('ganhou','matricula','matriculado')));

DROP TABLE _dev;
COMMIT;

-- ---- VERIFICAÇÃO -----------------------------------------------------------------------------
-- MUDA: as pessoas devolvidas voltam a existir para a recepção (Leads/Kanban/Reativação); as com
-- matrícula saem do funil como convertidas.
-- NÃO MUDA: faturamento. Nada aqui toca bi_raw/contratos.
--
-- ⚠ EU ESCREVI AQUI "as barras de jun/jul/ago NÃO devem se mexer". ERRADO — elas se mexem, e por
-- dois motivos legítimos que só apareci ao medir depois de aplicar:
--
--   1. Guilherme Datovo sai do funil (desfecho='cliente'): −1 lead e −1 agendada em jun/2026.
--      Correto: aluno pré-existente não é captação.
--   2. Os três contatos internos (Leo, Daniele, Allan) saem, por causa da mudança irmã em
--      metrics.js (mesmo commit): −3 leads, −3 agendadas e −1 realizada em jun/2026.
--      Junho: 74 → 71 leads, 27 → 24 agendadas, 9 → 8 realizadas. Jul/ago inalterados.
--
-- Os DEVOLVIDOS, esses sim, não mexem o funil: a régua do BI já os contava pelo fato da Extranet.
--
-- O erro na minha verificação: escrevi uma consulta de comparação que checava só os carimbos de
-- aula (exp_agendada_em/exp_realizada_em) e esquecia a situação 'Ganhou', que temFatoExtranetSql
-- inclui. Comparar com uma régua PARECIDA em vez da régua REAL produz uma diferença que não existe
-- e esconde as que existem.
--
-- ---- ROLLBACK --------------------------------------------------------------------------------
-- Não há rollback preciso do `review_*` (era 'confirmed_not_lead'/'SERVICE' em 29 casos e nulo nos
-- demais; a distinção se perde). O que dá para desfazer:
--   UPDATE lead_manager.leads SET status='NOT_LEAD'
--    WHERE id IN (SELECT lead_id FROM lead_manager.lead_eventos WHERE autor='migracao-127');
-- Os eventos ficam como registro permanente de quem foi tocado e por quê.
