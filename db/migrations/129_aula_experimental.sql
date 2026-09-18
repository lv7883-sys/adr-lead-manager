-- ============================================================================
-- 129_aula_experimental.sql — uma linha por AULA EXPERIMENTAL da agenda da Extranet.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 129_aula_experimental.sql
--
-- POR QUÊ
--   O funil de conversão (BI Leads) dizia "aula agendada → realizada = 33%". A agenda da Extranet,
--   pela mesma pergunta, mostra 63% (jul), 78% (ago) e 77% (set). O Leo olhou e disse que o número
--   parecia irreal. Era.
--
--   O funil sabia se uma aula aconteceu por DEDUÇÃO: lia a situação ATUAL de cada pessoa na tela de
--   leads da Extranet a cada 3h e carimbava 'Exp. Realizada' se flagrasse. Quem matriculava logo
--   depois da aula pulava direto para 'Ganhou' e a aula sumia; quem fazia a aula e depois virava
--   'Perdeu' também. Dos 15 que marcaram aula e matricularam, só 4 tinham a aula registrada.
--
--   A agenda da Extranet não deduz: ela REGISTRA cada aula experimental com o resultado, e a página
--   de detalhe (mod_agenda/detalhar_aula.php) traz aluno, responsável e TELEFONE. Com telefone, a
--   ligação aula → lead usa a mesma chave de todo o resto do sistema (br_phone_key, migr 085).
--   Esta tabela é o espelho dessa agenda — o mesmo papel que extranet_lead (migr 102) faz para a
--   tela de leads.
--
-- O QUE GUARDA
--   • status_cod — o CÓDIGO do <select name="status"> da Extranet, não o rótulo:
--       0 Prevista · 99 Prevista Online · 100 Confirmada pelo aluno
--       200 Realizada · 210 Realizada sem matrícula · 220 Realizada com matrícula posterior
--       230 Realizada Online · 300 Falta do aluno · 305 Falta do professor
--       310 Cancelada pelo aluno · 320 Cancelada pelo professor
--   • rotulo_mes — o rótulo que a página MENSAL mostra hoje; rotulo_mes_detalhado — o que ela
--     mostrava quando o detalhe foi lido. Divergiu → reler o detalhe. É o que pega uma aula
--     'Realizada' que vira 'Realizada com matrícula posterior' quando a pessoa matricula, sem
--     reabrir todas as aulas todo dia (cada busca na Extranet custa ~25s de fila).
--
--   ⚠ DADO PESSOAL MÍNIMO. Guarda nome, responsável e telefones — o necessário para ligar a aula ao
--   lead e para alguém conferir o casamento. NÃO guarda e-mail nem idade, que a página traz: o
--   funil não precisa deles, e dado que não é guardado não vaza nem precisa ser apagado.
--
-- Idempotente. RLS igual ao extranet_lead.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS lead_manager.aula_experimental (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  aula_id               text NOT NULL,                 -- id da Extranet (aula_edit("N"))
  competencia           text,                          -- 'YYYY-MM' da página mensal onde apareceu
  data                  date,
  status_cod            int,
  status_rotulo         text,
  rotulo_mes            text,                          -- rótulo na página mensal (última leitura)
  rotulo_mes_detalhado  text,                          -- rótulo mensal quando o detalhe foi lido
  aluno                 text,
  responsavel           text,
  fone1_raw             text,
  fone2_raw             text,
  origem_extranet       text,                          -- "Como chegou até a escola"
  curso                 text,
  professor             text,
  phone_key             text GENERATED ALWAYS AS (lead_manager.br_phone_key(fone1_raw)) STORED,
  phone_key2            text GENERATED ALWAYS AS (lead_manager.br_phone_key(fone2_raw)) STORED,
  lead_id               uuid,                          -- sem FK: lead apagado não pode travar o espelho
  detalhe_em            timestamptz,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, aula_id)
);

ALTER TABLE lead_manager.aula_experimental ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.aula_experimental FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.aula_experimental;
CREATE POLICY tenant_isolation ON lead_manager.aula_experimental
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON lead_manager.aula_experimental TO lead_manager_user;

-- o funil pergunta "este lead tem aula?" — por lead_id
CREATE INDEX IF NOT EXISTS idx_aula_exp_tenant_lead
  ON lead_manager.aula_experimental (tenant_id, lead_id) WHERE lead_id IS NOT NULL;
-- o sync pergunta "que lead tem este telefone?" — e religa os órfãos a cada run
CREATE INDEX IF NOT EXISTS idx_aula_exp_tenant_phone_key
  ON lead_manager.aula_experimental (tenant_id, phone_key) WHERE phone_key <> '';

COMMIT;

-- ROLLBACK: DROP TABLE lead_manager.aula_experimental;   (é espelho: re-populável pelo sync)
