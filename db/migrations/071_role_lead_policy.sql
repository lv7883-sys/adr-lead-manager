-- ============================================================
-- ADR-036 E1.4/E1.5 — MÁQUINA papel→política (config-as-data, por vertical/tenant).
-- Tira a pergunta de resgate do (inexistente) hardcode e a põe em CONFIG POR TENANT: cada
-- papel (canônico: prestador/beneficiario/responsavel_financeiro) tem sua PERGUNTA de resgate
-- + ação default + escopo, POR TENANT. O motor (src/roleLeadPolicy.js) lê a linha do tenant
-- atual — o core nunca conhece o texto. Um 2º tenant de outra vertical semeia perguntas
-- diferentes sem tocar o core.
--
-- ADITIVA: 1 tabela + 1 função de seed (o "template de vertical" do E1.5, hoje seed não-tabela)
-- + seed retroativo do Valinhos (escola de música). RLS FORCE idêntico ao 060/070.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 071_role_lead_policy.sql
--
-- ROLLBACK: DROP FUNCTION seed_role_lead_policy_escolas(uuid); DROP TABLE role_lead_policy;
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.role_lead_policy (
  tenant_id      uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  role           text NOT NULL,                         -- casa com contact_role.key (canônico)
  default_action text NOT NULL CHECK (default_action IN ('descarta','vigia')),
  rescue_prompt  text,                                  -- a PERGUNTA (critério fechado) do resgate; NULL = sem resgate específico
  rescue_scope   text NOT NULL DEFAULT 'estreito' CHECK (rescue_scope IN ('estreito','amplo')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role)
);
ALTER TABLE lead_manager.role_lead_policy OWNER TO lead_manager_user;
ALTER TABLE lead_manager.role_lead_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.role_lead_policy FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.role_lead_policy;
CREATE POLICY tenant_isolation ON lead_manager.role_lead_policy
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Template da vertical "ESCOLAS" (config-as-data): semeia as perguntas padrão da vertical para
-- um tenant, keyed pelos papéis CANÔNICOS. Idempotente. Um tenant pode SOBRESCREVER a linha
-- depois (override). Outra vertical terá sua própria função de seed. Textos = critérios FECHADOS
-- que o classificador avalia com o papel como contexto, devolvendo {resgata, confidence, motivo}.
CREATE OR REPLACE FUNCTION lead_manager.seed_role_lead_policy_escolas(p_tenant uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO lead_manager.role_lead_policy (tenant_id, role, default_action, rescue_prompt, rescue_scope) VALUES
    (p_tenant, 'prestador', 'descarta',
     'O contato é um PRESTADOR (ex.: professor) da escola. Por padrão, conversa dele é operacional (não é lead). '
     || 'RESGATA como lead SOMENTE se a conversa mostra intenção EXPLÍCITA de MATRICULAR a si mesmo ou alguém da PRÓPRIA FAMÍLIA '
     || '(cônjuge, filho) como aluno pagante. NÃO resgata: agendar/tratar aula de um aluno da escola (é o trabalho dele), '
     || 'indicar um amigo/conhecido (escopo amplo, ainda não liberado), assunto administrativo/pagamento. '
     || 'Responda {resgata, confidence, motivo}.',
     'estreito'),
    (p_tenant, 'beneficiario', 'descarta',
     'O contato é um ALUNO já matriculado. Por padrão, conversa dele é pós-venda/rotina (não é lead). '
     || 'RESGATA como lead se: (a) EXPANSÃO — o próprio aluno querendo MAIS serviço (outra modalidade, aula extra), OU '
     || '(b) PESSOA NOVA — ele está trazendo/mencionando uma pessoa diferente para se matricular (outro filho, parente, um amigo). '
     || 'NÃO resgata: remarcação, renovação, cobrança, dúvida administrativa, recado da conta atual. '
     || 'Responda {resgata, confidence, motivo}.',
     'estreito'),
    (p_tenant, 'responsavel_financeiro', 'descarta',
     'O contato é o RESPONSÁVEL FINANCEIRO de um aluno. Por padrão, conversa dele é sobre a conta atual (não é lead). '
     || 'RESGATA como lead se está trazendo uma PESSOA NOVA para matricular (outro filho, ele mesmo querendo estudar) '
     || 'ou EXPANDIR o serviço do aluno atual (nova modalidade/aula extra). '
     || 'NÃO resgata: remarcação, renovação, pagamento, assunto administrativo da conta atual. '
     || 'Responda {resgata, confidence, motivo}.',
     'estreito')
  ON CONFLICT (tenant_id, role) DO NOTHING;
$$;
COMMENT ON FUNCTION lead_manager.seed_role_lead_policy_escolas(uuid) IS
  'Template da vertical "escolas" (ADR-036 E1.5): semeia role_lead_policy (prestador/beneficiario/responsavel_financeiro) de um tenant. Idempotente; tenant pode sobrescrever.';

-- Seed retroativo do Valinhos (escola de música). Idempotente.
SELECT lead_manager.seed_role_lead_policy_escolas('ed731a58-62e5-45ad-acba-a5502ff39e92');

COMMENT ON TABLE lead_manager.role_lead_policy IS
  'ADR-036 E1.4/E1.5: política papel→{default_action, rescue_prompt, rescue_scope} por tenant. O motor (roleLeadPolicy.js) lê a linha do tenant atual; sem linha → default seguro (vigia, sem resgate específico).';
