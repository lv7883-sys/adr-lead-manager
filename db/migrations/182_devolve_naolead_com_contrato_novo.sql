-- ============================================================================
-- 182_devolve_naolead_com_contrato_novo.sql
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 182_....sql
--
-- POR QUÊ
--   A 178 fechou as matrículas não registradas de quem estava em ETAPA DE TRABALHO, e o
--   fechaPorContrato automatizou isso daí em diante. Os dois DEIXAM DE FORA quem está marcado
--   'NOT_LEAD' — guarda 2, decisão do Leo: "quando o Regente começou eles já estavam matriculados,
--   ou seja, não eram leads mesmo". Medido em 26/09/2026: a premissa vale em 131 de 135 NOT_LEAD
--   com contrato. Esta migração trata as 4 EXCEÇÕES, em que o contrato começou DEPOIS do lead:
--
--     Carla Manzoni      lead 12/06 · 105 msgs · aula exp. da filha Julia em 11/06 ·
--                        DOIS contratos: Bruno (Baixo 01/08) e Julia (Violão 06/08)
--     Ronaldo D P Bueno  lead 16/06 · filho Leonardo, Piano 30/07
--     Nínive Cavalheiro  lead 04/09 · filho Pedro, Bateria 23/09 · descartada pelo CLASSIFICADOR,
--                        sem revisão humana, 19 dias antes da matrícula
--     Késsia Rebac       FICA DE FORA — ver abaixo.
--
--   Leo autorizou em 01/10/2026: "devolve os 3".
--
-- POR QUE A KÉSSIA NÃO ENTRA (exclusão por ID, e não por propriedade — de propósito)
--   O Leo confirmou em 26/09: é a recepcionista testando o novo modelo de contrato com ela mesma.
--   Isso NÃO é uma propriedade do dado: o contrato dela é indistinguível de uma matrícula real
--   (status 'Cancelado' não serve de filtro — 77 contratos estão assim). Inventar uma regra para
--   excluí-la escondería matrícula real no futuro. Então a exclusão é nominal, com o motivo escrito,
--   e a conferência abaixo garante que ninguém mais entra ou sai por acidente.
--   ⚠ Ela também não está em internal_contacts (medido 26/09) — isso é outro assunto, não é tratado
--   aqui: hoje ela não aparece no funil (sem fato na Extranet) e o contrato está não-pagante.
--
-- CRITÉRIO (por propriedade, lição da 127 — lista de nomes é frágil, propriedade é verificável):
--   NOT_LEAD/REVIEW_QUEUE, sem desfecho, não é contato interno, COM contrato cuja ini_vigencia é
--   >= a data de criação do lead, e SEM nenhum contrato anterior a ela (é o que separa conversão
--   de quem já era aluno antes de virar lead).
--
-- desfecho_em = data REAL do contrato (não now()), para o funil contar no mês certo: Carla e
-- Ronaldo caem em junho (mês do lead; o funil é por coorte), Nínive em setembro.
--
-- review_result FICA COMO ESTÁ, de propósito. Limpar foi o erro da 127: review_result é uma das
-- guardas que impedem o roteador de rebaixar o lead de novo (engine.js, `protegido`), e dois destes
-- três NÃO têm fato na Extranet para protegê-los. Com desfecho preenchido o lead já sai da tela de
-- Descartados (src/descartados.js exige desfecho IS NULL) e fica protegido pelo próprio desfecho.
--
-- Reversível card a card no Monitor (stage_autoapply_log, source='contract_match').
-- Idempotente: só toca lead ainda sem desfecho; re-rodar é no-op.
-- ============================================================================

BEGIN;

\set tid 'ed731a58-62e5-45ad-acba-a5502ff39e92'
\set kessia '82f6edff-558d-4b33-b48b-dc3b74ecf1f0'

CREATE TEMP TABLE _devolve AS
SELECT l.id AS lead_id, l.name, l.status AS status_antes,
       min(sa.ini_vigencia) FILTER (WHERE sa.ini_vigencia >= l.created_at::date) AS matricula,
       string_agg(DISTINCT p.display_name || ' (' || coalesce(sa.servico_label, 'curso') || ' '
                  || to_char(sa.ini_vigencia, 'DD/MM') || ')', ' + ')
         FILTER (WHERE sa.ini_vigencia >= l.created_at::date) AS quem_matriculou
  FROM lead_manager.leads l
  JOIN lead_manager.contact_point cp
       ON cp.kind = 'phone' AND cp.br_key = lead_manager.br_phone_key(l.phone) AND cp.br_key <> ''
  JOIN lead_manager.account_member am ON am.person_id = cp.person_id
  JOIN lead_manager.service_account sa ON sa.id = am.account_id AND sa.fonte_ausente_em IS NULL
  JOIN lead_manager.account_member ben ON ben.account_id = am.account_id AND ben.bond = 'beneficiario'
  JOIN lead_manager.person p ON p.id = ben.person_id
 WHERE l.tenant_id = :'tid'
   AND l.status IN ('NOT_LEAD', 'REVIEW_QUEUE')
   AND l.desfecho IS NULL
   AND l.id <> :'kessia'::uuid                                    -- teste do contrato, não é matrícula
   AND NOT EXISTS (SELECT 1 FROM lead_manager.internal_contacts ic
                    WHERE ic.tenant_id = l.tenant_id
                      AND lead_manager.br_phone_key(ic.phone) = lead_manager.br_phone_key(l.phone))
 GROUP BY l.id, l.name, l.status, l.created_at
HAVING min(sa.ini_vigencia) FILTER (WHERE sa.ini_vigencia >= l.created_at::date) IS NOT NULL
   AND min(sa.ini_vigencia) FILTER (WHERE sa.ini_vigencia <  l.created_at::date) IS NULL;

\echo '--- quem vai ser devolvido ---'
SELECT lead_id, name, status_antes, matricula, quem_matriculou FROM _devolve ORDER BY matricula;

-- CONFERÊNCIA com os números do dia (01/10/2026): exatamente 3, e exatamente estes.
-- Se a Extranet trouxer um 4º caso entre a escrita e a execução, a migração ABORTA em vez de
-- decidir sozinha por alguém que ninguém olhou — o Leo autorizou três nomes, não um critério.
DO $$
DECLARE n int; faltou text;
BEGIN
  SELECT count(*) INTO n FROM _devolve;
  IF n <> 3 THEN
    RAISE EXCEPTION 'esperava 3 leads, achei %. Nada foi escrito — confira a lista acima com o Leo.', n;
  END IF;
  SELECT string_agg(x, ', ') INTO faltou FROM (
    SELECT unnest(ARRAY['082b46db-5a9f-4c2c-ae85-5a85fcab5ab0',
                        '1e9fdc89-46c0-4466-82d3-dd81af38ee1c',
                        '9ac864f5-40c1-4d03-8f74-23632e5e0c80']) AS x) e
   WHERE x::uuid NOT IN (SELECT lead_id FROM _devolve);
  IF faltou IS NOT NULL THEN
    RAISE EXCEPTION 'a lista mudou: % não está mais elegível. Nada foi escrito.', faltou;
  END IF;
END $$;

UPDATE lead_manager.leads l
   SET status = 'CONVERTED', desfecho = 'matriculado', desfecho_source = 'extranet',
       desfecho_em = d.matricula::timestamptz,
       suggested_stage = NULL, stage_reasoning = NULL, stage_suggested_at = NULL, updated_at = now()
  FROM _devolve d
 WHERE l.id = d.lead_id AND l.desfecho IS NULL;

-- Evento + log de reversão, no MESMO formato do fechaPorContrato (_fechar), para o card ser
-- revertido pelo Monitor como qualquer outro. autor='migracao-182' diz quem escreveu.
WITH ev AS (
  INSERT INTO lead_manager.lead_eventos (tenant_id, lead_id, tipo, autor, conteudo, etapa_key)
  SELECT :'tid'::uuid, d.lead_id, 'mudanca_etapa', 'migracao-182',
         'Devolvido ao funil e fechado como matriculado: contrato na Extranet em '
           || to_char(d.matricula, 'DD/MM/YYYY')
           || coalesce(' (' || d.quem_matriculou || ')', '')
           || ', posterior ao primeiro contato. Estava fora do funil como "nao e lead"; o '
           || 'fechamento automatico por contrato nao alcanca NOT_LEAD (guarda 2). '
           || 'Leo autorizou em 01/10/2026.',
         'convertido'
    FROM _devolve d
  RETURNING id, lead_id, conteudo)
INSERT INTO lead_manager.stage_autoapply_log
      (tenant_id, lead_id, from_stage, to_stage, reasoning, source,
       prior_status, prior_desfecho, prior_desfecho_em, evento_id)
SELECT :'tid'::uuid, ev.lead_id, 'qualificando', 'convertido', ev.conteudo, 'contract_match',
       d.status_antes, NULL, NULL, ev.id
  FROM ev JOIN _devolve d ON d.lead_id = ev.lead_id;

\echo '--- depois: os tres leads ---'
SELECT l.name, l.status, l.desfecho, l.desfecho_em::date, l.review_result
  FROM lead_manager.leads l JOIN _devolve d ON d.lead_id = l.id ORDER BY l.desfecho_em;

COMMIT;
