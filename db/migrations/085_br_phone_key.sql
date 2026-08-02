-- 085_br_phone_key.sql — chave canônica de telefone BR para CRUZAR fontes com formatos diferentes.
--
-- Problema (ADR-049): a conversa do WhatsApp guarda o telefone COM DDI 55 (ex.: 554199510828) e o
-- cadastro (contact_point, vindo da Extranet) guarda SEM 55 e com pontuação (ex.: ((19))98175-8175).
-- Casar por dígitos crus dá 0. Esta função porta o `matchKeys` de src/telefoneBR.js para SQL,
-- reduzindo qualquer telefone a uma chave canônica = LOCAL (sem 55) SEM o 9º dígito (DDD + 8).
-- Assim "55DDD9NNNNNNNN", "DDD9NNNNNNNN" e "DDDNNNNNNNN" do MESMO contato convergem.
--
-- Pura (sem acesso a tabela) → IMMUTABLE/PARALLEL SAFE, sem implicação de RLS.
-- ADITIVA: só cria a função; não altera dado nem tabela.
--
-- Aplicar:
--   docker exec -i exp44a3i0nnip54f4xc0is0i psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 \
--     -f db/migrations/085_br_phone_key.sql
-- Rollback:
--   DROP FUNCTION IF EXISTS lead_manager.br_phone_key(text);

CREATE OR REPLACE FUNCTION lead_manager.br_phone_key(x text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH d AS (
    SELECT regexp_replace(coalesce(x, ''), '[^0-9]', '', 'g') AS v
  ),
  loc AS (   -- tira o DDI 55 quando o total tem 12/13 dígitos (10/11 locais + 55)
    SELECT CASE WHEN length(v) IN (12, 13) AND left(v, 2) = '55' THEN substr(v, 3) ELSE v END AS v
      FROM d
  )
  SELECT CASE   -- tira o 9º dígito de celular (11 locais, 3º dígito = '9') → DDD + 8
           WHEN length(v) = 11 AND substr(v, 3, 1) = '9' THEN left(v, 2) || substr(v, 4)
           ELSE v
         END
    FROM loc
$$;

ALTER FUNCTION lead_manager.br_phone_key(text) OWNER TO lead_manager_user;

COMMENT ON FUNCTION lead_manager.br_phone_key(text) IS
  'Chave canônica de telefone BR (local sem 55, sem 9º dígito) p/ casar WhatsApp×cadastro. Porta SQL do matchKeys de src/telefoneBR.js. ADR-049.';
