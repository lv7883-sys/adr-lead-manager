-- ============================================================================
-- 181_lead_interesse_para_si_desconhecido.sql — corrige a 180 ANTES de popular.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 181_....sql
--
-- O DEFEITO (descoberto ao escrever o populamento, com a tabela ainda VAZIA)
--   A 180 obriga `para_si` a ser true ou false. Ao ir buscar o dado real, a ficha da Extranet
--   NÃO DIZ PARA QUEM É: ela traz o NOME DE QUEM PROCUROU e o CURSO, igual ao nosso lead. Medido
--   nos casos de ontem: a ficha diz "Cristiane Angelino Xavier / Piano" e quem matriculou foi o
--   Bernardo (filho). O "para quem" não está na fonte — está na conversa, que é outro trabalho.
--
--   Com o CHECK binário, popular exigiria escolher entre duas mentiras:
--     `para_si = true`  → afirma que o interesse é do próprio contato. É EXATAMENTE o erro
--                         perigoso que a 180 documenta: funde duas pessoas numa só, invisível.
--     `para_si = false` → exige `beneficiario_nome`, e o único nome disponível é o do CONTATO,
--                         que viraria um beneficiário fantasma com o nome errado.
--
--   Terceiro estado faltando: NÃO SEI. Guardar "não sei" como se fosse "sim" é a origem de metade
--   dos defeitos desta semana (SERVICE lido como automático; telefone lido como identidade).
--
-- A CORREÇÃO: `para_si` passa a aceitar NULL = desconhecido, e o CHECK deixa de exigir escolha.
--   true  → é para o próprio contato (a conversa disse)
--   false → é para outra pessoa, e `beneficiario_nome` diz quem (a conversa disse)
--   NULL  → ninguém disse ainda. É o estado das fichas da Extranet, e é honesto.
--
-- Tabela ainda VAZIA (0 linhas), então a alteração não toca dado nenhum. Aditiva. Nada lê ainda.
-- ============================================================================

ALTER TABLE lead_manager.lead_interesse ALTER COLUMN para_si DROP NOT NULL;
ALTER TABLE lead_manager.lead_interesse ALTER COLUMN para_si DROP DEFAULT;

ALTER TABLE lead_manager.lead_interesse DROP CONSTRAINT IF EXISTS lead_interesse_para_quem;
ALTER TABLE lead_manager.lead_interesse ADD CONSTRAINT lead_interesse_para_quem CHECK (
      (para_si IS TRUE  AND beneficiario_nome IS NULL)      -- para o próprio contato
   OR (para_si IS FALSE AND beneficiario_nome IS NOT NULL)  -- para outra pessoa, com nome
   OR (para_si IS NULL  AND beneficiario_nome IS NULL)      -- ninguém disse ainda
);

COMMENT ON COLUMN lead_manager.lead_interesse.para_si IS
  'true = para o proprio contato; false = para outra pessoa (beneficiario_nome diz quem); NULL = NAO SEI, ninguem disse ainda. NULL e o estado honesto das fichas da Extranet, que trazem quem PROCUROU e o CURSO, nunca o beneficiario. Nunca converter NULL em true por conveniencia: assumir "e para ele mesmo" funde duas pessoas numa so, e o erro e invisivel.';

-- ---- ROLLBACK --------------------------------------------------------------------------------
--   ALTER TABLE lead_manager.lead_interesse DROP CONSTRAINT lead_interesse_para_quem;
--   UPDATE lead_manager.lead_interesse SET para_si = true WHERE para_si IS NULL;  -- ⚠ perde "nao sei"
--   ALTER TABLE lead_manager.lead_interesse ALTER COLUMN para_si SET DEFAULT true;
--   ALTER TABLE lead_manager.lead_interesse ALTER COLUMN para_si SET NOT NULL;
--   ALTER TABLE lead_manager.lead_interesse ADD CONSTRAINT lead_interesse_para_quem CHECK (
--     (para_si AND beneficiario_nome IS NULL) OR (NOT para_si AND beneficiario_nome IS NOT NULL));
