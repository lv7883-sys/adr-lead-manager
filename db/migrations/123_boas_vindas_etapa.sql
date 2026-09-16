-- ============================================================
-- 123 — BOAS-VINDAS (ADR-050, E17-01): a régua de cada tenant.
--
-- As etapas são DADOS, não código: cada unidade tem a sua cópia (vinda de um modelo, migr. 121) e
-- edita nome, momento, textos, anexo e o que roda em contrato curto. As travas R1–R10 são validadas
-- em src/boasVindasRegua.js (validarRegua) antes de gravar; os CHECKs aqui são a rede estrutural,
-- iguais aos do catálogo.
--
-- Etapa com mensagem já registrada (boas_vindas_toque) NÃO pode ser apagada (FK sem cascade): para
-- tirar de uso, desliga (ativo = false). Assim o histórico do que foi enviado nunca some.
--
-- lead_manager.boas_vindas_copiar_modelo(tenant, slug, por) copia um modelo para a unidade.
-- Recusa se a unidade já tiver régua (nunca sobrescreve edição). SECURITY INVOKER: roda com o RLS
-- de quem chama — só grava no tenant do app.current_tenant.
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 123_boas_vindas_etapa.sql
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS lead_manager.boas_vindas_copiar_modelo(uuid, text, text);
--   DROP TABLE IF EXISTS lead_manager.boas_vindas_etapa;
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS lead_manager.boas_vindas_etapa (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid     NOT NULL REFERENCES lead_manager.tenants (id) ON DELETE CASCADE,
  ordem              smallint NOT NULL CHECK (ordem BETWEEN 1 AND 10),
  nome               text     NOT NULL,
  ancora             text     NOT NULL
                       CHECK (ancora IN ('inicio_contrato', 'atendimento_agendado', 'primeiro_atendimento')),
  quando             jsonb    NOT NULL,
  repeticoes         smallint NOT NULL DEFAULT 1 CHECK (repeticoes BETWEEN 1 AND 3),
  contrato_curto     boolean  NOT NULL DEFAULT false,
  texto_titular      text,
  texto_responsavel  text,
  anexo_id           uuid,
  anexo_sugerido     text,
  entregue_por       text     NOT NULL DEFAULT 'regente' CHECK (entregue_por IN ('regente', 'externo')),
  ativo              boolean  NOT NULL DEFAULT true,
  modelo_slug        text,                              -- procedência (NULL = criada à mão)
  modelo_ordem       smallint,
  atualizado_por     text,
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT boas_vindas_etapa_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT boas_vindas_etapa_ordem_uq     UNIQUE (tenant_id, ordem) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT boas_vindas_etapa_anexo_fk FOREIGN KEY (tenant_id, anexo_id)
    REFERENCES lead_manager.boas_vindas_anexo (tenant_id, id),
  CONSTRAINT bv_etapa_quando_chk CHECK (
       (coalesce(quando->>'tipo', '') = 'dias' AND coalesce(quando->>'valor', '') ~ '^[0-9]{1,2}$')
    OR (coalesce(quando->>'tipo', '') = 'vespera' AND ancora = 'atendimento_agendado')
    OR (coalesce(quando->>'tipo', '') = 'proximo_expediente' AND ancora IN ('atendimento_agendado', 'primeiro_atendimento'))
  ),
  CONSTRAINT bv_etapa_repeticoes_chk CHECK (repeticoes = 1 OR ancora = 'atendimento_agendado'),
  CONSTRAINT bv_etapa_conteudo_chk   CHECK (texto_titular IS NOT NULL OR anexo_id IS NOT NULL OR entregue_por = 'externo')
);
ALTER TABLE lead_manager.boas_vindas_etapa OWNER TO lead_manager_user;
ALTER TABLE lead_manager.boas_vindas_etapa ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.boas_vindas_etapa FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.boas_vindas_etapa;
CREATE POLICY tenant_isolation ON lead_manager.boas_vindas_etapa
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE OR REPLACE FUNCTION lead_manager.boas_vindas_copiar_modelo(p_tenant uuid, p_modelo text, p_por text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  n integer;
BEGIN
  IF p_tenant IS DISTINCT FROM NULLIF(current_setting('app.current_tenant', true), '')::uuid THEN
    RAISE EXCEPTION 'boas-vindas: o tenant informado não é o tenant da sessão (app.current_tenant)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lead_manager.boas_vindas_modelo WHERE slug = p_modelo AND ativo) THEN
    RAISE EXCEPTION 'boas-vindas: modelo inexistente ou inativo: %', p_modelo
      USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM lead_manager.boas_vindas_etapa WHERE tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'boas-vindas: a unidade já tem régua; copiar um modelo não sobrescreve a edição dela'
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO lead_manager.boas_vindas_etapa
    (tenant_id, ordem, nome, ancora, quando, repeticoes, contrato_curto, texto_titular, texto_responsavel,
     anexo_sugerido, entregue_por, ativo, modelo_slug, modelo_ordem, atualizado_por)
  SELECT p_tenant, me.ordem, me.nome, me.ancora, me.quando, me.repeticoes, me.contrato_curto,
         me.texto_titular, me.texto_responsavel, me.anexo_sugerido, me.entregue_por, true,
         me.modelo_slug, me.ordem, p_por
    FROM lead_manager.boas_vindas_modelo_etapa me
   WHERE me.modelo_slug = p_modelo
   ORDER BY me.ordem;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;
COMMENT ON FUNCTION lead_manager.boas_vindas_copiar_modelo(uuid, text, text) IS
  'ADR-050: copia um modelo de régua de boas-vindas para a unidade da sessão. Recusa se já houver régua. Devolve o nº de etapas copiadas.';
GRANT EXECUTE ON FUNCTION lead_manager.boas_vindas_copiar_modelo(uuid, text, text) TO lead_manager_user;

COMMIT;
