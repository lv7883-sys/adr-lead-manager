-- ============================================================
-- CONVERTIDO POR ORIGEM + ESTADO "CLIENTE" (079 — decisão final do Leo, pós-diagnóstico de origem).
--
-- RÉGUA DE VÍNCULO (quem é pagante): o lead está ligado a um contrato (service_account) via
-- account_member — como beneficiario (é o aluno) OU pagador (é o responsável). Pai que matricula
-- filho = vínculo do lead do pai. Usa o VÍNCULO do cadastro (ADR-037), não fuzzy de nome. A ponte
-- lead→person é o telefone (contact_point), pois leads não tem person_id.
--
-- RÉGUA DE ORIGEM (o que o vínculo SIGNIFICA) — o que esta migration acrescenta:
--   Só é CONVERSÃO o lead que NASCEU no funil do Regente e DEPOIS virou contrato. Cliente cujo
--   contrato é anterior à existência dele como lead é CADASTRO, não conversão — não infla a taxa.
--     marco do lead   = PRIMEIRA MENSAGEM da conversa (fallback: leads.created_at quando não há
--                       conversa). NÃO usar created_at como marco primário: a ingestão em lote de
--                       jun/2026 carimbou created_at até 13 dias depois da 1ª mensagem real.
--     matrícula       = MENOR ini_vigencia entre TODOS os contratos da pessoa (inclusive expirados).
--                       Usar a do contrato VIGENTE seria ler a RENOVAÇÃO como matrícula nova — 13
--                       veteranos de Valinhos (Vanessa Garcia: 5 contratos desde 2024) cairiam como
--                       conversão só por terem renovado depois de mandar mensagem.
--     matrícula >= marco - JANELA  → CONVERTIDO (data = a matrícula real)
--     matrícula <  marco - JANELA  → CLIENTE (pré-existente: pagante reconhecido, fora da fila e
--                                   fora da taxa; nem suja o trabalho, nem infla o número)
--   JANELA (contract_convert_janela_dias, default 7) = tolerância para contrato assinado POUCO ANTES
--   da 1ª mensagem (vigência e assinatura não coincidem). NÃO é teto para a frente: conversa em junho
--   que fecha matrícula com vigência em agosto (Denise, Carla, Ronaldo — 44 a 51 dias) É conversão.
--
-- EXCLUSÃO: latch HUMANO (review_result=confirmed_not_lead com review_by = pessoa real, ≠ 'SERVICE'/
-- auto) → nunca toca. O NOT_LEAD auto do gate/SERVICE NÃO bloqueia. desfecho='matriculado' posto por
-- humano NUNCA vira 'cliente' (decisão humana é terminal).
--
-- ANTI-LEAKAGE: a leitura da ESTRUTURA da Extranet vive no adapter (valinhos-contratos.js); este
-- passo lê só tabelas NORMALIZADAS (service_account/account_member/person/contact_point), agnósticas.
--
-- 'convertido' e 'cliente' gravam em stage_autoapply_log → REVERTÍVEIS card a card no Monitor (078);
-- reverter restaura o estágio anterior EXATO. ADITIVA. Kill-switch = contract_convert_mode='off'.
-- Roda no cron de cadastro (04h).
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 079_contract_convert.sql
-- ============================================================

-- (a) CONFIG por-tenant — molde bola_mode: tri-estado off/suggestion/auto.
--   'off'        = INERTE (default; nenhum tenant age até setar).
--   'suggestion' = toda decisão (convertido E cliente) vai para a FILA; nada é aplicado sozinho.
--   'auto'       = aplica sozinho. GUARDA: 'cliente' só é aplicado sozinho em lead que JÁ está fora
--                  do funil (NOT_LEAD/REVIEW_QUEUE/terminal); lead VIVO no funil vai para a fila —
--                  a máquina nunca tira sozinha da mesa um lead em conversa (molde da salvaguarda
--                  do rescue, e057bee). 'convertido' é promoção → aplica direto.
ALTER TABLE lead_manager.tenant_lead_config
  ADD COLUMN IF NOT EXISTS contract_convert_mode text NOT NULL DEFAULT 'off'
    CHECK (contract_convert_mode IN ('off','suggestion','auto'));
-- Janela de tolerância da régua de origem, por-tenant (dias). 0 = exige matrícula >= marco, sem folga.
ALTER TABLE lead_manager.tenant_lead_config
  ADD COLUMN IF NOT EXISTS contract_convert_janela_dias integer NOT NULL DEFAULT 7
    CHECK (contract_convert_janela_dias BETWEEN 0 AND 90);
-- Rollout DELIBERADO pós-revisão (não flipa Valinhos aqui). Progressão recomendada: off → suggestion → auto.
--   UPDATE lead_manager.tenant_lead_config SET contract_convert_mode='suggestion', updated_at=now()
--    WHERE tenant_id='ed731a58-62e5-45ad-acba-a5502ff39e92';

-- (b) ESTADO "CLIENTE" — desfecho novo. Por que desfecho e não status: TODO o BI já exclui
--     status IN ('NOT_LEAD','REVIEW_QUEUE') (metrics.js: funil, kanban, painel, engajamento), então
--     'cliente' = status NOT_LEAD + desfecho 'cliente' fica fora da fila e da taxa SEM refatorar 10
--     call sites. O desfecho é o que dá a SEMÂNTICA (pagante reconhecido ≠ 'nao_e_lead', que o
--     metrics.js documenta como spam/interno). stages.js ganha o estágio 'cliente' (não-coluna).
ALTER TABLE lead_manager.leads DROP CONSTRAINT IF EXISTS leads_desfecho_check;
ALTER TABLE lead_manager.leads ADD CONSTRAINT leads_desfecho_check
  CHECK (desfecho = ANY (ARRAY['matriculado','nao_matriculado_preco','nao_matriculado_horario',
    'nao_matriculado_concorrente','nao_matriculado_desistiu','nao_compareceu_aula','nao_e_lead',
    'cliente','outro']));

-- (c) stage_autoapply_log (078) passa a aceitar source='contract_match' — o Monitor/reverter é
--     genérico sobre essa tabela, então a reversão card-a-card (convertido E cliente) sai de graça.
ALTER TABLE lead_manager.stage_autoapply_log
  DROP CONSTRAINT IF EXISTS stage_autoapply_log_source_check;
ALTER TABLE lead_manager.stage_autoapply_log
  ADD CONSTRAINT stage_autoapply_log_source_check
    CHECK (source IN ('event','backfill','contract_match'));

-- (d) FILA "confirmar matrícula / marcar cliente" — 1 linha por lead×contrato candidato.
--     decisao: o que a régua de ORIGEM concluiu ('convertido' | 'cliente') — a recepção confirma ou
--              dispensa vendo as DUAS DATAS lado a lado (marco_lead vs matricula_primeira).
--     status:  pending (aguarda 1 clique) | confirmed (aplicado) | dismissed (recepção descartou).
--     reason:  papel do vínculo ('aluno' = é o beneficiário | 'responsavel' = paga por outro).
CREATE TABLE IF NOT EXISTS lead_manager.contract_match_pending (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  lead_id               uuid NOT NULL REFERENCES lead_manager.leads(id) ON DELETE CASCADE,
  account_id            uuid NOT NULL REFERENCES lead_manager.service_account(id) ON DELETE CASCADE,
  decisao               text NOT NULL DEFAULT 'convertido' CHECK (decisao IN ('convertido','cliente')),
  marco_lead            date,               -- 1ª MENSAGEM da conversa (ou created_at, se não há conversa)
  matricula_primeira    date,               -- MENOR ini_vigencia entre TODOS os contratos da pessoa
  contract_ini_vigencia date,               -- data que vira desfecho_em ao confirmar
  matched_phone         text,
  contract_names        text,               -- nomes do contrato (aluno/pagador) p/ a recepção conferir
  reason                text NOT NULL CHECK (reason IN ('aluno','responsavel')),
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','dismissed')),
  resolved_at           timestamptz,
  resolved_by           text,
  autoapply_log_id      uuid REFERENCES lead_manager.stage_autoapply_log(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, lead_id, account_id)   -- idempotente: re-rodar o cron não duplica a fila
);
ALTER TABLE lead_manager.contract_match_pending ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.contract_match_pending;
CREATE POLICY tenant_isolation ON lead_manager.contract_match_pending
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON lead_manager.contract_match_pending TO lead_manager_user;
CREATE INDEX IF NOT EXISTS idx_contract_match_pending_tenant_status
  ON lead_manager.contract_match_pending (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contract_match_pending_lead
  ON lead_manager.contract_match_pending (tenant_id, lead_id);

-- NB (dívida coberta): a UNIQUE é por lead×CONTA, então um 'dismissed' só silencia AQUELE contrato —
-- e renovação cria service_account NOVA (Vanessa Garcia tem 5, Monica VR tem 6). Quem impede o
-- re-enfileiramento eterno do mesmo veterano é a marca NO LEAD: desfecho='cliente' sai do universo
-- elegível (contractConvert.eligibleLeads). Por isso o estado "cliente" é campo do lead, não da fila.

-- ROLLBACK:
--   DROP TABLE IF EXISTS lead_manager.contract_match_pending;
--   UPDATE lead_manager.leads SET desfecho=NULL, desfecho_em=NULL WHERE desfecho='cliente';  -- (ou card a card no Monitor)
--   ALTER TABLE lead_manager.leads DROP CONSTRAINT IF EXISTS leads_desfecho_check;
--   ALTER TABLE lead_manager.leads ADD CONSTRAINT leads_desfecho_check CHECK (desfecho = ANY (ARRAY[
--     'matriculado','nao_matriculado_preco','nao_matriculado_horario','nao_matriculado_concorrente',
--     'nao_matriculado_desistiu','nao_compareceu_aula','nao_e_lead','outro']));
--   ALTER TABLE lead_manager.stage_autoapply_log DROP CONSTRAINT IF EXISTS stage_autoapply_log_source_check;
--   ALTER TABLE lead_manager.stage_autoapply_log ADD CONSTRAINT stage_autoapply_log_source_check
--     CHECK (source IN ('event','backfill'));
--   ALTER TABLE lead_manager.tenant_lead_config DROP COLUMN contract_convert_janela_dias;
--   ALTER TABLE lead_manager.tenant_lead_config DROP COLUMN contract_convert_mode;
