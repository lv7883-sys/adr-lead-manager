-- contagem.sql — ADR-051 Fase 0. Conta as linhas de TODAS as tabelas do banco corrente.
-- Só leitura. Roda como postgres (superusuário ignora RLS; como lead_manager_user tudo sairia zerado).
-- Saída: tabela<TAB>linhas, ordenada.
SET default_transaction_read_only = on;
SET statement_timeout = '300s';
SELECT n.nspname || '.' || c.relname AS tabela,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')
       ))[1]::text::bigint AS linhas
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p')
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND n.nspname NOT LIKE 'pg_toast%'
 ORDER BY 1;
