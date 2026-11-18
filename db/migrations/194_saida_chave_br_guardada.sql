-- ============================================================
-- 194_saida_chave_br_guardada.sql — A CHAVE DE TELEFONE GUARDADA NA TABELA DE SAÍDAS.
--
-- POR QUE EXISTE, com o número medido. A contagem do "número do ícone"
-- (src/semAtendimentoHumano.js) roda a cada carga de página, a cada foco de aba e a cada 45 s por
-- pessoa com o Regente aberto. Medida em produção em 18/11/2026, sob a ROLE da aplicação:
--
--     Seq Scan on staff_outbound_samples ......   107 ms   <- LER a tabela (86.149 linhas)
--     Hash sobre ela ..........................  1.909 ms   <- CALCULAR br_phone_key 86.149 vezes
--
-- ⚠ O custo não é I/O, é FUNÇÃO. `br_phone_key` é LANGUAGE sql, mas o corpo usa CTEs — e o
--   Postgres não inlina função com CTE. Cada chamada custa. Índice resolve "achar a linha"; aqui
--   o problema é "calcular a chave". Eu criei um índice por expressão antes de medir direito, ele
--   NÃO foi usado (o planejador preferiu hash), e o derrubei — índice não usado não é neutro:
--   custa uma chamada de função por INSERT numa tabela que recebe toda saída de WhatsApp.
--
-- ESTA MIGRAÇÃO COPIA UM PADRÃO QUE JÁ EXISTE NESTA CASA: `conversations.br_key` é
-- `GENERATED ALWAYS AS (br_phone_key(external_id)) STORED`, 2.372/2.372 preenchidas, com índice
-- (tenant_id, br_key) — e usar essa coluna no lado das conversas fez aquele trecho cair de
-- 1.527 ms para 67 ms. Aqui é a mesma ideia, pela via que não para a escola.
--
-- ─── POR QUE NÃO É COLUNA GERADA, COMO EM `conversations` ──────────────────────────────────────
--
-- `ADD COLUMN ... GENERATED ALWAYS AS (...) STORED` REESCREVE a tabela, sob ACCESS EXCLUSIVE.
-- Esta tabela tem **200 MB** e recebe toda saída de WhatsApp da escola: enquanto a reescrita
-- rodasse, nenhuma mensagem entraria nem sairia — e o despachante de webhooks não tem fila nem
-- repetição, então eco perdido nessa janela é eco perdido.
--
-- Então: coluna COMUM (nullable, sem default = só metadado, instantâneo) + GATILHO que a mantém.
-- Nenhuma dessas operações pega ACCESS EXCLUSIVE por tempo relevante.
--
-- ⚠ GATILHO, E NÃO "cada caminho de escrita preenche". Hoje são pelo menos dois (outbound.js e
--   staffSamples.js) e amanhã pode ser outro. Confiar em todos lembrarem é a mesma família de
--   defeito que esta entrega já pagou DUAS vezes nesta semana: proteção que existe no texto e não
--   no mecanismo. O gatilho é mecanismo — nenhum caminho novo consegue esquecer.
--
-- ⚠ O UPDATE do preenchimento NÃO bloqueia escrita: UPDATE pega ROW EXCLUSIVE, que é compatível
--   com INSERT de outra sessão. O que ele deixa é 86 mil tuplas mortas para o autovacuum, que é o
--   preço, e é aceitável nesta tabela.
--
-- ⚠ ESTE ARQUIVO NÃO TEM BEGIN/COMMIT e NÃO pode ser aplicado com `psql -1`: o
--   CREATE INDEX CONCURRENTLY do fim não roda dentro de transação.
--
-- Executar como superuser "postgres", SEM -1:
--   psql "$DATABASE_URL" -f db/migrations/194_saida_chave_br_guardada.sql
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_staff_br_key ON lead_manager.staff_outbound_samples;
--   DROP FUNCTION IF EXISTS lead_manager.staff_outbound_br_key();
--   DROP INDEX CONCURRENTLY IF EXISTS lead_manager.idx_staff_tenant_brkey;
--   ALTER TABLE lead_manager.staff_outbound_samples DROP COLUMN IF EXISTS br_key;
-- ============================================================

-- (1) A coluna. Nullable e sem default: em PG 11+ isto é só metadado, sem reescrita.
ALTER TABLE lead_manager.staff_outbound_samples
  ADD COLUMN IF NOT EXISTS br_key text;

COMMENT ON COLUMN lead_manager.staff_outbound_samples.br_key IS
  'br_phone_key(external_id) GUARDADA, mantida por gatilho. Espelha conversations.br_key. Existe '
  'porque calcular a chave em 86 mil linhas custava 1,9 s por consulta, e a contagem do número do '
  'ícone roda a cada 45 s por pessoa. Nunca escreva nela à mão: o gatilho sobrescreve.';

-- (2) O gatilho que a mantém. BEFORE INSERT OR UPDATE OF external_id: só recalcula quando o que
--     ela deriva muda, para não pagar a função em todo UPDATE (e esta tabela tem UPDATE no
--     ON CONFLICT do registrarSaida).
CREATE OR REPLACE FUNCTION lead_manager.staff_outbound_br_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.br_key := lead_manager.br_phone_key(NEW.external_id);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION lead_manager.staff_outbound_br_key() IS
  'Mantém staff_outbound_samples.br_key. Gatilho e não responsabilidade de quem escreve: há pelo '
  'menos dois caminhos de inserção hoje (outbound.js, staffSamples.js) e confiar em todos lembrarem '
  'seria proteção no comentário, não no mecanismo.';

DROP TRIGGER IF EXISTS trg_staff_br_key ON lead_manager.staff_outbound_samples;
CREATE TRIGGER trg_staff_br_key
  BEFORE INSERT OR UPDATE OF external_id ON lead_manager.staff_outbound_samples
  FOR EACH ROW EXECUTE FUNCTION lead_manager.staff_outbound_br_key();

-- (3) Preenchimento do que já existe. Uma passagem; ROW EXCLUSIVE, não trava INSERT de ninguém.
UPDATE lead_manager.staff_outbound_samples
   SET br_key = lead_manager.br_phone_key(external_id)
 WHERE br_key IS NULL;

-- (4) O índice da pergunta real: "existe saída nossa para ESTE contato, nesta unidade?".
--     CONCURRENTLY porque a tabela está em uso; por isso este arquivo não roda em transação.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_staff_tenant_brkey
    ON lead_manager.staff_outbound_samples (tenant_id, br_key);

-- Conferência depois de aplicar (quem aplica roda e cola no RESERVAS):
--   SELECT count(*) AS total, count(br_key) AS preenchidas FROM lead_manager.staff_outbound_samples;
--   SELECT indisvalid FROM pg_index WHERE indexrelid='lead_manager.idx_staff_tenant_brkey'::regclass;
--   -- e o gatilho funciona? (transação desfeita)
--   BEGIN; INSERT INTO lead_manager.staff_outbound_samples (tenant_id, channel, external_id, source, body)
--     VALUES ('<tenant>', 'whatsapp', '+55 19 98765-4321', 'api', 'teste');
--   SELECT br_key FROM lead_manager.staff_outbound_samples WHERE body='teste'; ROLLBACK;
--   -- esperado: 1987654321 (sem 55, sem o 9º dígito)
