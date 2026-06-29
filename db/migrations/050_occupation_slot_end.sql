-- ============================================================================
-- 050_occupation_slot_end.sql
-- DURAÇÃO da ocupação em resources.occupation_history (Frente A — passo 1).
--
-- Hoje a tabela só guarda `slot_time` (INÍCIO da aula); a duração real (que o parser
-- já extrai em aula.hora_fim) era descartada na captura. Sem o fim, a grade que desconta
-- ocupação teria que assumir 1h fixo — falso (há aulas de 45min, slot 17:30 observado, e
-- banda de 1h30). Esta migration adiciona o FIM do slot para a captura persistir o real.
--
-- ADITIVA e IDEMPOTENTE: só ADD COLUMN IF NOT EXISTS. NÃO dropa nada, NÃO toca linhas
-- existentes. `slot_end` é NULLABLE: linhas legadas ficam NULL (a próxima rodada da captura
-- regrava com slot_end; a grade trata NULL como fallback de 60min — premissa documentada,
-- válida só para o legado, que some na 1ª recaptura). [inicio,fim) com fim exclusivo.
--
-- RODAR COMO postgres (migrations manuais, sem runner; ver memória):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 050_occupation_slot_end.sql
-- ============================================================================

ALTER TABLE resources.occupation_history
  ADD COLUMN IF NOT EXISTS slot_end time;   -- fim do slot ocupado; NULL = legado (fallback 60min na leitura)
