-- ============================================================
-- 122 — BOAS-VINDAS (ADR-050, E17-01): arquivos anexados às mensagens, por tenant.
--
-- Toda etapa da régua pode levar UM anexo: imagem, vídeo, áudio ou documento (decisão do dono,
-- 2026-09-16). O arquivo fica no disco (MEDIA_ROOT, como src/media.js) e aqui fica o registro.
-- Os limites por tipo (formatos e tamanho) vivem em src/boasVindasRegua.js (ANEXO) e são validados
-- no upload; o CHECK de 100 MB abaixo é só a rede de segurança.
--
-- UNIQUE (tenant_id, id) existe para as FKs COMPOSTAS de etapa/toque: impede que uma etapa de um
-- tenant aponte para o arquivo de outro (FK não passa pelo RLS).
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 122_boas_vindas_anexo.sql
-- ROLLBACK:
--   DROP TABLE IF EXISTS lead_manager.boas_vindas_anexo;
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS lead_manager.boas_vindas_anexo (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES lead_manager.tenants (id) ON DELETE CASCADE,
  nome_arquivo   text NOT NULL,                    -- nome original (o documento chega com ele no WhatsApp)
  mime           text NOT NULL,
  tipo           text NOT NULL CHECK (tipo IN ('imagem', 'video', 'audio', 'documento')),
  tamanho_bytes  bigint NOT NULL CHECK (tamanho_bytes > 0 AND tamanho_bytes <= 104857600),
  caminho        text NOT NULL,                    -- relativo ao MEDIA_ROOT
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  enviado_por    text,
  enviado_em     timestamptz NOT NULL DEFAULT now(),   -- a tela mostra: arte com datas envelhece
  CONSTRAINT boas_vindas_anexo_tenant_id_uq UNIQUE (tenant_id, id)
);
ALTER TABLE lead_manager.boas_vindas_anexo OWNER TO lead_manager_user;
ALTER TABLE lead_manager.boas_vindas_anexo ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.boas_vindas_anexo FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.boas_vindas_anexo;
CREATE POLICY tenant_isolation ON lead_manager.boas_vindas_anexo
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE INDEX IF NOT EXISTS idx_boas_vindas_anexo_tenant
  ON lead_manager.boas_vindas_anexo (tenant_id, enviado_em DESC);

COMMIT;
