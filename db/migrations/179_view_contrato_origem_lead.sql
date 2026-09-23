-- ============================================================================
-- 179_view_contrato_origem_lead.sql — DE-PARA contrato ↔ lead, pedido pelo ADR-BI (23/09/2026).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 179_....sql
--
-- POR QUÊ
--   O Leo mandou alinhar com o ADR-BI antes de o LM fechar card por contrato ("avalia com a sessão
--   de ADR-BI porque lá fazemos essa contabilidade"). A resposta deles: os dois números VÃO
--   divergir, por três motivos INDEPENDENTES e todos legítimos:
--     1. UNIDADE  — o BI conta por CONTRATO ("financeiramente o que importa é o contrato");
--                   o funil do LM conta por LEAD. Um lead pode gerar dois contratos no mesmo dia
--                   (Viviane → Gabriel/Violão + Giovanna/Canto): 2 para o BI, 1 conversão aqui.
--     2. DATA     — o painel agrupa por `mesReferencia` (mês do arquivo da Extranet); o LM usa
--                   `ini_vigencia` (a data do fato). Medido pelo BI: 90% caem no mesmo mês, ~8% não.
--     3. UNIVERSO — o BI conta matrícula de quem NUNCA foi lead, e conta 2º curso de aluno atual
--                   como matrícula (13% das deles). O funil do LM não conta nem uma coisa nem outra.
--
--   Esta view é o que o BI pediu para conciliar: "matrículas do BI × quantas vieram de lead do LM",
--   mês a mês. Orientada a CONTRATO (a unidade DELES), com o lead de origem quando existir.
--
-- ⚠ NOMENCLATURA, alerta do BI que vale mais que a view: o funil do LM rotula este número como
--   "matriculas" (metrics.js), o MESMO nome que o BI usa para outra contagem. Enquanto os dois se
--   chamarem igual, vão brigar na tela do Leo. O nome correto do lado do LM é LEADS CONVERTIDOS.
--   Correção do rótulo é do dashboard (outro repo) — registrado como pendência.
--
-- ORIGEM DO LEAD: casamento por br_phone_key (nunca por nome), e só conta o lead cujo primeiro
-- contato é ANTERIOR ao início do contrato — a mesma régua da migr 178. Contrato sem lead anterior
-- fica com lead_id NULL, que é exatamente o que o BI quer ver (matrícula que não veio do funil).
--
-- Aditiva: só cria view. Sem efeito em comportamento. RLS: a view herda as policies das tabelas
-- base, então quem consulta precisa estar no contexto do tenant (app.current_tenant) — ver a
-- memória "RLS no bi_raw + withTenantBi". Rodando como `postgres` (superuser) a RLS é bypassada.
-- ============================================================================

CREATE OR REPLACE VIEW lead_manager.v_contrato_origem_lead AS
SELECT sa.tenant_id,
       er.external_id                        AS contrato_extranet_id,
       sa.ini_vigencia,
       to_char(sa.ini_vigencia, 'YYYY-MM')   AS mes_ini_vigencia,
       sa.servico_label                      AS curso,
       sa.status                             AS status_contrato,
       pb.display_name                       AS beneficiario,
       lead.id                               AS lead_id,
       lead.name                             AS lead_nome,
       lead.origem                           AS lead_origem,
       lead.created_at                       AS lead_criado_em,
       lead.desfecho                         AS lead_desfecho,
       lead.desfecho_em                      AS card_fechado_em,
       lead.desfecho_source                  AS fonte_do_fechamento,
       (lead.id IS NOT NULL)                 AS veio_de_lead
  FROM lead_manager.service_account sa
  JOIN lead_manager.external_ref er
       ON er.entity_id = sa.id AND er.entity_kind = 'account'
      AND er.external_type = 'contrato' AND er.source = 'extranet'
  LEFT JOIN lead_manager.account_member amb
       ON amb.account_id = sa.id AND amb.bond = 'beneficiario'
  LEFT JOIN lead_manager.person pb ON pb.id = amb.person_id
  LEFT JOIN LATERAL (
      -- o lead que ORIGINOU este contrato: mesmo telefone (chave canônica) e primeiro contato
      -- ANTERIOR ao início da vigência. Mais de um casando → o mais antigo (o que abriu a jornada).
      SELECT l.id, l.name, l.origem, l.created_at, l.desfecho, l.desfecho_em, l.desfecho_source
        FROM lead_manager.leads l
        JOIN lead_manager.contact_point cp
             ON cp.kind = 'phone'
            AND lead_manager.br_phone_key(cp.value_raw) = lead_manager.br_phone_key(l.phone)
        JOIN lead_manager.account_member am2 ON am2.person_id = cp.person_id AND am2.account_id = sa.id
       WHERE l.tenant_id = sa.tenant_id
         AND l.created_at::date <= sa.ini_vigencia
       ORDER BY l.created_at
       LIMIT 1
  ) lead ON true
 WHERE sa.fonte_ausente_em IS NULL;

COMMENT ON VIEW lead_manager.v_contrato_origem_lead IS
  'DE-PARA contrato x lead para conciliacao com o ADR-BI (23/09/2026). Orientada a CONTRATO (a unidade do BI); lead_id NULL = matricula que nao veio do funil. Casamento por br_phone_key, lead anterior ao inicio da vigencia. O funil do LM conta LEADS CONVERTIDOS, nunca matriculas -- nomes iguais brigam na tela.';

GRANT SELECT ON lead_manager.v_contrato_origem_lead TO lead_manager_user;

-- ---- VERIFICAÇÃO -----------------------------------------------------------------------------
--   SELECT mes_ini_vigencia, count(*) AS contratos,
--          count(*) FILTER (WHERE veio_de_lead) AS vieram_de_lead
--     FROM lead_manager.v_contrato_origem_lead
--    WHERE tenant_id = '<tenant>' GROUP BY 1 ORDER BY 1;
--
-- ---- ROLLBACK --------------------------------------------------------------------------------
--   DROP VIEW IF EXISTS lead_manager.v_contrato_origem_lead;
