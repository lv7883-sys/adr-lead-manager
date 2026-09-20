-- 30-confere-rls.sql — trava de esquema: nenhuma tabela nova sem RLS ativa E forçada.
--
-- ENABLE sozinho não basta: sem FORCE, o DONO da tabela ignora a política. Em produção
-- as tabelas pertencem ao `postgres` e a aplicação é outro papel, então ENABLE seria
-- suficiente na prática — mas basta alguém rodar uma migração como dono para o
-- isolamento sumir sem ninguém perceber. FORCE fecha essa porta.
--
-- Falha com exceção (o psql roda com ON_ERROR_STOP=1), então o make para aqui.

DO $$
DECLARE
  r record;
  faltando text := '';
BEGIN
  FOR r IN
    SELECT n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('plataforma', 'marketing')
       AND c.relkind = 'r'
  LOOP
    IF NOT r.relrowsecurity OR NOT r.relforcerowsecurity THEN
      faltando := faltando || format('%s.%s ', r.nspname, r.relname);
    END IF;
  END LOOP;

  IF faltando <> '' THEN
    RAISE EXCEPTION 'tabela sem RLS ENABLE+FORCE: %', faltando;
  END IF;

  -- E toda tabela dos schemas novos precisa de uma política de fato, não só do flag.
  FOR r IN
    SELECT n.nspname, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('plataforma', 'marketing')
       AND c.relkind = 'r'
       AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
  LOOP
    faltando := faltando || format('%s.%s ', r.nspname, r.relname);
  END LOOP;

  IF faltando <> '' THEN
    RAISE EXCEPTION 'tabela com RLS ligada mas SEM política (nega tudo em silêncio): %', faltando;
  END IF;

  RAISE NOTICE 'RLS conferida: todas as tabelas de plataforma/marketing com ENABLE+FORCE e política';
END $$;
