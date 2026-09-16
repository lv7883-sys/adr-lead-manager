-- ============================================================
-- 124 — BOAS-VINDAS (ADR-050, E17-01): cada mensagem da régua para um contrato.
--
-- 1 linha = contrato × etapa × repetição (a etapa "lembrete das 2 primeiras aulas" tem repetições 1 e 2).
--
-- IDEMPOTÊNCIA: UNIQUE (tenant_id, account_id, etapa_id, repeticao). A chave NÃO inclui a data da
-- âncora de propósito: se a 1ª aula for remarcada, a linha ainda pendente tem o due_at atualizado —
-- nunca nasce uma segunda mensagem para a mesma etapa. Renovação gera outro service_account, então
-- não colide (e renovação nem recebe boas-vindas: R9).
--
-- status:
--   pendente        pronta, aguardando a recepção (modo avisa) ou o envio (modo auto)
--   bloqueado       falta pré-requisito — `bloqueio` diz qual (R8): nunca sai com lacuna
--   aprovado        a recepção aprovou, envio em curso
--   enviado | descartado | erro
--   fora_da_janela  passaria do teto da régua (R2) ou do prazo de tolerância (R6) — registrada, não enviada
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 124_boas_vindas_toque.sql
-- ROLLBACK:
--   DROP TABLE IF EXISTS lead_manager.boas_vindas_toque;
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS lead_manager.boas_vindas_toque (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid     NOT NULL REFERENCES lead_manager.tenants (id) ON DELETE CASCADE,
  account_id         uuid     NOT NULL REFERENCES lead_manager.service_account (id) ON DELETE CASCADE,
  person_id          uuid     REFERENCES lead_manager.person (id) ON DELETE CASCADE,   -- destinatário
  etapa_id           uuid     NOT NULL,
  repeticao          smallint NOT NULL DEFAULT 1 CHECK (repeticao BETWEEN 1 AND 3),
  ancora_data        date     NOT NULL,             -- data da âncora usada no cálculo (informativa)
  due_at             timestamptz NOT NULL,          -- timestamptz: véspera e próximo expediente têm hora
  versao             text     NOT NULL CHECK (versao IN ('titular', 'responsavel')),
  phone              text,                          -- NULL só com bloqueio = 'sem_telefone'
  destinatario_nome  text,
  cliente_nome       text,
  texto_final        text,                          -- texto já interpolado no momento de gerar/enviar
  anexo_id           uuid,
  status             text     NOT NULL DEFAULT 'pendente'
                       CHECK (status IN ('pendente', 'bloqueado', 'aprovado', 'enviado', 'descartado', 'erro', 'fora_da_janela')),
  bloqueio           text     CHECK (bloqueio IS NULL OR bloqueio IN
                       ('sem_telefone', 'sem_horario', 'sem_profissional', 'sem_anexo', 'sem_horario_atendimento')),
  motivo             text,                          -- ex.: "agrupada com a de outro contrato do mesmo telefone"
  auto               boolean  NOT NULL DEFAULT false,
  enviado_em         timestamptz,
  erro               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT boas_vindas_toque_uq UNIQUE (tenant_id, account_id, etapa_id, repeticao),
  CONSTRAINT boas_vindas_toque_etapa_fk FOREIGN KEY (tenant_id, etapa_id)
    REFERENCES lead_manager.boas_vindas_etapa (tenant_id, id),
  CONSTRAINT boas_vindas_toque_anexo_fk FOREIGN KEY (tenant_id, anexo_id)
    REFERENCES lead_manager.boas_vindas_anexo (tenant_id, id),
  CONSTRAINT bv_toque_bloqueio_chk CHECK ((status = 'bloqueado') = (bloqueio IS NOT NULL)),
  CONSTRAINT bv_toque_telefone_chk CHECK (phone IS NOT NULL OR bloqueio IS NOT DISTINCT FROM 'sem_telefone' OR status IN ('descartado', 'fora_da_janela')),
  CONSTRAINT bv_toque_enviado_chk  CHECK (status <> 'enviado' OR enviado_em IS NOT NULL)
);
ALTER TABLE lead_manager.boas_vindas_toque OWNER TO lead_manager_user;
ALTER TABLE lead_manager.boas_vindas_toque ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.boas_vindas_toque FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.boas_vindas_toque;
CREATE POLICY tenant_isolation ON lead_manager.boas_vindas_toque
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Fila da recepção / do envio automático.
CREATE INDEX IF NOT EXISTS idx_boas_vindas_toque_fila
  ON lead_manager.boas_vindas_toque (tenant_id, status, due_at);
-- Leitura por contrato (linha do tempo do cliente).
CREATE INDEX IF NOT EXISTS idx_boas_vindas_toque_account
  ON lead_manager.boas_vindas_toque (tenant_id, account_id);
-- R7 — uma mensagem por família por dia: busca por telefone no dia.
CREATE INDEX IF NOT EXISTS idx_boas_vindas_toque_phone
  ON lead_manager.boas_vindas_toque (tenant_id, phone, due_at) WHERE phone IS NOT NULL;

COMMIT;
