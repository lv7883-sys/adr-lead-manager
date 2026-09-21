-- ============================================================================
-- 173 — MOTOR DE MARKETING: identidade visual, arquivos e fila com rodízio por unidade.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 173_marketing_nucleo.sql
--   (depende da 172: a fila mede consumo em plataforma.consumo_evento; a contratação vem
--    de src/plataforma/licenca.js, o ponto único que hoje lê app.tenant_modules)
--
-- POR QUÊ
--   O motor de marketing é MÓDULO DE PRODUTO, vendido por unidade — não um satélite de
--   uma escola. Então nada aqui nasce "de uma unidade com tenant_id opcional": toda tabela
--   tem tenant_id NOT NULL, RLS ativa e índice de fila liderado por tenant_id.
--
-- O QUE ESTE ARQUIVO NÃO FAZ
--   Nenhuma lógica de IA, nenhum intermediário de mensagens, nenhum armazenamento externo.
--   A fila é uma tabela com `SELECT ... FOR UPDATE SKIP LOCKED`; o arquivo é um caminho em
--   disco. Trocar isso depois é decisão de escala, não de arquitetura.
--
-- CADA UNIDADE TEM A SUA FILA (o rodízio é só a ordem de atendimento)
--   As tarefas de uma unidade são invisíveis para as outras (RLS) e nenhuma consegue
--   adiantar, atrasar ou ver a fila da vizinha. O que é compartilhado é o TRABALHADOR que
--   processa — como um atendente único no balcão. O rodízio garante que ele alterne entre
--   as filas em vez de esvaziar a maior primeiro: quem mandou 1 peça não espera as 500 da
--   outra unidade. `marketing.unidades_com_fila()` responde só "quem está esperando e desde
--   quando" — id e contagem, nunca conteúdo de ninguém.
--
-- Idempotente. RLS em todas as tabelas, no padrão do ecossistema.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS marketing;
GRANT USAGE ON SCHEMA marketing TO lead_manager_user;

-- ── 1. Identidade visual da unidade (é com isto que a peça é desenhada) ────────────────
CREATE TABLE IF NOT EXISTS marketing.config_unidade (
  tenant_id       uuid PRIMARY KEY,
  nome_exibicao   text,
  selo_caminho    text,                       -- arquivo sob a raiz de mídia da unidade
  cor_primaria    text CHECK (cor_primaria   IS NULL OR cor_primaria   ~ '^#[0-9A-Fa-f]{6}$'),
  cor_secundaria  text CHECK (cor_secundaria IS NULL OR cor_secundaria ~ '^#[0-9A-Fa-f]{6}$'),
  fonte           text,
  assinatura      text,
  -- LIMITE DE USO do motor, NÃO contratação: esta coluna não diz se a unidade contratou o
  -- módulo (isso é `plataforma.assinatura`, ADR-051 D9) — diz quanto cabe no mês dela.
  -- Chaves lidas: tarefas_mes, ia_visao_mes, ia_texto_mes, transcricao_seg_mes,
  -- video_seg_mes, storage_gb_dia. Ausente = sem limite.
  -- Quando a assinatura carregar o plano, a cota migra para lá e esta coluna some.
  cota            jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  atualizado_em   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE marketing.config_unidade ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.config_unidade FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketing.config_unidade;
CREATE POLICY tenant_isolation ON marketing.config_unidade
  USING      (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''))
  WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''));
GRANT SELECT, INSERT, UPDATE ON marketing.config_unidade TO lead_manager_user;

-- ── 2. Arquivos: o caminho vem da unidade, nunca do que o usuário digitou ──────────────
-- A trava é do BANCO, não só do código: o caminho TEM de começar em
-- /srv/adr-media/<tenant_id>/ e não pode conter '..'. Um erro de tratamento no aplicativo
-- (ou um módulo novo que esqueça a regra) esbarra aqui antes de gravar a linha.
CREATE TABLE IF NOT EXISTS marketing.arquivo (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  tipo           text NOT NULL CHECK (tipo IN ('imagem', 'video', 'audio', 'documento')),
  caminho        text NOT NULL,
  mime           text,
  tamanho_bytes  bigint CHECK (tamanho_bytes IS NULL OR tamanho_bytes >= 0),
  sha256         text,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  -- ⚠ a raiz '/srv/adr-media' está escrita aqui E em src/marketing/midia.js (ADR_MEDIA_ROOT).
  --   Mudar uma sem a outra faz TODA gravação de arquivo ser recusada — de propósito: é melhor
  --   falhar na primeira linha do que gravar metade dos arquivos numa raiz e metade na outra.
  CONSTRAINT arquivo_caminho_da_unidade_chk
    CHECK (caminho LIKE '/srv/adr-media/' || tenant_id::text || '/%'
           AND position('..' in caminho) = 0),
  UNIQUE (tenant_id, caminho)
);

CREATE INDEX IF NOT EXISTS idx_arquivo_unidade
  ON marketing.arquivo (tenant_id, criado_em DESC);

ALTER TABLE marketing.arquivo ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.arquivo FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketing.arquivo;
CREATE POLICY tenant_isolation ON marketing.arquivo
  USING      (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''))
  WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''));
GRANT SELECT, INSERT, UPDATE ON marketing.arquivo TO lead_manager_user;

-- ── 3. Fila de tarefas ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing.tarefa (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  tipo          text NOT NULL,               -- 'render_imagem' | 'transcrever' | 'publicar' ...
  situacao      text NOT NULL DEFAULT 'pendente'
                CHECK (situacao IN ('pendente', 'processando', 'concluida', 'falhou', 'cota_excedida')),
  dados         jsonb NOT NULL DEFAULT '{}'::jsonb,
  prioridade    smallint NOT NULL DEFAULT 0,
  tentativas    smallint NOT NULL DEFAULT 0,
  erro          text,
  motivo_cota   text,                        -- qual cota estourou (não some em silêncio)
  trabalhador   text,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  pega_em       timestamptz,                 -- também é o relógio do rodízio
  concluido_em  timestamptz
);

-- Fila: índice composto LIDERADO POR tenant_id, parcial nas pendentes. Serve as duas
-- perguntas do despacho — "quem está esperando?" e "qual a próxima desta unidade?".
CREATE INDEX IF NOT EXISTS idx_tarefa_fila_unidade
  ON marketing.tarefa (tenant_id, prioridade DESC, criado_em)
  WHERE situacao = 'pendente';
-- relógio do rodízio: última vez que cada unidade foi atendida
CREATE INDEX IF NOT EXISTS idx_tarefa_rodizio
  ON marketing.tarefa (tenant_id, pega_em DESC NULLS LAST);
-- acompanhamento ("como está a fila da minha unidade?")
CREATE INDEX IF NOT EXISTS idx_tarefa_unidade_situacao
  ON marketing.tarefa (tenant_id, situacao, criado_em DESC);

ALTER TABLE marketing.tarefa ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.tarefa FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketing.tarefa;
CREATE POLICY tenant_isolation ON marketing.tarefa
  USING      (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''))
  WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''));
GRANT SELECT, INSERT, UPDATE ON marketing.tarefa TO lead_manager_user;

-- ── 4. Quem está esperando (pergunta da PLATAFORMA, não de uma unidade) ────────────────
-- SECURITY DEFINER com search_path fixo (não sequestrável). Devolve id da unidade,
-- quantas pendentes e quando foi atendida pela última vez — nenhum dado de conteúdo.
-- Mesmo padrão de `lead_manager.tenants_active()`, que as rotinas já usam.
CREATE OR REPLACE FUNCTION marketing.unidades_com_fila()
RETURNS TABLE(tenant_id uuid, pendentes bigint, ultima_vez timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = marketing, pg_catalog, pg_temp
AS $$
  SELECT t.tenant_id,
         count(*) FILTER (WHERE t.situacao = 'pendente')  AS pendentes,
         max(t.pega_em)                                   AS ultima_vez
    FROM marketing.tarefa t
   GROUP BY t.tenant_id
  HAVING count(*) FILTER (WHERE t.situacao = 'pendente') > 0
$$;

REVOKE ALL ON FUNCTION marketing.unidades_com_fila() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marketing.unidades_com_fila() TO lead_manager_user;

COMMIT;

-- ROLLBACK:
--   DROP FUNCTION IF EXISTS marketing.unidades_com_fila();
--   DROP TABLE IF EXISTS marketing.tarefa, marketing.arquivo, marketing.config_unidade;
--   DROP SCHEMA IF EXISTS marketing;
