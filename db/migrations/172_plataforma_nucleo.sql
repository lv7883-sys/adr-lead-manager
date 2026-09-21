-- ============================================================================
-- 172 — NÚCLEO DE PLATAFORMA: credenciais por unidade e consumo medido.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 172_plataforma_nucleo.sql
--   depois:  psql ... -f db/grants/plataforma_contratacao_read.sql
--   (ou `make migrate PSQL_DSN=...` num banco de teste)
--
-- REQUER PostgreSQL >= 15 (vista com security_invoker). Nenhuma extensão.
--
-- POR QUÊ
--   As aplicações do Regente passam a ser vendidas SEPARADAMENTE, por unidade — e, depois,
--   para empresas de outros segmentos. Duas coisas que não cabem em variável de ambiente,
--   porque ambiente é do PROCESSO e elas são da UNIDADE:
--     • com qual credencial cada unidade fala com os provedores -> credencial_unidade
--     • quanto cada unidade gastou                              -> consumo_evento
--
-- O QUE ESTA MIGRAÇÃO **NÃO** CRIA (decisão do Leo, 20/09/2026)
--   Nenhuma tabela de contratação/licença. A versão anterior deste arquivo criava
--   `modulo` e `modulo_contratado`, e teriam sido o QUARTO lugar a responder "esta unidade
--   contratou este módulo?" — junto de `app.tenant_modules`, `lead_manager.tenant_subscriptions`
--   e da `plataforma.assinatura` planejada pelo ADR-051. A fonte única é
--   **`plataforma.assinatura` (ADR-051, D9)**. Até ela existir, a resposta vem de
--   `app.tenant_modules` por UM ÚNICO ponto de leitura no código (`src/plataforma/licenca.js`),
--   que na Fase 6 do ADR-051 passa a ler a assinatura — troca de uma consulta, não de N
--   chamadores. Ver DECISIONS.md D18.
--
-- RLS COMPARA TEXTO, NÃO uuid ⚠
--   Neste banco, `app.current_tenant` tem TRÊS formatos: uuid (Lead Manager), cuid
--   (dashboard/BI, via withTenantBi) e inteiro (caminhos por franquia). Uma política com
--   `::uuid` não devolve zero linhas quando chega um cuid — ela QUEBRA a requisição inteira
--   com "invalid input syntax for type uuid", e o erro parece aleatório. Como estas tabelas
--   são da plataforma (todo módulo lê), a comparação é feita como TEXTO, igual ao que o
--   `bi_raw` já faz neste mesmo banco. As consultas da aplicação continuam filtrando
--   `tenant_id = $1` (uuid), então o índice segue sendo usado.
--
-- tenant_id SEM chave estrangeira, de propósito: o núcleo da plataforma não pode depender
--   da tabela de um módulo (`lead_manager.tenants`). Quando o ADR-051 criar
--   `plataforma.unidade`, a chave estrangeira passa a apontar para lá.
--   `tenant_id` é a ÚNICA palavra em inglês mantida: é o nome da coluna de unidade em todas
--   as ~140 tabelas do banco e em todas as políticas de RLS.
--
-- Idempotente. RLS em todas as tabelas, no padrão do ecossistema.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS plataforma;
-- O GRANT vai JUNTO do CREATE SCHEMA (risco C1 do anexo do ADR-051): quem criar o schema
-- primeiro leva o GRANT junto, e as duas migrações usam IF NOT EXISTS — qualquer ordem funciona.
GRANT USAGE ON SCHEMA plataforma TO lead_manager_user;

-- ── 1. Credenciais por unidade (cifradas em repouso) ───────────────────────────────────
-- A CIFRA É DA APLICAÇÃO, NÃO DO BANCO (AES-256-GCM, `src/crypto.js`, chave
-- LM_ENCRYPTION_KEY vinda do ambiente de infra). É o padrão que este sistema já usa em
-- `tenants.evolution_token_enc`, e não é preferência de estilo:
--   • com pgcrypto, a chave viaja como PARÂMETRO de cada consulta — e vai parar em log de
--     erro, em `pg_stat_statements` e no dump. O backup deixaria de proteger o segredo,
--     porque chave e segredo passariam a viver no mesmo lugar;
--   • o teste de restauração já existente (`deploy/fase0/restore-test.sh` + `verifica-cifra.js`)
--     só sabe conferir a cifra da aplicação.
-- Formato: base64( iv[12] | tag[16] | texto cifrado ) — o mesmo do Scheduler.
CREATE TABLE IF NOT EXISTS plataforma.credencial_unidade (
  tenant_id      uuid NOT NULL,
  provedor       text NOT NULL,   -- 'gemini' | 'meta' | 'evolution' | 'extranet' | 'conta_azul' ...
  tipo           text NOT NULL,   -- 'chave_api' | 'token_acesso' | 'instancia' | 'senha' | 'certificado'
  valor_cifrado  text,            -- AES-256-GCM em base64. NUNCA texto claro, nem em log.
  -- O que NÃO é segredo e precisa sobreviver à exclusão do segredo (D10 do ADR-051 manda
  -- apagar a credencial no cancelamento): e-mail, perfil, id da unidade na Extranet, validade.
  metadados      jsonb NOT NULL DEFAULT '{}'::jsonb,
  expira_em      timestamptz,
  verificado_em  timestamptz,
  -- Revogar APAGA o segredo e mantém a linha: fica a trilha (quem, qual provedor, quando).
  -- ⚠ APAGAR AQUI NÃO ENCERRA A EXPOSIÇÃO: os backups já gravados continuam com o segredo
  -- cifrado, e a chave é a mesma. O que encerra é revogar NA ORIGEM (trocar a senha da
  -- Extranet, revogar o token OAuth, girar o token da Evolution) — e é isso que
  -- `metadados->>'revogado_na_origem'` registra. Só linha revogada pode ter valor nulo.
  revogado_em    timestamptz,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provedor, tipo),
  CONSTRAINT credencial_unidade_valor_ou_revogada_chk
    CHECK (valor_cifrado IS NOT NULL OR revogado_em IS NOT NULL)
);

ALTER TABLE plataforma.credencial_unidade ENABLE ROW LEVEL SECURITY;
ALTER TABLE plataforma.credencial_unidade FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON plataforma.credencial_unidade;
CREATE POLICY tenant_isolation ON plataforma.credencial_unidade
  USING      (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''))
  WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''));
GRANT SELECT, INSERT, UPDATE ON plataforma.credencial_unidade TO lead_manager_user;

COMMENT ON COLUMN plataforma.credencial_unidade.valor_cifrado IS
  'AES-256-GCM base64, cifrado pela aplicação (src/crypto.js, LM_ENCRYPTION_KEY). A chave vem da infra e nunca toca o banco.';

-- ── 2. Consumo medido por unidade (só acrescenta, nunca reescreve) ─────────────────────
-- `modulo_codigo` é TEXTO LIVRE, sem chave estrangeira: o catálogo de aplicações é do
-- ADR-051 (`plataforma.aplicacao`) e ainda não existe. Quando existir, vira FK.
CREATE TABLE IF NOT EXISTS plataforma.consumo_evento (
  id                  bigserial PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  modulo_codigo       text NOT NULL,   -- 'MARKETING' | 'LEADS' | 'AGENDA' | 'BI' ...
  -- 'ia_visao' | 'ia_texto' | 'transcricao_seg' | 'video_seg' | 'storage_gb_dia'
  tipo_evento         text NOT NULL,
  quantidade          numeric(14,4) NOT NULL DEFAULT 1 CHECK (quantidade >= 0),
  custo_unitario_brl  numeric(12,6) NOT NULL DEFAULT 0 CHECK (custo_unitario_brl >= 0),
  referencia          text,   -- id da tarefa/recurso que gerou o consumo
  ocorrido_em         timestamptz NOT NULL DEFAULT now()
);

-- a conta do mês, por unidade e por módulo
CREATE INDEX IF NOT EXISTS idx_consumo_unidade_mes
  ON plataforma.consumo_evento (tenant_id, modulo_codigo, ocorrido_em);
-- a checagem de cota antes de processar (tipo de evento + janela)
CREATE INDEX IF NOT EXISTS idx_consumo_cota
  ON plataforma.consumo_evento (tenant_id, modulo_codigo, tipo_evento, ocorrido_em);

ALTER TABLE plataforma.consumo_evento ENABLE ROW LEVEL SECURITY;
ALTER TABLE plataforma.consumo_evento FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON plataforma.consumo_evento;
CREATE POLICY tenant_isolation ON plataforma.consumo_evento
  USING      (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''))
  WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''));
-- Para a aplicação, só acrescentar: medição não se reescreve nem se apaga.
GRANT SELECT, INSERT ON plataforma.consumo_evento TO lead_manager_user;
GRANT USAGE, SELECT ON SEQUENCE plataforma.consumo_evento_id_seq TO lead_manager_user;

-- ── 3. Custo por unidade / mês ─────────────────────────────────────────────────────────
-- security_invoker: a vista NÃO é porta dos fundos na RLS — ela é lida com os privilégios
-- de quem consulta, então a política da consumo_evento continua valendo. O filtro explícito
-- é o cinto além do suspensório, e compara TEXTO pelo mesmo motivo das políticas.
CREATE OR REPLACE VIEW plataforma.vw_custo_unidade_mes
WITH (security_invoker = true) AS
  SELECT tenant_id,
         modulo_codigo,
         date_trunc('month', ocorrido_em)::date       AS competencia,
         tipo_evento,
         sum(quantidade)                              AS quantidade,
         sum(quantidade * custo_unitario_brl)         AS custo_brl,
         count(*)                                     AS eventos
    FROM plataforma.consumo_evento
   WHERE tenant_id::text = NULLIF(current_setting('app.current_tenant', true), '')
   GROUP BY 1, 2, 3, 4;

GRANT SELECT ON plataforma.vw_custo_unidade_mes TO lead_manager_user;

COMMIT;

-- ROLLBACK:
--   DROP VIEW IF EXISTS plataforma.vw_custo_unidade_mes;
--   DROP TABLE IF EXISTS plataforma.consumo_evento, plataforma.credencial_unidade;
--   DROP SCHEMA IF EXISTS plataforma;   -- só se nada do ADR-051 tiver nascido nele
