-- ============================================================
-- ADR-037 Emenda 2026-07-22 — POLÍTICA DE PROVENIÊNCIA (humano vs scraping).
-- Eixo ortogonal ao "de onde veio" (D5 source/confidence): responde "um humano travou
-- este campo?". Fundação (SEM tela, SEM cron): 2 tabelas laterais ESPARSAS + 3 funções
-- genéricas que o scraping consulta ANTES de escrever.
--
-- Granularidade = POR CAMPO (não por registro); GERAL = qualquer campo editável, qualquer
-- tenant (tabela + `field` como chave-texto, sem código por-campo). Aditiva: 2 tabelas novas,
-- ZERO coluna nas tabelas de cadastro, ZERO mudança de RLS nas existentes.
--
-- Padrão de RLS idêntico ao 060: OWNER lead_manager_user + ENABLE + FORCE + policy por
-- current_setting('app.current_tenant'). FORCE porque o dono é a app (senão leria sem filtro).
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 070_field_provenance.sql
--
-- ROLLBACK (aditivo/reversível):
--   DROP FUNCTION IF EXISTS lead_manager.marcar_edicao_humana(text,uuid,text,text,text);
--   DROP FUNCTION IF EXISTS lead_manager.aplicar_scraping(text,uuid,text,text,text);
--   DROP FUNCTION IF EXISTS lead_manager.dispensar_alerta(text,uuid,text);
--   DROP TABLE IF EXISTS lead_manager.field_divergence;
--   DROP TABLE IF EXISTS lead_manager.field_provenance;
-- ============================================================

-- ---------------------------------------------------------------------------
-- 1) TRAVA por campo. Linha existe  ⇔  campo editado por humano (protegido).
--    Esparsa: só o campo que um humano de fato tocou ganha linha (default = livre p/ scraping).
--    entity_kind reusa o vocabulário do external_ref ('person','contact_point',…); field é o
--    nome da coluna ('display_name','data_nascimento','payer_relation','value','tipo',…).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_manager.field_provenance (
  tenant_id   uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  entity_kind text NOT NULL,
  entity_id   uuid NOT NULL,
  field       text NOT NULL,
  human_value text,                                   -- valor cravado pelo humano (texto p/ comparação canônica)
  actor       text,                                   -- quem editou (req.user.sub / papel)
  locked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entity_kind, entity_id, field)
);
ALTER TABLE lead_manager.field_provenance OWNER TO lead_manager_user;
ALTER TABLE lead_manager.field_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.field_provenance FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.field_provenance;
CREATE POLICY tenant_isolation ON lead_manager.field_provenance
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 2) ALERTA de divergência. Linha existe  ⇔  o scraping trouxe, para um campo TRAVADO, valor
--    diferente do humano. `dismissed_value` = o source_value cuja dispensa vale (NULL = nunca
--    dispensado). ATIVO (aparece na tela) = dismissed_value IS DISTINCT FROM source_value —
--    logo a dispensa silencia SÓ aquele valor; source_value novo ≠ dispensado ⇒ RESSURGE.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_manager.field_divergence (
  tenant_id       uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  entity_kind     text NOT NULL,
  entity_id       uuid NOT NULL,
  field           text NOT NULL,
  human_value     text,                               -- valor humano (protegido) no momento
  source_value    text,                               -- valor divergente que o scraping trouxe
  source          text,                               -- de onde veio ('extranet','api_extranet',…)
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  dismissed_value text,                               -- valor cuja dispensa vale (NULL = ativo)
  PRIMARY KEY (tenant_id, entity_kind, entity_id, field)
);
ALTER TABLE lead_manager.field_divergence OWNER TO lead_manager_user;
ALTER TABLE lead_manager.field_divergence ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.field_divergence FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.field_divergence;
CREATE POLICY tenant_isolation ON lead_manager.field_divergence
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
-- índice p/ a tela futura: alertas ATIVOS do tenant (não dispensados / ressurgidos).
CREATE INDEX IF NOT EXISTS idx_field_divergence_ativo
  ON lead_manager.field_divergence (tenant_id)
  WHERE dismissed_value IS DISTINCT FROM source_value;

-- ---------------------------------------------------------------------------
-- 3) FUNÇÕES (genéricas, tenant vem do current_setting → tenant-safe + RLS). SECURITY INVOKER
--    (default): rodam sob o contexto/RLS do chamador.
-- ---------------------------------------------------------------------------

-- marcar_edicao_humana: humano editou o campo pela tela → grava/atualiza a TRAVA (human_value)
-- e RESOLVE qualquer divergência pendente do campo (o humano acabou de cravar a verdade).
CREATE OR REPLACE FUNCTION lead_manager.marcar_edicao_humana(
  p_entity_kind text, p_entity_id uuid, p_field text, p_human_value text, p_actor text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t uuid := NULLIF(current_setting('app.current_tenant', true), '')::uuid;
BEGIN
  INSERT INTO lead_manager.field_provenance (tenant_id, entity_kind, entity_id, field, human_value, actor, locked_at)
  VALUES (t, p_entity_kind, p_entity_id, p_field, p_human_value, p_actor, now())
  ON CONFLICT (tenant_id, entity_kind, entity_id, field)
  DO UPDATE SET human_value = EXCLUDED.human_value, actor = EXCLUDED.actor, locked_at = now();
  DELETE FROM lead_manager.field_divergence
   WHERE tenant_id = t AND entity_kind = p_entity_kind AND entity_id = p_entity_id AND field = p_field;
END; $$;

-- aplicar_scraping: DECISÃO + gestão do alerta. NÃO escreve a base — devolve o veredito e o
-- chamador (sync/cron) escreve SÓ quando 'ESCREVE' (mantém o core neutro, sem dynamic SQL;
-- espelha o sync.js, onde o código do sync faz os UPDATEs, não uma função de banco).
--   'ESCREVE' = campo não protegido → chamador escreve normal.
--   'IGUAL'   = protegido e valor == humano → nada (e limpa o alerta se havia: convergiu).
--   'DIVERGE' = protegido e valor != humano → cria/atualiza alerta, NÃO escreve.
CREATE OR REPLACE FUNCTION lead_manager.aplicar_scraping(
  p_entity_kind text, p_entity_id uuid, p_field text, p_source_value text, p_source text DEFAULT NULL
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE t uuid := NULLIF(current_setting('app.current_tenant', true), '')::uuid; hv text;
BEGIN
  SELECT human_value INTO hv
    FROM lead_manager.field_provenance
   WHERE tenant_id = t AND entity_kind = p_entity_kind AND entity_id = p_entity_id AND field = p_field;
  IF NOT FOUND THEN
    RETURN 'ESCREVE';                                 -- não protegido → chamador escreve
  END IF;
  IF p_source_value IS NOT DISTINCT FROM hv THEN      -- protegido e igual → nada (auto-limpa o alerta)
    DELETE FROM lead_manager.field_divergence
     WHERE tenant_id = t AND entity_kind = p_entity_kind AND entity_id = p_entity_id AND field = p_field;
    RETURN 'IGUAL';
  END IF;
  -- protegido e DIVERGENTE → registra/atualiza o alerta (dismissed_value é preservado: se o
  -- source_value continuar == dispensado, segue silencioso; se mudou, o índice/consulta o trata
  -- como ativo → RESSURGE). NÃO escreve a base.
  INSERT INTO lead_manager.field_divergence
    (tenant_id, entity_kind, entity_id, field, human_value, source_value, source, first_seen, last_seen, dismissed_value)
  VALUES (t, p_entity_kind, p_entity_id, p_field, hv, p_source_value, p_source, now(), now(), NULL)
  ON CONFLICT (tenant_id, entity_kind, entity_id, field)
  DO UPDATE SET human_value = EXCLUDED.human_value, source_value = EXCLUDED.source_value,
                source = EXCLUDED.source, last_seen = now();
  RETURN 'DIVERGE';
END; $$;

-- dispensar_alerta: recepção silencia o VALOR atual da divergência (dismissed_value := source_value).
-- Idempotente; ressurge sozinho quando um scraping futuro trouxer um source_value diferente.
CREATE OR REPLACE FUNCTION lead_manager.dispensar_alerta(
  p_entity_kind text, p_entity_id uuid, p_field text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t uuid := NULLIF(current_setting('app.current_tenant', true), '')::uuid;
BEGIN
  UPDATE lead_manager.field_divergence
     SET dismissed_value = source_value
   WHERE tenant_id = t AND entity_kind = p_entity_kind AND entity_id = p_entity_id AND field = p_field;
END; $$;

COMMENT ON TABLE lead_manager.field_provenance IS
  'ADR-037 emenda 2026-07-22: trava por campo (linha existe ⇔ campo editado por humano → scraping não sobrescreve). Esparsa, genérica (entity_kind/field texto), multi-tenant (RLS).';
COMMENT ON TABLE lead_manager.field_divergence IS
  'ADR-037 emenda 2026-07-22: alerta de divergência (scraping trouxe valor != humano p/ campo travado). ATIVO = dismissed_value IS DISTINCT FROM source_value. Some sozinho quando converge.';
