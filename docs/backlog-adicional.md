# Backlog adicional — derivado dos ADR-003 e ADR-004

> Itens **abertos pelos ADRs** (ADR-003: classificação/triagem/convivência;
> ADR-004: roles, trial e modelo comercial SaaS). Não fazem parte do escopo
> original das epics E6/E7; registrados aqui para não perdermos o rastro. IDs
> marcados como *(proposto)* ainda precisam de triagem/priorização formal.

## Stories de implementação — ADR-003 (triagem e convivência)

| ID (proposto) | Story | Origem (ADR-003) | Prioridade | Notas |
|---|---|---|---|---|
| **E8-01** | Tabela `known_contacts` por tenant (RLS) + CRUD admin | Decisão 2 (A+C) | Alta | Portão 0 do funil; bloqueia o risco crítico de falso positivo. Schema esboçado no ADR §4. |
| **E8-02** | Job de sync periódico da extranet/CRM → alunos matriculados em `known_contacts` | Decisão 2 (A) | Alta | **Concreto:** job periódico (ex.: diário) que busca alunos ativos na **extranet da Academia do Rock via Playwright** (reusar o scraper do Scheduler — `lib/agenda.js`/extranet) e popula `known_contacts` com `type='STUDENT'`, `source='EXTRANET_SYNC'` (a coluna `type` ∈ STAFF/STUDENT/SUPPLIER/OTHER já prevê isso). **Ativa o Portão 0 do funil com dados reais** — alunos atuais deixam de ser tratados como leads. Mitiga staleness; definir frequência. Depende de E8-01. Dependência externa: credenciais/sessão da extranet. |
| **E8-03** | Classificador leve (Gemini Flash) com prompt de triagem curto + saída estruturada `{label, confidence, reason}` | Decisão 1 (cascata B→A) | Alta | Portão 1. Threshold inicial conservador (alto). |
| **E8-04** | Métricas de precisão/recall do classificador + instrumentação de decisão | Decisão 1 e 4 | Alta | Pré-requisito para graduar segmentos do modo observação → automático. |
| **E8-05** | Fila de aprovação + console da recepcionista (aprovar/editar antes do 1º envio) | Decisão 4 (A) | Alta | Habilita o **go-live em modo observação total**. |
| **E8-06** | Atribuição de proveniência (deep links `wa.me`/UTM, origem de campanha) | Decisão 4 (C) | Média | Dependência externa: instrumentação no **Marketing**. Habilita caminho automático. |
| **E8-07** | Lock de *ownership* de conversa (`conversation_owner`: lead_manager \| scheduler) | Decisão 3 | Média | Garante respondedor único na borda; rede de segurança sobre domínios disjuntos. |
| **E8-08** | Fan-out de webhook / config de múltiplos webhooks no provider (LM + Scheduler) | Decisão 3 | Média | Operacional/deploy. Dispatcher stateless OU multi-webhook nativo do provider. |
| **E8-09** | Abstração `ChannelAdapter` (`parseInbound`/`sendOutbound`) sobre o `normalizeMessage` atual | Decisão 5 | Baixa | Abstração fina, validada só com WhatsApp no MVP. Sem conectores FB/IG/Google. |

## Stories de implementação — ADR-004 (modelo comercial SaaS)

| ID (proposto) | Story | Origem (ADR-004) | Prioridade | Notas |
|---|---|---|---|---|
| **E9-01** | `tenant_members(user, tenant, role)` + middleware RBAC `requireTenantRole` + migração dos papéis legados do Scheduler (`admin/recepcao/visualizador`) | Decisão 1 | Alta | Papel por `(user, tenant)`; `is_platform_admin` global. NextAuth como IdP único. |
| **E9-02** | `SubscriptionService` (máquina de estado por feature) + `subscription_events` (append-only) + colunas Stripe **nullable** (`stripe_customer_id`, `stripe_subscription_id`, `stripe_price_id`) | Decisões 3 e 5 | Alta | Manual e (futuro) webhook Stripe chamam a MESMA API idempotente (`source ∈ MANUAL\|STRIPE`). |
| **E9-03** | Cron diário de expiração de trial + **grace period** + notificações **apenas ao Leo** (D-3/D-1/vencimento) | Decisão 2 | Alta | Reusa o agendador do Scheduler. Tudo em UTC; "dia" no fuso do negócio. TENANT_ADMIN adiado (DP-002). |
| **E9-04** | Painel comercial `/admin`: listar tenants+status por feature, criar tenant+trial, converter→pago, suspender/reativar, `default_trial_days`, métricas (trials ativos, conversão, MRR estimado) | Decisão 3 | Alta | Métricas **iterando por tenant** no MVP (sem BYPASSRLS — DP-001). `platform_settings`/`feature_prices`. |
| **E9-05** | Gating de assinatura no **caminho quente** do webhook (LM só processa se a feature `LEAD_MANAGER` estiver `TRIALING`/`ACTIVE`/`GRACE`) | Decisões 2 e 4 | Alta | Conecta com ADR-003; `lead_manager_active` passa a derivar do status da assinatura. |
| **E9-06** | Separar namespaces `/admin/*` (plataforma) vs `/tenant/:id/*` (self-service) e ampliar `PATCH …/lead-config` (E7-01) para `TENANT_ADMIN` do próprio tenant | Decisão 4 | Média | Impersonation do `PLATFORM_ADMIN` segue válida; autorização escopada por membership. |

## Stories de implementação — E3 (console de leads) / ADR-006 / ADR-007

| ID (proposto) | Story | Origem | Prioridade | Notas |
|---|---|---|---|---|
| **E10-01** | **Origem do lead (source tracking)**: campo de origem específica — `whatsapp_organic`, `whatsapp_ad`, `instagram`, `facebook`, `landing_page` — com **badge de origem no card** do lead (tela da recepção) e **filtro por origem** na listagem | E3 (console) · ADR-007 (multicanal) · ADR-003 Decisão 4 | Média | Hoje `conversations.channel` é só `'whatsapp'`. Modelar a origem no lead (coluna `source`, ou derivar de `channel` + sinais de entrada). **Distinguir orgânico × anúncio depende de proveniência** (deep links `wa.me`/UTM — **E8-06**, dependência de Marketing). UI: reusar `.badge` no card e o mesmo padrão do **filtro por status** já existente no E3 (`recep-leads.js`). Origens não-WhatsApp dependem do **ADR-007** (webhook por canal). |
| **E10-02** | **Modo automático por tipo de ação (implementa ADR-006)**: toggle por tenant **MANUAL → SEMI → AUTO** por tipo de ação, configurável pela recepção/gestor no dashboard | **ADR-006** (centro de controle de automação) | Média | Tabela `tenant_automation_settings(tenant_id, action, level)` (RLS) ou JSONB; endpoint self-service `/tenant/:id/automacao` (`TENANT_ADMIN`, namespace do **E9-06**). **Default permanente `SEMI`** (aprovação manual) — nada de envio automático ao cliente até o tenant **ativar `AUTO` explicitamente** e a recepção estar onboarded (guardrail). `AUTO` exige: caminho de **envio real** (ainda não implementado), **ownership** (E8-07) e **gating** de assinatura (E9-05). Auditar mudanças de nível e todo envio `AUTO`. |

## Épico E11 — Importação automática de leads históricos (Fase 2)

> Origem: tela de **Reativação** do E3 (`/f/:slug/leads/historico`). A separação
> ativo × histórico e o seletor de período já existem; falta a **aquisição** dos
> contatos. **Prioridade: Fase 2** (depois do go-live do console em modo
> observação). Bloqueios de infra conhecidos — registrados nas notas. Toda
> importação cria leads `status='COLD'` + `origin=HISTORICAL_*`, **cruzando com
> `known_contacts` para ignorar quem já é aluno ativo** (Portão 0).

| ID (proposto) | Story | Origem | Prioridade | Notas |
|---|---|---|---|---|
| **E11-01** | Importar **histórico do WhatsApp** (instância Evolution do tenant) → leads `COLD` `origin=HISTORICAL_WHATSAPP` | E3/Reativação | **Fase 2** | **Bloqueio:** o LM não acessa a Evolution (sem URL/instância/credenciais — isso vive no Scheduler) e `lib/evolution.js` não tem wrapper de histórico (`findChats`/`findMessages`); a Evolution só retém o que recebeu conectada. Precisa: wrapper de histórico + credenciais por tenant + dedup contra `known_contacts`. |
| **E11-02** | Importar **ex-alunos da Extranet** (cancelados) → leads `COLD` `origin=EX_ALUNO` | E3/Reativação · relaciona [[E8-02]] | **Fase 2** | **Bloqueio:** não há Playwright; o cliente da Extranet (HTTP, no Scheduler) raspa **grade de aulas**, não ex-alunos. Precisa: novo scraper de ex-alunos/cancelados + credenciais + dedup contra `known_contacts`. Complementa o E8-02 (sync de alunos ATIVOS → `known_contacts`). |
| **E11-03** | Importar **planilha .xlsx** (upload) → leads `COLD` `origin=PLANILHA` | E3/Reativação | **Fase 2** | **Bloqueio:** sem SheetJS na stack e sem middleware de upload (multer); `leads` não tem coluna `origin` e é do `postgres` (sem ALTER) → usar **tabela lateral** `lead_origin(lead_id, origin)` ou migration via superuser. Alternativa sem deps: importação por **CSV colado**. |

> **Infra a destravar para o E11:** acesso do LM à Evolution (ou orquestrar a
> importação pelo Scheduler, que já tem as credenciais, criando os leads via API
> do LM); scraper de ex-alunos na Extranet; deps `xlsx`/`multer`; coluna/tabela
> de origem do lead. Nenhum desses existe hoje — por isso é Fase 2.

## ADRs futuros (decisões adiadas explicitamente)

| ID (proposto) | Tema | Origem | Notas |
|---|---|---|---|
| **ADR-006** | Contrato de *ownership* de conversa do lado do **Scheduler** | ADR-003, Decisão 3 | Hoje a precedência é aplicada só pelo LM (ele se cala). Fechar o ciclo no Scheduler. |
| **ADR-007** | **Multicanal (Instagram, Facebook, Google)** — webhook por canal, identidade não-telefônica `(canal, id externo)`, adaptador de envio por canal | ADR-003, Decisão 5 | ✍️ **Escrito como placeholder PENDENTE** em `docs/adr/ADR-007-multicanal.md`. **Absorve** a antiga reserva "identidade unificada cross-canal" (dedup de pessoa vira §2.4 do ADR-007). |
| **ADR-008** | Auditoria de *impersonation* do `PLATFORM_ADMIN` + retenção de logs | ADR-004, Decisão 4 | Formalizar trilha de auditoria antes de ampliar o uso de impersonation. |

> **ADR-005** (autenticação + identidade Scheduler↔LM) já foi escrito e aprovado
> (`docs/adr/ADR-005-autenticacao-identidade.md`) — não confundir com a numeração
> antiga, em que ADR-005 era ownership.

> Decisões pendentes de revisão com gatilho/prazo: ver `docs/decisoes-pendentes.md`
> (DP-001 `platform_reader` BYPASSRLS, DP-002 notificações ao TENANT_ADMIN).

## Dependências externas levantadas
- **Marketing:** instrumentação de proveniência (deep links/UTM) — bloqueia E8-06 e, por consequência, a graduação do caminho automático.
- **Extranet/CRM:** endpoint/credenciais para o sync de alunos — bloqueia E8-02.
- **Provider WhatsApp (Z-API/Evolution):** suporte a múltiplos webhooks ou necessidade do fan-out — E8-08.
- **Scheduler:** fonte dos usuários/papéis legados a migrar — E9-01; agendador reutilizável — E9-03.

---
_Gerado a partir dos ADR-003 e ADR-004 (2026-06-01). Atualizar conforme as stories forem trianguladas no planejamento._
