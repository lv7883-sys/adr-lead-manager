DÍVIDA — Auditoria de RLS multi-tenant (hardening)
Prioridade: ALTA · Gate: bloqueia o onboarding do 2º tenant | Origem: read-only de isolamento (2026-07-07) | Data: 2026-07-07
Por que existe
O isolamento entre tenants funciona para as tabelas no padrão (papel da app lead_manager_user sem superuser/BYPASSRLS; RLS provada empiricamente: 0 linhas sem contexto, 289 com withTenant). Mas o read-only achou 9 tabelas com tenant_id sem RLS/policy. Com um tenant só, não vaza. No dia do 2º tenant, cada uma é um vazamento cross-tenant esperando acontecer. Como o 2º tenant vem em breve, isto vira gate — resolver quase imediatamente.
Padrão a aplicar (confirmado no read-only)
ALTER TABLE <schema>.<tabela> ENABLE ROW LEVEL SECURITY;
-- FORCE só se a tabela for de POSSE do lead_manager_user (senão o dono lê sem filtro):
ALTER TABLE <schema>.<tabela> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <schema>.<tabela>
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
Procedimento POR TABELA (não é "liga RLS em tudo")
Ligar RLS cega quebra qualquer código que hoje lê a tabela sem withTenant. Então, por tabela, nesta ordem:
1.    Read-only primeiro: grep os acessos no código. Todo acesso passa por withTenant (contexto de tenant setado)? Algum caminho lê a tabela global (cross-tenant de propósito)?
2.    Confirmar tenant_id preenchido corretamente em todas as linhas (sem nulos órfãos que a policy esconderia).
3.    Se houver acesso global legítimo → decidir (a tabela é mesmo por-tenant? precisa de exceção de leitura global?). Não ligar antes de resolver.
4.    Só então ENABLE (+FORCE se posse da app) + policy.
5.    Teste: query cross-tenant retorna 0; query com withTenant retorna o esperado.
6.    Rito: migração aditiva, backup de schema antes, flag/reversível.
Inventário (9 tabelas)
Tabela    Nota    Ação
lead_manager.internal_contacts    fonte de papel "equipe"; 6 linhas visíveis sem contexto    RLS + policy (posse=postgres → sem FORCE); e o 037 já ingere dela pra tabela protegida
lead_manager.audit_log    posse da app → RLS não-forçada seria ignorada pro dono    RLS + FORCE + policy
lead_manager.classification_feedback    aprendizado dinâmico — checar se é lido global    verificar acesso → RLS + policy
lead_manager.gold_classifier_v1    pode ser modelo global — checar antes    verificar acesso → decidir
lead_manager.impersonation_audit    auditoria    RLS + policy
lead_manager.reabordagem_tentativas    por-tenant    RLS + policy
app.notification_preference    schema app = domínio do Scheduler    coordenar — não tocar tabela do Scheduler sem alinhar; adapter/scheduler não se mexe sem cuidado
lead_manager.bkp_batch_classifyconversa_20260619    backup descartável    DROP (após confirmar que é lixo)
lead_manager.bkp_tls_20260621    backup descartável    DROP (após confirmar)
Cuidados
•    app.notification_preference é do Scheduler — a regra "adapter/Scheduler não se toca sem alinhar" vale; tratar à parte, com coordenação.
•    As bkp_* provavelmente só devem ser removidas, não protegidas — confirmar que são backups mortos antes.
•    consent_records já está ENABLE+FORCE — é o exemplo bom a espelhar.
Relação
Pré-requisito de multi-tenant; adjacente ao ADR-037 (que já nasce fechado), mas fora do escopo dele — trilha própria, a rodar antes do 2º tenant.
