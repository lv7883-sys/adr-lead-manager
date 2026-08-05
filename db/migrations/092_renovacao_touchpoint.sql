-- ============================================================
-- 092 — RENOVAÇÃO: toques antecipados D-10 / D-2 (Fase 1 — "modo avisa").
--
-- Substitui a régua antiga "D-45" (cedo demais e solta): a âncora passa a ser o FIM DO CONTRATO
-- (service_account.fim_vigencia). Um job diário (renovacao-sweep) varre os contratos vigentes e,
-- quando faltam 10 ou 2 dias CORRIDOS para o fim, gera um RASCUNHO da Janis (IA) convidando à
-- renovação e grava um "touchpoint" com status='pendente' — que a recepção vê e usa (modo avisa).
-- O envio automático em massa é a Fase 2 (toggle renovacao_auto_envio).
--
-- Tudo que vem ANTES de D-10 NÃO vira mensagem: é indicador de PREVISÃO (query do sweep) para a
-- recepção e a gestão.
--
-- Destinatário = responsável pelo contrato: o PAGADOR (account_member.bond='pagador') quando existe;
-- senão o próprio aluno (beneficiario). Telefone via contact_point (kind='phone'). Sem telefone → não
-- enfileira (loga). Não reusa reabordagem_tentativas: aquilo é escopo LEAD, e renovação de
-- responsável financeiro NÃO é lead (role_lead_policy, 071).
--
-- IDEMPOTÊNCIA: UNIQUE (tenant_id, account_id, marco, fim_vigencia). Se o contrato renovar, a âncora
-- (fim_vigencia) muda → novos touchpoints do próximo ciclo, sem repetir os do ciclo antigo.
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 092_renovacao_touchpoint.sql
-- ============================================================

-- ---------------------------------------------------------------------------
-- Toggles por tenant (na config da automação, junto de nome_ia/contexto_ia da Janis).
--   renovacao_habilitada — liga/desliga a varredura de renovação do tenant.
--   renovacao_auto_envio — Fase 2: ON = dispara automático p/ todos; OFF = só prepara p/ recepção.
-- ---------------------------------------------------------------------------
ALTER TABLE lead_manager.automacao_config
  ADD COLUMN IF NOT EXISTS renovacao_habilitada boolean NOT NULL DEFAULT true;
ALTER TABLE lead_manager.automacao_config
  ADD COLUMN IF NOT EXISTS renovacao_auto_envio boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Touchpoint de renovação (1 linha = contrato × marco × âncora).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_manager.renovacao_touchpoint (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL REFERENCES lead_manager.service_account(id) ON DELETE CASCADE,
  person_id        uuid NOT NULL REFERENCES lead_manager.person(id) ON DELETE CASCADE,  -- destinatário (responsável)
  marco            text NOT NULL CHECK (marco IN ('D-10','D-2')),
  fim_vigencia     date NOT NULL,                 -- âncora (snapshot p/ idempotência)
  due_date         date NOT NULL,                 -- data-alvo do toque = fim_vigencia - N (corridos)
  phone            text NOT NULL,                 -- telefone resolvido (cru)
  destinatario_nome text,
  aluno_nome       text,
  servico_label    text,                          -- "Bateria", "Baixo"... (contexto do rascunho)
  estrategia       text,                          -- nota da Janis p/ a recepção
  rascunho         text NOT NULL,                 -- mensagem sugerida (voz da Janis)
  status           text NOT NULL DEFAULT 'pendente'
                     CHECK (status IN ('pendente','aprovado','enviado','descartado','erro')),
  auto             boolean NOT NULL DEFAULT false, -- gerado em modo automático (Fase 2)
  enviado_em       timestamptz,
  erro             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, account_id, marco, fim_vigencia)
);
ALTER TABLE lead_manager.renovacao_touchpoint OWNER TO lead_manager_user;
ALTER TABLE lead_manager.renovacao_touchpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.renovacao_touchpoint FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.renovacao_touchpoint;
CREATE POLICY tenant_isolation ON lead_manager.renovacao_touchpoint
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Fila da recepção (pendentes por data) e leitura por contrato.
CREATE INDEX IF NOT EXISTS idx_renovacao_tp_fila
  ON lead_manager.renovacao_touchpoint (tenant_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_renovacao_tp_account
  ON lead_manager.renovacao_touchpoint (tenant_id, account_id);

-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS lead_manager.renovacao_touchpoint;
--   ALTER TABLE lead_manager.automacao_config DROP COLUMN IF EXISTS renovacao_auto_envio;
--   ALTER TABLE lead_manager.automacao_config DROP COLUMN IF EXISTS renovacao_habilitada;
