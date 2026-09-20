-- ============================================================================
-- 170 — mapa_campanha: o DE-PARA entre o que chega do anúncio e o que a mídia paga
-- quer medir (campanha, motor, objetivo, público, criativo).
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 140_mapa_campanha.sql
--
-- POR QUÊ
--   Anúncio Click-to-WhatsApp não traz campanha: traz um `externalAdReply` com o ID do
--   anúncio (sourceId) e o título/corpo do criativo. Sem acesso administrativo ao Meta
--   Business Manager não há Graph API para resolver esse ID em campanha — então o de-para
--   é NOSSO, digitado aqui, e é a única fonte de verdade da leitura de mídia.
--
-- DUAS CHAVES, MESMA LINHA
--   • codigo_campanha — o código que VAI no texto pré-preenchido do anúncio ("Quero saber
--     mais [RK3]"). É nosso: não muda sem aviso, sobrevive a qualquer mudança da Meta e
--     funciona mesmo quando o externalAdReply não vem. É a chave PREFERIDA.
--   • anuncio_id — o ID do anúncio como a Meta o manda. Não controlamos o formato; serve
--     de segunda chance quando o anúncio subiu sem código no texto.
--
-- MULTI-TENANT: a chave primária é (tenant_id, codigo_campanha), não codigo_campanha sozinho.
--   Duas unidades podem usar o mesmo código ("RK1") sem se atropelar, e um INSERT de uma
--   unidade não pode descobrir (por conflito de PK) o código que a outra usa.
--
-- Idempotente. RLS por tenant_id, igual ao resto do schema.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS lead_manager.mapa_campanha (
  tenant_id     uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  codigo_campanha  text NOT NULL,
  anuncio_id  text,                    -- externalAdReply.sourceId (2ª chance de casamento)
  campanha_ref  text,                    -- nome/ref da campanha como a mídia a chama
  motor         text,                    -- 'meta' | 'google' | ... (quem entregou o clique)
  objetivo      text,                    -- 'mensagens', 'tráfego', 'conversão'...
  publico       text,                    -- o público/segmentação do conjunto
  criativo      text,                    -- o anúncio/criativo dentro do conjunto
  valido_de   date,                    -- NULL = sempre valeu
  valido_ate     date,                    -- NULL = ainda vale
  criado_em    timestamptz NOT NULL DEFAULT now(),
  atualizado_em    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, codigo_campanha),
  -- mesma régua do parser do webhook (/\[([A-Z0-9]{2,4})\]\s*$/): código que não casa com
  -- o que o parser consegue ler seria um de-para morto.
  CONSTRAINT mapa_campanha_codigo_chk CHECK (codigo_campanha ~ '^[A-Z0-9]{2,4}$'),
  CONSTRAINT mapa_campanha_janela_chk CHECK (valido_ate IS NULL OR valido_de IS NULL OR valido_ate >= valido_de)
);

-- 2ª chance: casar pelo ID do anúncio quando o texto veio sem código.
CREATE INDEX IF NOT EXISTS idx_mapa_campanha_anuncio
  ON lead_manager.mapa_campanha (tenant_id, anuncio_id) WHERE anuncio_id IS NOT NULL;

ALTER TABLE lead_manager.mapa_campanha ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.mapa_campanha FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.mapa_campanha;
CREATE POLICY tenant_isolation ON lead_manager.mapa_campanha
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.mapa_campanha TO lead_manager_user;

COMMENT ON TABLE lead_manager.mapa_campanha IS
  'De-para anúncio -> campanha (atribuição de mídia paga, Click-to-WhatsApp). Chave preferida: codigo_campanha (nosso, vai no texto do anúncio); anuncio_id = 2ª chance.';

COMMIT;

-- ROLLBACK: DROP TABLE IF EXISTS lead_manager.mapa_campanha;
