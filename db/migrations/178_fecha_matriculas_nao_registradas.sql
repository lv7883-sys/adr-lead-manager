-- ============================================================================
-- 178_fecha_matriculas_nao_registradas.sql
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 178_....sql
--
-- POR QUÊ
--   O Leo viu "leads de alunos já matriculados" no funil e mandou checar. São 11 cards parados em
--   EXPERIMENTAL_AGENDADA/QUALIFIED desde jun–ago cuja família FECHOU CONTRATO em agosto, depois
--   da aula experimental. O curso do contrato bate com o curso procurado (Rejane→Canto 08/07,
--   Catarina matriculou Canto 31/08; Gabriela→Piano 30/07, Mariana matriculou Piano 28/08).
--   São CONVERSÕES REAIS que o funil não conta. Confirmado pelo Leo: "todos os 11 foram matriculados".
--
--   ⚠ A leitura anterior desta mesma lista — "são mães querendo aula PARA SI, leads legítimos" —
--   estava ERRADA, e é o motivo de este cabeçalho ser longo. O vínculo `beneficiario` apontar para
--   o filho não significa que o lead seja outra pessoa: significa que a MÃE é o contato e o filho é
--   quem estuda. É o fluxo normal da escola, e o contractConvert já documentava isso ("pai que
--   matricula filho = vínculo do lead do pai"). Duas sessões leram o mesmo dado ao contrário porque
--   pararam no titular do contrato sem comparar CURSO e DATA com o lead.
--
-- POR QUE NÃO FECHOU SOZINHO — duas falhas somadas, ambas registradas:
--   1. a recepção NÃO marca 'Ganhou' na ficha do lead na Extranet ao matricular (medido: nenhuma
--      das 11 fichas está 'Ganhou'; seguem 'Exp. Agendada'/'Exp. Realizada') — e é a situação da
--      ficha que o sync de leads usa para fechar o card;
--   2. `contract_convert_mode='off'` — o mecanismo que fecharia pelo CONTRATO está desligado
--      (decisão de 18/09, registrada no DECISIONS.md em 23/09).
--   Decisão do Leo (23/09) para a raiz: "tem que olhar na extranet e se tem contrato o sistema
--   fecha como matriculado" — tratado à parte; esta migração só desfaz o estoque.
--
-- CRITÉRIO (por propriedade, não por lista de nomes — lição da 127):
--   lead em etapa de TRABALHO, sem desfecho, cujo telefone (br_phone_key) casa com alguém que tem
--   contrato cuja ini_vigencia é >= a data de criação do lead. O ">=" é o que separa os 11 de quem
--   JÁ era cliente antes (Priscila, flavia, Ana Cristina ficam de fora: contrato mais novo anterior
--   ao lead). Vanessa e Cristiane ENTRAM por decisão explícita do Leo: a família já era cliente
--   desde 2025, mas a matrícula nova veio depois do contato — ele confirmou que contam.
--
-- desfecho_em = data REAL do contrato (não now()), para o funil contar no mês certo.
-- desfecho_source='extranet' (migr 042) — a origem do fato é a Extranet, via contrato.
-- Reversível card a card no Monitor (stage_autoapply_log, source='contract_match').
-- Idempotente: só toca lead ainda sem desfecho; re-rodar é no-op.
-- ============================================================================

BEGIN;

\set tid 'ed731a58-62e5-45ad-acba-a5502ff39e92'

CREATE TEMP TABLE _fecha AS
SELECT l.id,
       left(l.name, 28) AS nome,
       l.status AS status_antes,
       max(sa.ini_vigencia) AS matricula,
       (SELECT string_agg(DISTINCT p2.display_name || ' (' || coalesce(sa2.servico_label,'?') || ')', ' / ')
          FROM lead_manager.contact_point cp2
          JOIN lead_manager.account_member am2 ON am2.person_id = cp2.person_id AND am2.bond = 'beneficiario'
          JOIN lead_manager.service_account sa2 ON sa2.id = am2.account_id AND sa2.fonte_ausente_em IS NULL
          JOIN lead_manager.person p2 ON p2.id = am2.person_id
         WHERE cp2.kind = 'phone'
           AND lead_manager.br_phone_key(cp2.value_raw) = lead_manager.br_phone_key(l.phone)
           AND sa2.ini_vigencia >= l.created_at::date) AS quem_matriculou
  FROM lead_manager.leads l
  JOIN lead_manager.contact_point cp ON cp.kind = 'phone'
       AND lead_manager.br_phone_key(cp.value_raw) = lead_manager.br_phone_key(l.phone)
  JOIN lead_manager.account_member am ON am.person_id = cp.person_id
  JOIN lead_manager.service_account sa ON sa.id = am.account_id AND sa.fonte_ausente_em IS NULL
 WHERE l.tenant_id = :'tid'
   AND l.desfecho IS NULL
   AND l.status NOT IN ('NOT_LEAD','REVIEW_QUEUE','PENDING_CLASSIFICATION','OPTED_OUT','CONVERTED')
   AND sa.ini_vigencia >= l.created_at::date        -- matrícula DEPOIS do lead: é conversão
 GROUP BY l.id, l.name, l.status, l.created_at;

\echo '-- quem sera fechado (esperado: 11 linhas):'
SELECT nome, status_antes, to_char(matricula,'DD/MM/YY') AS matricula, quem_matriculou FROM _fecha ORDER BY matricula;

\echo '-- contagem por mes de criacao do lead (o funil conta na coorte do lead):'
SELECT to_char(l.created_at,'YYYY-MM') AS mes, count(*) FROM _fecha f JOIN lead_manager.leads l ON l.id=f.id GROUP BY 1 ORDER BY 1;

-- 1) o card passa a dizer o que o contrato já diz
UPDATE lead_manager.leads l
   SET status = 'CONVERTED',
       desfecho = 'matriculado',
       desfecho_source = 'extranet',
       desfecho_em = f.matricula::timestamptz,
       suggested_stage = NULL, stage_reasoning = NULL, stage_suggested_at = NULL,
       updated_at = now()
  FROM _fecha f
 WHERE l.id = f.id;

-- 2) linha do tempo: de onde veio a informação
INSERT INTO lead_manager.lead_eventos (tenant_id, lead_id, tipo, autor, conteudo, etapa_key)
SELECT :'tid'::uuid, f.id, 'mudanca_etapa', 'migracao-178',
       'Fechado como matriculado: a Extranet registra contrato em ' || to_char(f.matricula,'DD/MM/YYYY')
       || ' (' || coalesce(f.quem_matriculou,'contrato vigente') || '), posterior ao primeiro contato. '
       || 'O card seguia aberto porque a ficha do lead na Extranet nao foi marcada como Ganhou.',
       'convertido'
  FROM _fecha f;

-- 3) reversível card a card no Monitor (078): guarda o estado anterior EXATO
INSERT INTO lead_manager.stage_autoapply_log
       (tenant_id, lead_id, from_stage, to_stage, reasoning, source,
        prior_status, prior_desfecho, prior_desfecho_em, evento_id)
SELECT :'tid'::uuid, f.id,
       CASE WHEN f.status_antes = 'EXPERIMENTAL_AGENDADA' THEN 'experimental'
            WHEN f.status_antes = 'QUALIFIED' THEN 'qualificado'
            ELSE 'qualificando' END,
       'convertido',
       'matricula confirmada por CONTRATO da Extranet (' || to_char(f.matricula,'DD/MM/YYYY') || ')',
       'contract_match',
       f.status_antes, NULL, NULL,
       (SELECT ev.id FROM lead_manager.lead_eventos ev
         WHERE ev.lead_id = f.id AND ev.autor = 'migracao-178' ORDER BY ev.created_at DESC LIMIT 1)
  FROM _fecha f;

\echo '-- depois (todos devem estar CONVERTED/matriculado):'
SELECT f.nome, l.status, l.desfecho, to_char(l.desfecho_em,'DD/MM/YY') AS desfecho_em
  FROM _fecha f JOIN lead_manager.leads l ON l.id = f.id ORDER BY l.desfecho_em;

DROP TABLE _fecha;
COMMIT;

-- ---- VERIFICAÇÃO -----------------------------------------------------------------------------
-- MUDA: o funil passa a contar essas matrículas no MÊS DE CRIAÇÃO DO LEAD (coorte) — a conversão
-- de jun/jul/ago SOBE. É correção para mais, e deliberada: as matrículas existem e não eram
-- contadas. Feita ANTES da apresentação à franqueadora de propósito, para o número não mudar
-- depois de apresentado.
-- NÃO MUDA: os 104 NOT_LEAD (decisão do Leo: "quando o Regente começou eles já estavam
-- matriculados, não eram leads mesmo"); nada da Extranet (só leitura); nenhum outro tenant.
--
-- ---- ROLLBACK --------------------------------------------------------------------------------
-- Card a card no Monitor (reverter restaura o estado exato), ou em bloco:
--   UPDATE lead_manager.leads SET status = s.prior_status, desfecho = NULL, desfecho_source = NULL,
--          desfecho_em = NULL, updated_at = now()
--     FROM lead_manager.stage_autoapply_log s
--    WHERE leads.id = s.lead_id AND s.reasoning LIKE 'matricula confirmada por CONTRATO%';
--   DELETE FROM lead_manager.lead_eventos WHERE autor = 'migracao-178';
