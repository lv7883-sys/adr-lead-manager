-- ============================================================================
-- 175 — INGESTÃO DE MÍDIA: o grupo de WhatsApp vira matéria-prima de conteúdo.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 175_marketing_ingestao.sql
--   (depende da 173: mesmo schema `marketing`, mesma cota em config_unidade)
--
-- POR QUÊ
--   O professor já filma a aula. Qualquer coisa que exija dele um passo a mais — abrir um
--   app, preencher um formulário, lembrar de enviar depois — não acontece na terça-feira
--   cheia. Então a ingestão se pendura no gesto que ele JÁ faz: mandar a foto no grupo.
--   Zero ação humana além disso.
--
-- DUAS TABELAS
--   • grupo_fonte — QUAIS grupos são fonte de mídia, por unidade. É configuração, não
--     variável de ambiente: cada unidade tem o seu grupo (ou vários), e quem configura é a
--     recepção pela tela, não um deploy.
--   • raw_asset — a matéria-prima. Guarda o arquivo, quem mandou, quando, e em que pé está
--     a curadoria. NÃO é a peça pronta (isso é `marketing.arquivo`): é o que chegou cru,
--     esperando a fase seguinte decidir se vira conteúdo.
--
-- DEDUPLICAÇÃO POR CONTEÚDO
--   Professor reenvia o mesmo vídeo — para outro grupo, no dia seguinte, "caso não tenha
--   chegado". O índice único por (unidade, sha256) faz o segundo envio ser reconhecido como
--   o mesmo arquivo, sem cópia nova em disco e sem duas linhas para curar. Idempotência do
--   webhook é separada: (unidade, mensagem_id) barra a reentrega do MESMO evento.
--
-- O QUE ESTA MIGRAÇÃO NÃO FAZ
--   Nenhuma curadoria, nenhuma IA, nenhuma publicação. `situacao` nasce
--   'pendente_curadoria' e quem a move é a próxima fase.
--
-- Idempotente. RLS em todas as tabelas, comparando TEXTO (ver DECISIONS.md D19).
-- ============================================================================

BEGIN;

-- ── 1. Quais grupos são fonte de mídia, por unidade ────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing.grupo_fonte (
  tenant_id      uuid NOT NULL,
  jid            text NOT NULL,   -- '1203...@g.us' — o id do grupo no WhatsApp
  nome           text,            -- rótulo humano ("Professores Valinhos")
  ativo          boolean NOT NULL DEFAULT true,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, jid),
  -- Só grupo: um telefone 1:1 aqui faria a ingestão capturar conversa de cliente.
  CONSTRAINT grupo_fonte_e_grupo_chk CHECK (jid LIKE '%@g.us')
);

ALTER TABLE marketing.grupo_fonte ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.grupo_fonte FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketing.grupo_fonte;
CREATE POLICY tenant_isolation ON marketing.grupo_fonte
  USING      (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''))
  WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''));
-- A recepção configura pela tela: precisa poder acrescentar, renomear e remover.
GRANT SELECT, INSERT, UPDATE, DELETE ON marketing.grupo_fonte TO lead_manager_user;

-- ── 2. A matéria-prima que chegou do grupo ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing.raw_asset (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  grupo_jid       text NOT NULL,
  -- id da mensagem no WhatsApp: idempotência da reentrega do webhook.
  mensagem_id     text,
  remetente_jid   text,
  remetente_nome  text,            -- pushName: é como o professor aparece para quem curar
  tipo            text NOT NULL CHECK (tipo IN ('imagem', 'video')),
  mime            text,
  duracao_seg     int  CHECK (duracao_seg IS NULL OR duracao_seg >= 0),
  tamanho_bytes   bigint CHECK (tamanho_bytes IS NULL OR tamanho_bytes >= 0),
  -- sha256 do CONTEÚDO. Nulo quando não houve arquivo (cota estourada antes do download).
  sha256          text,
  caminho         text,
  situacao        text NOT NULL DEFAULT 'pendente_curadoria'
                  CHECK (situacao IN ('pendente_curadoria', 'cota_excedida', 'falhou')),
  motivo          text,            -- por que falhou / qual cota estourou: nunca em silêncio
  payload_bruto   jsonb NOT NULL DEFAULT '{}'::jsonb,
  recebido_em     timestamptz,     -- hora da mensagem no WhatsApp
  criado_em       timestamptz NOT NULL DEFAULT now(),
  -- Arquivo só na pasta da própria unidade (mesma trava de marketing.arquivo, migr. 173).
  CONSTRAINT raw_asset_caminho_da_unidade_chk
    CHECK (caminho IS NULL OR (caminho LIKE '/srv/adr-media/' || tenant_id::text || '/%'
                               AND position('..' in caminho) = 0)),
  -- Linha aceita tem arquivo; linha recusada não tem. Impede "aceito sem arquivo".
  CONSTRAINT raw_asset_aceito_tem_arquivo_chk
    CHECK (situacao <> 'pendente_curadoria' OR (caminho IS NOT NULL AND sha256 IS NOT NULL))
);

-- DEDUP POR CONTEÚDO: o mesmo vídeo reenviado não vira segunda linha nem segunda cópia.
-- Parcial porque linha recusada não tem hash — e duas recusas não são "duplicata".
CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_asset_conteudo
  ON marketing.raw_asset (tenant_id, sha256) WHERE sha256 IS NOT NULL;
-- IDEMPOTÊNCIA DO WEBHOOK: reentrega do mesmo evento não duplica.
CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_asset_mensagem
  ON marketing.raw_asset (tenant_id, mensagem_id) WHERE mensagem_id IS NOT NULL;
-- A fila de curadoria e o `make ingest-status`: por unidade, situação e data.
CREATE INDEX IF NOT EXISTS idx_raw_asset_curadoria
  ON marketing.raw_asset (tenant_id, situacao, criado_em DESC);

ALTER TABLE marketing.raw_asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.raw_asset FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON marketing.raw_asset;
CREATE POLICY tenant_isolation ON marketing.raw_asset
  USING      (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''))
  WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant', true), ''));
-- Sem DELETE: matéria-prima não se apaga pela aplicação (a curadoria muda `situacao`).
GRANT SELECT, INSERT, UPDATE ON marketing.raw_asset TO lead_manager_user;

COMMENT ON TABLE marketing.raw_asset IS
  'Mídia crua vinda do grupo de WhatsApp, esperando curadoria. Dedup por sha256 do conteúdo.';

COMMIT;

-- ROLLBACK:
--   DROP TABLE IF EXISTS marketing.raw_asset, marketing.grupo_fonte;
