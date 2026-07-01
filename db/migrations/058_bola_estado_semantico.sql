-- ============================================================
-- ADR-030 Passo 2 — ESTADO SEMÂNTICO DA BOLA (escrita da saída), fatia SHADOW.
-- ADITIVA. Sobe TUDO em bola_mode='shadow': NÃO reescreve conversation_state em prod
-- (o corte sincronizado — deixar a saída governar o estado — vem DEPOIS da calibração).
-- A classificação da SAÍDA da recepção ("passou a bola" vs "enrolou") só é OBSERVADA:
-- calcula o estado/relógio SUGERIDOS e loga em bola_shadow_log (molde do gate_shadow_log,
-- mig 055). Nenhum lead muda.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 058_bola_estado_semantico.sql
-- ============================================================

-- 1) Relógio + contador de posse no lead (usados só quando a feature virar 'on';
--    em shadow ficam NULL/0 — o SUGERIDO vai pro log, não pra cá).
ALTER TABLE lead_manager.leads
  ADD COLUMN IF NOT EXISTS bola_nossa_desde timestamptz,          -- marco imutável do ciclo de posse
  ADD COLUMN IF NOT EXISTS adiamentos       int NOT NULL DEFAULT 0;  -- contador POR CICLO de posse

-- 2) Log do modo sombra da bola (append-only, tabela própria — não toca a quente). Molde 1:1
--    do gate_shadow_log: RLS por app.current_tenant, mesmos GRANTs, 2 índices. camada = qual
--    camada decidiu (gate determinístico | modelo leve | skip). veredito NULL em linhas de skip.
CREATE TABLE IF NOT EXISTS lead_manager.bola_shadow_log (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  lead_id                   uuid REFERENCES lead_manager.leads(id) ON DELETE CASCADE,
  outbound_sample_id        uuid REFERENCES lead_manager.staff_outbound_samples(id) ON DELETE SET NULL,
  camada                    text NOT NULL CHECK (camada IN ('gate','modelo_leve','skip')),
  veredito                  text CHECK (veredito IN ('passou_bola','enrolou')),  -- NULL em skip
  confidence                numeric,                          -- só na camada modelo_leve
  reason                    text,
  estado_atual              text,                             -- conversation_state ANTES (leitura)
  estado_sugerido           text,                             -- o que a saída SUGERE (não grava em prod)
  bola_nossa_desde_sugerido timestamptz,                      -- marco sugerido (NULL = ciclo encerrado)
  adiamentos_sugerido       int,                              -- contador sugerido do ciclo (rajada = 1)
  created_at                timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lead_manager.bola_shadow_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.bola_shadow_log;
CREATE POLICY tenant_isolation ON lead_manager.bola_shadow_log
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON lead_manager.bola_shadow_log TO lead_manager_user;
CREATE INDEX IF NOT EXISTS idx_bola_shadow_log_tenant_created
  ON lead_manager.bola_shadow_log (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bola_shadow_log_veredito
  ON lead_manager.bola_shadow_log (tenant_id, veredito, camada);

-- 3) Flag de modo por tenant (molde do gate_suppression_mode, mig 054). DEFAULT 'shadow' =
--    sobe observando (este pacote). 'on' (deixar a saída governar o estado) fica pra depois.
ALTER TABLE lead_manager.tenant_lead_config
  ADD COLUMN IF NOT EXISTS bola_mode text NOT NULL DEFAULT 'shadow'
    CHECK (bola_mode IN ('off','shadow','on'));

-- ROLLBACK:
--   DROP TABLE IF EXISTS lead_manager.bola_shadow_log;
--   ALTER TABLE lead_manager.tenant_lead_config DROP COLUMN IF EXISTS bola_mode;
--   ALTER TABLE lead_manager.leads
--     DROP COLUMN IF EXISTS bola_nossa_desde, DROP COLUMN IF EXISTS adiamentos;
