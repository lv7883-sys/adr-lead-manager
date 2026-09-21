-- ============================================================================
-- 174 — origem_lead: devolve os privilégios ao que a 171 pretendia.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 174_origem_lead_privilegios.sql
--
-- POR QUÊ (descoberto ao conferir a aplicação da 171 em produção, 21/09/2026)
--   A 171 concede de propósito apenas SELECT, INSERT e UPDATE de TRÊS colunas — a origem é
--   imutável, e o gatilho `trg_origem_lead_imutavel` garante o resto. Só que o schema
--   `lead_manager` tem uma regra ANTIGA de privilégios padrão
--   (`ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO lead_manager_user`, visível em
--   pg_default_acl como `{lead_manager_user=arwd/postgres}`): toda tabela nova criada ali
--   nasce com INSERT, SELECT, UPDATE e **DELETE** para a aplicação, por cima do que a
--   migração pediu.
--
--   Resultado em produção: `lead_manager_user` podia APAGAR linhas de origem. O gatilho não
--   alcança isso — ele é BEFORE UPDATE, e DELETE não passa por ele. Uma consulta errada
--   apagaria a atribuição de um lead para sempre, sem deixar rastro.
--
--   Os schemas `plataforma` e `marketing` não têm essa regra e receberam exatamente o que
--   foi concedido; o problema é só do `lead_manager`.
--
-- POR QUE UMA MIGRAÇÃO, E NÃO UM COMANDO À MÃO
--   Privilégio corrigido no console é divergência entre o repositório e a realidade, que
--   ninguém lembra seis meses depois. Aqui fica versionado e reaplicável.
--
-- NÃO mexe na regra de privilégios padrão do schema: outras tabelas do `lead_manager`
-- dependem dela hoje, e mudá-la seria uma decisão de outra frente. Esta migração corrige
-- UMA tabela, a que precisa ser imutável.
--
-- Idempotente. Só privilégios: nenhum dado é tocado.
-- ============================================================================

BEGIN;

-- Zera o que a regra padrão concedeu e devolve só o que a 171 pretendia.
REVOKE ALL ON lead_manager.origem_lead FROM lead_manager_user;

GRANT SELECT, INSERT ON lead_manager.origem_lead TO lead_manager_user;
-- UPDATE por COLUNA: o vínculo com o lead e, na exclusão LGPD, o que identifica a pessoa.
-- Campanha, anúncio e método ficam fora — recusados pelo banco antes mesmo do gatilho.
GRANT UPDATE (lead_id, telefone, payload_bruto, anuncio_url, anuncio_titulo, anuncio_texto)
  ON lead_manager.origem_lead TO lead_manager_user;

-- Sem DELETE: a origem não se apaga pela aplicação. A faxina de retenção roda como
-- superusuário; a exclusão LGPD APAGA O CONTEÚDO da linha, não a linha.
COMMIT;

-- Conferência (esperado: SELECT, INSERT e UPDATE só nas 6 colunas; DELETE negado):
--   SELECT has_table_privilege('lead_manager_user','lead_manager.origem_lead','DELETE');
--
-- ROLLBACK: GRANT ALL ON lead_manager.origem_lead TO lead_manager_user;
