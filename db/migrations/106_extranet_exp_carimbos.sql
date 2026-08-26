-- ============================================================================
-- 106_extranet_exp_carimbos.sql — CARIMBOS DURÁVEIS de aula experimental (Passo 2 do stages.js).
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 106_extranet_exp_carimbos.sql
--
-- POR QUÊ
--   extranet_lead.situacao é ESTADO ATUAL: o upsert do sync faz `situacao=EXCLUDED.situacao`
--   (sync-extranet-leads.js:50), então quando a Extranet passa o lead para 'Ganhou' o badge
--   'Exp. Realizada' é SOBRESCRITO e o fato de a aula ter acontecido desaparece do espelho.
--   É o mesmo defeito que leads.status já tinha (o move para 'convertido' apaga
--   EXPERIMENTAL_AGENDADA) — um andar abaixo. Resultado no BI: o bucket "realizadas" colapsa
--   para ~0 e a taxa "aula realizada → matrícula" chega a passar de 100%.
--
-- O QUE ESTA MIGRAÇÃO FAZ
--   Duas colunas append-only no espelho. O sync as grava UMA VEZ (COALESCE, nunca limpa) no
--   instante em que OBSERVA a situação — é o único momento em que o fato é visível. A partir daí
--   o funil lê o carimbo, não o badge, e a matrícula deixa de apagar a aula.
--
--   exp_agendada_em  — 1ª vez que o espelho viu este lead em Exp. Agendada OU Exp. Realizada.
--                      (Realizada implica agendada: não se realiza aula que não foi marcada.)
--   exp_realizada_em — 1ª vez que o espelho viu este lead em Exp. Realizada.
--
-- BACKFILL (honesto sobre o que dá e o que não dá para recuperar)
--   Recupera quem está EM Exp. Agendada/Realizada AGORA, usando last_seen_at como melhor
--   timestamp disponível (é quando o sync de fato observou a situação).
--   NÃO recupera quem já passou para 'Ganhou'/'Perdeu' antes desta migração: o badge anterior
--   não foi guardado em lugar nenhum. Esses leads seguem contando pelo proxy (união fato OR proxy
--   em stages.js), que é justamente o fallback desenhado para essa lacuna.
--
-- Aditiva e idempotente. Não altera nenhuma linha de leads.
-- ============================================================================

BEGIN;

ALTER TABLE lead_manager.extranet_lead
  ADD COLUMN IF NOT EXISTS exp_agendada_em  timestamptz,
  ADD COLUMN IF NOT EXISTS exp_realizada_em timestamptz;

COMMENT ON COLUMN lead_manager.extranet_lead.exp_agendada_em IS
  'Append-only: 1ª observação de Exp. Agendada ou Exp. Realizada. Nunca limpo (situacao é sobrescrita).';
COMMENT ON COLUMN lead_manager.extranet_lead.exp_realizada_em IS
  'Append-only: 1ª observação de Exp. Realizada. Fonte do bucket "realizadas" do funil.';

-- Índice do EXISTS correlacionado do funil (stages.js: sourceOfTruth de experimental/realizada).
-- Parcial: só interessa quem tem carimbo — a maioria das linhas do espelho não tem.
CREATE INDEX IF NOT EXISTS idx_extranet_lead_exp_carimbos
  ON lead_manager.extranet_lead (tenant_id, lead_id)
  WHERE lead_id IS NOT NULL AND (exp_agendada_em IS NOT NULL OR exp_realizada_em IS NOT NULL);

-- ---- BACKFILL --------------------------------------------------------------------------------
-- Normalização equivalente à normSituacao() do extranetLeadStage.js (minúsculas, sem pontuação,
-- espaços colapsados). Os valores reais do <select> não têm acento nas chaves que interessam
-- ('Exp. Agendada', 'Exp. Realizada'), então translate() não é necessário aqui.
WITH norm AS (
  SELECT id,
         btrim(regexp_replace(regexp_replace(lower(situacao), '[^a-z0-9 ]+', ' ', 'g'),
                              '\s+', ' ', 'g')) AS s,
         last_seen_at
    FROM lead_manager.extranet_lead
   WHERE situacao IS NOT NULL
)
UPDATE lead_manager.extranet_lead el
   SET exp_agendada_em  = COALESCE(el.exp_agendada_em, n.last_seen_at),
       exp_realizada_em = CASE WHEN n.s IN ('exp realizada', 'experimental realizada')
                               THEN COALESCE(el.exp_realizada_em, n.last_seen_at)
                               ELSE el.exp_realizada_em END
  FROM norm n
 WHERE n.id = el.id
   -- ⚠ ESTA LISTA ESPELHA SITUACAO_EXP_AGENDADA em src/cadastro/extranetLeadStage.js. Mudou lá,
   --   muda aqui. 'Exp. Cancelada' entra porque prova que houve aula MARCADA (é o denominador de
   --   "agendada → realizada"); é pergunta diferente da do SITUACAO_MAP, que decide avanço de etapa.
   AND n.s IN ('exp agendada', 'exp realizada', 'experimental agendada', 'experimental realizada',
               'exp cancelada', 'exp cancelada reagendar');

COMMIT;

-- ---- VERIFICAÇÃO (rodar depois; não altera nada) ----------------------------------------------
-- Quantos leads o funil passa a enxergar como fato, por bucket:
--   SELECT count(*) FILTER (WHERE exp_agendada_em  IS NOT NULL) AS agendadas_fato,
--          count(*) FILTER (WHERE exp_realizada_em IS NOT NULL) AS realizadas_fato
--     FROM lead_manager.extranet_lead WHERE lead_id IS NOT NULL;
--
-- Lacuna não recuperável (já viraram Ganhou/Perdeu antes da migração) — seguem no proxy:
--   SELECT situacao, count(*) FROM lead_manager.extranet_lead
--    WHERE exp_agendada_em IS NULL GROUP BY 1 ORDER BY 2 DESC;
--
-- ---- ENSAIO A/B (rodar ANTES de subir o código; só leitura) -----------------------------------
-- Esta migração é INERTE sem o código novo: nada no app lê as colunas ainda. Então dá para aplicar
-- a migração, esperar um ciclo do sync (3h) e comparar aqui o que o BI mostra HOJE com o que vai
-- passar a mostrar. Se `agend_nova`/`realiz_nova` não fizerem sentido, é só NÃO subir o código —
-- as colunas ficam paradas, sem efeito nenhum.
--
-- SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS mes,
--        count(*) AS leads,
--        count(*) FILTER (WHERE intent = 'SCHEDULE_INTEREST' OR status = 'EXPERIMENTAL_AGENDADA'
--                            OR desfecho = 'nao_compareceu_aula') AS agend_hoje,
--        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM lead_manager.extranet_lead el
--                                        WHERE el.lead_id = leads.id AND el.exp_agendada_em IS NOT NULL)
--                            OR intent = 'SCHEDULE_INTEREST' OR status = 'EXPERIMENTAL_AGENDADA'
--                            OR desfecho = 'nao_compareceu_aula') AS agend_nova,
--        count(*) FILTER (WHERE (intent = 'SCHEDULE_INTEREST' OR status = 'EXPERIMENTAL_AGENDADA'
--                            OR desfecho = 'nao_compareceu_aula')
--                            AND desfecho IS NOT NULL AND desfecho <> 'nao_compareceu_aula') AS realiz_hoje,
--        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM lead_manager.extranet_lead el
--                                        WHERE el.lead_id = leads.id AND el.exp_realizada_em IS NOT NULL)
--                            OR ((intent = 'SCHEDULE_INTEREST' OR status = 'EXPERIMENTAL_AGENDADA'
--                            OR desfecho = 'nao_compareceu_aula')
--                            AND desfecho IS NOT NULL AND desfecho <> 'nao_compareceu_aula')) AS realiz_nova,
--        count(*) FILTER (WHERE desfecho = 'matriculado') AS matriculas
--   FROM lead_manager.leads
--  WHERE created_at >= date_trunc('month', now()) - interval '5 months'
--    AND status NOT IN ('NOT_LEAD', 'REVIEW_QUEUE')
--    AND coalesce(desfecho, '') <> 'cliente'
--  GROUP BY 1 ORDER BY 1;
--
-- Leitura esperada: agend_nova >= agend_hoje e realiz_nova >= realiz_hoje (a união é monotônica);
-- realiz_nova <= agend_nova SEMPRE; e realiz_nova deve subir bastante em relação a realiz_hoje —
-- é justamente o buraco que a conversão abria.
--
-- ---- ROLLBACK ---------------------------------------------------------------------------------
-- Reverter o CÓDIGO já basta: sem ele ninguém lê as colunas, e o BI volta ao proxy na hora.
-- As colunas são aditivas e não tocam nenhum dado pré-existente — podem ficar paradas sem efeito.
-- Só se quiser mesmo limpar (janela de manutenção, política do repo é não dropar em produção):
--   DROP INDEX IF EXISTS lead_manager.idx_extranet_lead_exp_carimbos;
--   ALTER TABLE lead_manager.extranet_lead
--     DROP COLUMN IF EXISTS exp_agendada_em, DROP COLUMN IF EXISTS exp_realizada_em;
-- ⚠ Dropar PERDE as observações acumuladas: o carimbo só é gravável no instante em que o sync vê
--   'Exp. Realizada', e esse badge é sobrescrito por 'Ganhou'. Re-aplicar depois recomeça do zero.
