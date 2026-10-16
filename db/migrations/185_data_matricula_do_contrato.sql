-- ============================================================================
-- 185_data_matricula_do_contrato.sql
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 185_....sql
--
-- POR QUÊ
--   A matrícula e o início das aulas são DATAS DIFERENTES. A família fecha a contratação num dia e
--   as aulas começam dias depois: de julho a outubro de 2026, 220 dos 364 contratos de Valinhos
--   (60%) começaram depois da matrícula, em média 4 dias depois.
--
--   O plano de boas-vindas (ADR-050 §3.1) se ancora na MATRÍCULA ("contratação fechada"). Como o
--   cadastro só guardava `ini_vigencia` (início das aulas), a régua passou a usar essa data: o aluno
--   novo só aparecia para a recepção no primeiro dia de aula, quando a mensagem de boas-vindas já
--   estava atrasada. Foi assim com o Marcos Antônio Prudêncio Jr (matrícula 13/10, aulas 17/10),
--   relatado pela recepção em 16/10/2026.
--
-- O QUE FAZ
--   Uma coluna de data no espelho do contrato. Quem preenche é a rotina de enriquecimento do
--   dashboard (scripts/backfill-sa-enriquecimento.js), que lê `bi_raw.contracts."dataAtivacao"` —
--   a data em que a contratação foi fechada na Extranet.
--
--   Enquanto a coluna estiver vazia (contrato antigo, espelho do BI sem a linha), quem lê cai em
--   `ini_vigencia`, que é o comportamento de hoje. Nada muda sozinho.
--
-- ROLLBACK
--   ALTER TABLE lead_manager.service_account DROP COLUMN data_matricula;
--
-- Aditiva, idempotente, sem índice novo (a coluna é lida junto da linha do contrato).
-- ============================================================================

BEGIN;

ALTER TABLE lead_manager.service_account
  ADD COLUMN IF NOT EXISTS data_matricula date;

COMMENT ON COLUMN lead_manager.service_account.data_matricula IS
  'Data em que a contratação foi fechada (Extranet: dataAtivacao). Diferente de ini_vigencia, que é o início das aulas. Vazia = usar ini_vigencia.';

COMMIT;
