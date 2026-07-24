-- ============================================================
-- Gate 0 (rescue question) — flag por tenant do SHADOW da "rescue com CONVERSA".
-- ADITIVA. Molde IDÊNTICO a gate_suppression_mode (054) / bola_mode (058): tri-estado
-- off/shadow/on por tenant, catalog-only (NOT NULL DEFAULT constante → sem rewrite em PG11+;
-- tenant_lead_config tem 1 linha por tenant). NÃO toca gate_suppression_mode/bola_mode.
--
-- SEMÂNTICA (lida por src/engine.js:_gateConfig → gate hard):
--   'off'    = INERTE. A rescue julga só a MENSAGEM atual (comportamento pré-correção). 0 custo extra.
--   'shadow' = calcula TAMBÉM o veredito COM a conversa e loga os dois lado a lado no gate_shadow_log
--              (rescue:<ação real>|msg:<..>|conv:<..>|div:<Y/N>), mas a AÇÃO do gate segue message-only.
--   'on'     = FLIP: o veredito COM a conversa passa a MANDAR na ação do gate (ainda loga os dois).
--
-- DEFAULT 'off' p/ TODOS os tenants (nenhum muda até setar). Valinhos → 'shadow' (rollout).
-- FLIP futuro = UPDATE ... SET rescue_conv_mode='on' (sem deploy). KILL-SWITCH = voltar p/ 'off'/'shadow'.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 076_rescue_conv_mode.sql
-- ============================================================

ALTER TABLE lead_manager.tenant_lead_config
  ADD COLUMN IF NOT EXISTS rescue_conv_mode text NOT NULL DEFAULT 'off'
    CHECK (rescue_conv_mode IN ('off','shadow','on'));

-- Rollout: Valinhos (escola de música) entra em SHADOW. Idempotente.
UPDATE lead_manager.tenant_lead_config
   SET rescue_conv_mode = 'shadow', updated_at = now()
 WHERE tenant_id = 'ed731a58-62e5-45ad-acba-a5502ff39e92'
   AND rescue_conv_mode <> 'shadow';

-- ROLLBACK:
--   ALTER TABLE lead_manager.tenant_lead_config DROP COLUMN IF EXISTS rescue_conv_mode;
