-- ============================================================
-- 102 — LEADS DA EXTRANET (mod_leads) como FONTE: espelho + modo por tenant + fonte no autoapply.
--
-- A Extranet é onde a recepção cadastra leads que NÃO nasceram no WhatsApp (walk-in, telefone,
-- indicação) e onde o fluxo lead → aula experimental → matrícula é REGISTRADO DE FATO. O sync
-- (READ-ONLY, cron a cada 3h em horário comercial) raspa mod_leads/lista_todos_leads.php e:
--   1) ESPELHA cada linha aqui (extranet_lead) — proveniência bruta, soft-delete, nunca apaga;
--   2) CASA com leads existentes por telefone (lead_manager.br_phone_key, migr 085) — dedup;
--   3) CRIA lead (origem='extranet') quando não existe;
--   4) MOVE etapa FORWARD-ONLY conforme a Situação (extranet_lead_mode='auto', decisão do Leo
--      2026-08-11: "move e indica que moveu") com lead_eventos + stage_autoapply_log → reversível.
--
-- HIERARQUIA DE PRIORIDADE (decisão 2026-08-11): HUMANO > EXTRANET > IA.
--   A Extranet registra FATOS (experimental agendada, matrícula lançada); a IA infere de conversa.
--   Matrícula da Extranet grava desfecho='matriculado' (desfecho_source='extranet', migr 042) →
--   terminal, a IA para de tocar. A IA não rebaixa etapa sustentada pela Extranet (guarda no engine).
--
-- ANTI-LEAKAGE: a estrutura da Extranet vive no adapter (valinhos-leads.js); o sync core lê só
-- o espelho normalizado. Molde: 072 (soft-delete), 078/079 (autoapply/modo por tenant).
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 102_extranet_leads.sql
-- ============================================================

-- (a) ESPELHO da lista de leads da Extranet. 1 linha por lead da Extranet (extranet_id).
--     phone_key GERADA por br_phone_key (IMMUTABLE, 085) = chave canônica de dedup (DDD+8).
--     lead_id = link permanente com o lead do LM (casado por telefone ou criado pelo sync).
--     fonte_ausente_em = soft-delete (sumiu da lista; reaparecer limpa) — molde service_account/072.
CREATE TABLE IF NOT EXISTS lead_manager.extranet_lead (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  extranet_id      text NOT NULL,            -- id do lead na Extranet (ou chave natural, ver adapter)
  nome             text,
  fone_raw         text,                     -- como veio da fonte (proveniência); normalização é no lead
  curso            text,
  professor        text,
  situacao         text,                     -- badge da lista, cru (ex.: 'Exp. Agendada', 'Conexão')
  data_cadastro    timestamptz,              -- "Data" da lista (criação do lead NA EXTRANET)
  ult_contato      date,
  prox_contato     date,
  phone_key        text GENERATED ALWAYS AS (lead_manager.br_phone_key(fone_raw)) STORED,
  lead_id          uuid REFERENCES lead_manager.leads(id) ON DELETE SET NULL,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  fonte_ausente_em timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, extranet_id)            -- idempotência do upsert (re-run não duplica)
);
ALTER TABLE lead_manager.extranet_lead OWNER TO lead_manager_user;
ALTER TABLE lead_manager.extranet_lead ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.extranet_lead FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.extranet_lead;
CREATE POLICY tenant_isolation ON lead_manager.extranet_lead
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON lead_manager.extranet_lead TO lead_manager_user;
CREATE INDEX IF NOT EXISTS idx_extranet_lead_tenant_phone_key
  ON lead_manager.extranet_lead (tenant_id, phone_key) WHERE phone_key IS NOT NULL AND phone_key <> '';
CREATE INDEX IF NOT EXISTS idx_extranet_lead_tenant_lead
  ON lead_manager.extranet_lead (tenant_id, lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_extranet_lead_tenant_presentes
  ON lead_manager.extranet_lead (tenant_id) WHERE fonte_ausente_em IS NULL;

-- (b) MODO por tenant (molde contract_convert_mode/079, tri-estado):
--   'off'        = INERTE (default; nada roda para o tenant, nem o espelho).
--   'suggestion' = espelho + criação de lead + a régua só grava suggested_stage (recepção confirma).
--   'auto'       = espelho + criação + move FORWARD-ONLY direto, com evento + log reversível.
ALTER TABLE lead_manager.tenant_lead_config
  ADD COLUMN IF NOT EXISTS extranet_lead_mode text NOT NULL DEFAULT 'off'
    CHECK (extranet_lead_mode IN ('off','suggestion','auto'));
-- Rollout deliberado (não flipa aqui). Valinhos → 'auto' (decisão 2026-08-11):
--   UPDATE lead_manager.tenant_lead_config SET extranet_lead_mode='auto', updated_at=now()
--    WHERE tenant_id='<valinhos>';

-- (c) stage_autoapply_log aceita a fonte nova — Monitor/reverter é genérico sobre a tabela,
--     então a reversão card a card dos moves da Extranet sai de graça (molde 079(c)).
ALTER TABLE lead_manager.stage_autoapply_log
  DROP CONSTRAINT IF EXISTS stage_autoapply_log_source_check;
ALTER TABLE lead_manager.stage_autoapply_log
  ADD CONSTRAINT stage_autoapply_log_source_check
    CHECK (source IN ('event','backfill','contract_match','extranet_lead'));

-- (d) Lookup de dedup: leads por chave canônica de telefone (o matching do sync e o índice
--     funcional que o /leads da 101 já usa por dígitos; aqui é a chave DDD+8 da 085).
CREATE INDEX IF NOT EXISTS idx_leads_tenant_phone_key
  ON lead_manager.leads (tenant_id, lead_manager.br_phone_key(phone)) WHERE phone IS NOT NULL;

-- ROLLBACK:
--   DROP INDEX IF EXISTS lead_manager.idx_leads_tenant_phone_key;
--   ALTER TABLE lead_manager.stage_autoapply_log DROP CONSTRAINT IF EXISTS stage_autoapply_log_source_check;
--   ALTER TABLE lead_manager.stage_autoapply_log ADD CONSTRAINT stage_autoapply_log_source_check
--     CHECK (source IN ('event','backfill','contract_match'));
--   ALTER TABLE lead_manager.tenant_lead_config DROP COLUMN IF EXISTS extranet_lead_mode;
--   DROP TABLE IF EXISTS lead_manager.extranet_lead;
--   -- leads criados pela fonte (se necessário): DELETE FROM lead_manager.leads WHERE origem='extranet'
--   --   AND id NOT IN (SELECT lead_id FROM ...);  -- avaliar caso a caso; moves são reversíveis no Monitor.
