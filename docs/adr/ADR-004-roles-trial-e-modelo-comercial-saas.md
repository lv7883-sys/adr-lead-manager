# ADR-004 — Roles, modelo de trial e gestão comercial SaaS

- **Status:** Aprovado
- **Data:** 2026-06-01
- **Autor:** ATLAS (arquitetura)
- **Relacionados:** ADR-001 (isolamento + RLS + middleware de tenant context),
  ADR-002 (TenantSubscription, TermsAcceptance, subscription check),
  ADR-003 (funil de triagem, modo observação), E7-01 (config por tenant, JWT + role)
- **Decisores:** Plataforma (Leo) / Produto / Engenharia

---

## 1. Contexto

O produto evolui para um **SaaS multi-feature**: Leo (operador da plataforma)
vende **Scheduler** e **Lead Manager** de forma **independente** para franquias
ADR e outras empresas. Cada feature tem seu próprio ciclo: **trial gratuito**
(duração configurável, padrão 7 dias) → **cobrança por feature** (manual agora,
Stripe na Fase 3).

Isto exige formalizar quatro coisas que hoje estão implícitas ou herdadas do
Scheduler:

1. Uma **hierarquia de papéis** que separa a operação da plataforma (Leo) da
   operação de cada franquia (gestor, recepção, diretor).
2. Um **modelo de trial** com expiração automática e conversão.
3. Um **painel comercial** para Leo operar vendas/assinaturas.
4. **Isolamento por papel** que conviva com o RLS por tenant do ADR-001.
5. **Abstrações de billing** que permitam plugar o Stripe sem reescrever.

Restrições herdadas:
- **RLS por tenant** (ADR-001): o papel de aplicação (`lead_manager_user`) é
  **não-superuser** e só enxerga linhas do `app.current_tenant` corrente.
- **NextAuth.js** já é o provedor de identidade do Scheduler; o backend do Lead
  Manager valida **JWT** (E7-01) com o mesmo `JWT_SECRET`.
- Papéis legados do Scheduler: `admin`, `recepcao`, `visualizador`.

> **Tese central:** assinatura é **por (tenant, feature)**, não por tenant; e
> papéis são **por (usuário, tenant)**, não globais — exceto o `PLATFORM_ADMIN`,
> que é global e o único autorizado a cruzar a fronteira de tenant. Tudo o mais
> decorre dessas duas chaves compostas.

---

## 2. Decisão 1 — Estrutura de roles

### Papéis
| Role | Escopo | Pode fazer | Não pode |
|---|---|---|---|
| **PLATFORM_ADMIN** (Leo) | Global | Gerenciar todos os tenants, ativar/converter/suspender features, configurar trial, métricas globais, impersonar tenant | — |
| **TENANT_ADMIN** (gestor) | 1 tenant | Config do Lead Manager (E7-01), `known_contacts`, gerenciar usuários da sua unidade, ver leads/métricas, ver status da assinatura | Alterar billing, ver outros tenants |
| **RECEPCAO** | 1 tenant | Aprovar/editar/rejeitar `pending_approvals`, confirmar agendamentos, operar conversas/leads | Config, billing, gestão de usuários |
| **VISUALIZADOR** (diretor/sócio) | 1+ tenants | Somente leitura de dashboards | Qualquer escrita |

Mapeamento dos legados: `admin → TENANT_ADMIN`, `recepcao → RECEPCAO`,
`visualizador → VISUALIZADOR`; `PLATFORM_ADMIN` é novo, acima de todos.

### 1a. Relação com o NextAuth.js
**Opções:** (A) roles embutidos no JWT da sessão; (B) roles resolvidos no
servidor por request a partir do banco; (C) híbrido (token carrega identidade +
flag global; papel-por-tenant resolvido no servidor).

| | (A) tudo no token | (B) tudo no banco | (C) híbrido |
|---|---|---|---|
| Latência | Melhor | Pior (query/req) | Boa (cache curto) |
| Frescor (revogação) | Ruim (stale até expirar) | **Imediato** | Bom |
| Acoplamento | Token incha com N memberships | — | Token enxuto |

**✅ Decisão (C):** o NextAuth permanece como **IdP único**; o token de sessão
carrega `user_id` e `is_platform_admin` (flag global). O **papel por tenant** é
resolvido no servidor a partir de `tenant_members` (fonte de verdade), com cache
curto. Backend (Express) e app (Next.js) compartilham `JWT_SECRET`. A
`auth.js` (E7-01) evolui de `requireRole(role)` para `requireTenantRole(tenantId, roles)`.
**Justificativa:** mudanças de papel/suspensão valem na hora; o token não incha
com franquias; mantém um só IdP.

> **Emenda (ver ADR-005):** a premissa "NextAuth como IdP" está **incorreta** —
> o Scheduler usa autenticação própria (`senha_hash` + `app.sessao`), não
> NextAuth. O IdP de fato é o Scheduler, e a identidade entra no LM via **troca
> de token** (ADR-005). A resolução de papel no servidor (esta decisão)
> permanece válida; muda apenas a origem da identidade.

### 1b. Usuário com papéis diferentes por tenant
**✅ Decisão: sim.** Modelado por `tenant_members(user_id, tenant_id, role)`
(um papel por par). Um diretor regional é `VISUALIZADOR` em várias unidades; um
gestor é `TENANT_ADMIN` na sua. `PLATFORM_ADMIN` **não** vive nessa tabela — é a
flag global `users.is_platform_admin` (não atrelado a tenant).
**Justificativa:** o negócio é explicitamente multi-unidade; amarrar papel ao
par (usuário, tenant) é o mínimo que modela a realidade sem inventar hierarquia.

### 1c. PLATFORM_ADMIN sem violar o RLS
Esta é a decisão sensível — detalhada na **Decisão 4**. Em resumo (MVP):
*impersonation* (define `app.current_tenant` no tenant alvo) tanto para **agir
dentro de um** tenant quanto para **métricas agregadas** (somando ao iterar por
tenant). **Sem BYPASSRLS** no MVP — o papel de aplicação comum **nunca** ganha
bypass; o papel read-only `platform_reader` fica **adiado** (DP-001).

### Riscos residuais
- Resolver papel por request adiciona uma query — mitigado por cache de poucos
  segundos por (user, tenant).
- Duas fontes de identidade históricas (NextAuth no Scheduler, JWT no LM) →
  manter **um** emissor e segredo; divergência é risco de segurança.

---

## 3. Decisão 2 — Modelo de trial

Assinatura é **por feature**: `TenantSubscription(tenant_id, feature, status, …)`
com `feature ∈ {SCHEDULER, LEAD_MANAGER}` e `status ∈ {TRIALING, ACTIVE,
PAST_DUE, GRACE, EXPIRED, SUSPENDED, CANCELED}`.

### Fluxo completo
```
Leo cria tenant
  → ativa trial da feature (duração = default_trial_days ou custom)
      status=TRIALING, trial_started_at=now, valid_until=now+duração
  → (cron diário) lembretes em D-3 e D-1
  → valid_until vence:
        status=GRACE (automação gated; dashboard read-only)  [grace_days]
      → grace vence: status=EXPIRED → SUSPENDED
  → conversão manual (1 clique): status=ACTIVE, converted_at=now,
      valid_until=fim do período pago
```

### 2a. Expiração automática (cron)
**Opções de frequência:** (A) por minuto, (B) horária, (C) diária.
**✅ Decisão: cron diário** (ex.: 06:00 America/Sao_Paulo). Trials têm
granularidade de dias; rodar por minuto é desperdício.
**O que faz, exatamente, em cada execução:**
1. `TRIALING` com `valid_until` em D-3/D-1 → enfileira lembrete (idempotente por
   (subscription, marco)).
2. `TRIALING` com `valid_until < now` → transição para `GRACE`.
3. `GRACE` com fim de grace `< now` → `EXPIRED` e depois `SUSPENDED`.
4. Registra cada transição em `subscription_events` (auditoria + métricas).
> Reaproveita a infra de cron já existente no Scheduler (não criar um novo
> agendador) — ver risco de convivência no ADR-003/ADR-001.

### 2b. Quem é notificado e com qual antecedência
**✅ Decisão (MVP — ajuste aprovado):** notificar **apenas Leo** (follow-up
comercial) em **D-3, D-1 e no vencimento**. Canal: e-mail no MVP. A notificação
ao **TENANT_ADMIN** (CTA de conversão) fica **adiada para a Fase 2** (primeiro
cliente externo) — ver **DP-002** em `docs/decisoes-pendentes.md`.
**Justificativa:** no piloto (franquias ADR), o follow-up é todo do Leo; avisar o
gestor agrega pouco e adia o go-live. D-3/D-1 é o padrão que equilibra
antecedência e ruído.

### 2c. Trial expirado: suspensão imediata ou grace?
**Opções:** (A) corte imediato; (B) grace period read-only.
**✅ Decisão (B): grace period.** No vencimento, a **automação monetizada para
imediatamente** (o webhook do LM deixa de processar — gating), mas o tenant
mantém **login + leitura + CTA de conversão** por `grace_days` (padrão sugerido:
3) antes do `SUSPENDED` duro.
**Justificativa:** protege a receita (o valor pago é cortado na hora) sem queimar
a conversão; dá janela ao comercial. Corte total imediato maximiza churn sem
ganho — o que dá dinheiro (a automação) já foi cortado.

### Riscos residuais
- **Fuso/relógio:** armazenar tudo em UTC; o cron decide o "dia" no fuso do
  negócio. Bug de timezone vira expiração errada.
- **Idempotência de lembretes:** sem marco persistido, o cron duplica avisos.
- Gating precisa ser checado **no caminho quente** (webhook), não só na UI.

---

## 4. Decisão 3 — Painel de gestão comercial (Leo)

Conjunto mínimo no `/admin` (todos exigem `PLATFORM_ADMIN`):

| Capacidade | Endpoint (proposto) | Notas |
|---|---|---|
| Listar tenants + status por feature | `GET /admin/tenants` | trial ativo / pago / grace / expirado / suspenso + dias restantes |
| Criar tenant + ativar trial | `POST /admin/tenants` | duração customizável (default da plataforma) |
| Converter trial → pago | `POST /admin/tenants/:id/subscriptions/:feature/activate` | 1 clique |
| Suspender / reativar | `POST …/suspend` · `POST …/reactivate` | |
| Configurar trial padrão | `PATCH /admin/settings` | `default_trial_days` (7 → 14…) |
| Métricas comerciais | `GET /admin/metrics` | trials ativos, taxa de conversão, MRR estimado |

**Decisões de apoio:**
- **MRR estimado:** Σ assinaturas `ACTIVE` × preço da feature. Exige
  `feature_prices(feature, monthly_amount, currency)` no nível plataforma.
- **Taxa de conversão:** `converted / (converted + expired)` numa janela. Exige
  histórico confiável → tabela **append-only `subscription_events`** (a verdade
  do funil não pode depender só do `status` atual, que é mutável).
- **Default de trial:** `platform_settings` (linha única) em vez de constante no
  código — Leo muda sem deploy.

**✅ Decisão:** todas as ações comerciais passam por **um serviço de domínio de
assinatura** (ver Decisão 5), e toda transição grava em `subscription_events`.
O painel é um cliente desse serviço; nada de SQL de status espalhado em handlers.

### Riscos residuais
- MRR é **estimado** (sem Stripe não há cobrança real conciliada) — rotular como
  estimativa para não virar fonte de verdade financeira.
- Métricas agregadas no MVP são calculadas **iterando por tenant** (impersonation),
  cujo custo cresce com o nº de tenants — gatilho de revisão em **DP-001**.

---

## 5. Decisão 4 — Isolamento de dados por role

### 4a. PLATFORM_ADMIN: bypass total ou impersonation?
**Opções:** (A) papel de app com BYPASSRLS para tudo; (B) impersonation (setar
contexto do tenant); (C) híbrido — impersonation para ação por-tenant + papel
**read-only** BYPASSRLS só para agregados.

| | (A) bypass total | (B) só impersonation | (C) híbrido |
|---|---|---|---|
| Isolamento | **Fraco** (1 bug = vazamento global) | Forte | Forte |
| Métricas globais | Trivial | **Difícil** (loop por tenant) | Trivial (read-only) |
| Superfície de risco | Enorme | Mínima | **Pequena e auditável** |

**✅ Decisão (ajuste aprovado — começar SEM bypass):**
- **Ação dentro de um tenant** (config, aprovar resposta em nome de, etc.):
  *impersonation* — o middleware permite `PLATFORM_ADMIN` setar
  `app.current_tenant = :tenantAlvo` e **audita** (quem, qual tenant, quando).
  Reusa o `withTenant` do ADR-001; o papel de app continua sem bypass.
- **Leitura agregada entre tenants** (painel comercial): **iterar por tenant**
  (somar impersonando cada um), **sem** introduzir BYPASSRLS por ora. Aceitável
  no volume do piloto (poucos tenants).
- O papel de banco read-only `platform_reader` (BYPASSRLS) fica **adiado** como
  decisão pendente **DP-001** (`docs/decisoes-pendentes.md`): revisitar quando o
  nº de tenants passar de ~20 ou as métricas globais demorarem > 2s.
**Justificativa:** mantém o isolamento máximo (nenhum caminho cruza tenants sem
contexto) e adia a única superfície com poder perigoso até haver dor real de
performance. Bypass total (A) é inaceitável; o híbrido com `platform_reader`
fica pré-desenhado, mas não ativado.

### 4b. Matriz de acesso TENANT_ADMIN × RECEPCAO × VISUALIZADOR
| Recurso | TENANT_ADMIN | RECEPCAO | VISUALIZADOR |
|---|---|---|---|
| Config Lead Manager (E7-01) | ✅ (seu tenant) | ❌ | ❌ |
| `known_contacts` CRUD | ✅ | ❌ | ❌ |
| Gerenciar usuários da unidade | ✅ | ❌ | ❌ |
| `pending_approvals` aprovar/editar/rejeitar | ✅ | ✅ | ❌ |
| Confirmar agendamentos | ✅ | ✅ | ❌ |
| Ver leads / conversas | ✅ | ✅ | ✅ (leitura) |
| Dashboards / métricas | ✅ | parcial | ✅ (leitura) |
| Status da assinatura (ler) | ✅ | ❌ | ❌ |
| Billing (converter/suspender) | ❌ (só Leo) | ❌ | ❌ |

> Consequência sobre E7-01: hoje `PATCH /admin/tenants/:id/lead-config` exige
> `PLATFORM_ADMIN`. ADR-004 amplia para **`TENANT_ADMIN` do próprio tenant**
> (autorização escopada por membership), mantendo `PLATFORM_ADMIN` por
> impersonation. Sugerido separar namespaces: `/admin/*` (plataforma) vs
> `/tenant/:id/*` (self-service da unidade).

### 4c. Integração com o middleware de tenant context (ADR-001-B)
**✅ Decisão — pipeline único de request:**
```
1. authenticate (NextAuth JWT)        → user_id, is_platform_admin
2. resolveTenant (URL/subdomínio)     → tenantId alvo
3. authorize:
     - is_platform_admin → permitido (marca impersonation, audita)
     - senão → role = tenant_members(user_id, tenantId); exige role ∈ permitidos
4. setTenantContext  → SET LOCAL app.current_tenant = tenantId   (withTenant)
5. handler
```
O middleware do ADR-001-B passa a **derivar o contexto da membership** (ou da
impersonation do PLATFORM_ADMIN), não de um header confiável. No MVP, endpoints
de plataforma (agregados) também passam pelo passo 4, **iterando o contexto por
tenant** — sem pool com bypass.

### Riscos residuais
- **Impersonation precisa de auditoria completa** — sem log, vira acesso opaco.
- Métricas por iteração de tenant não escalam indefinidamente — se/quando ativar
  o `platform_reader` (BYPASSRLS) via **DP-001**, isolá-lo num módulo/pool com
  nome explícito e revisão obrigatória, pois qualquer uso indevido vaza.
- Resolução de papel por request: caching com TTL curto para não pesar.

---

## 6. Decisão 5 — Evolução para Stripe (Fase 3)

O objetivo é que o **manual de hoje** e o **Stripe de amanhã** sejam o **mesmo
fluxo de estado**, com Stripe como "mais um chamador".

### 5a/5b. Campos de Stripe agora?
**✅ Decisão: adicionar agora, opcionais (nullable).**
- `tenants.stripe_customer_id` (nullable agora; obrigatório na Fase 3).
- `TenantSubscription.stripe_subscription_id` + `stripe_price_id` (nullable).
**Justificativa:** colunas nullable são baratas e evitam uma migração dolorosa
sob pressão na Fase 3; ficam inertes até o Stripe entrar.

### 5c. "Converter trial → pago" manual = mesma interface do webhook?
**Opções:** (A) handler manual com SQL próprio + reescrever na Fase 3; (B) um
**serviço de domínio** único que ambos (admin manual e webhook Stripe) chamam.

**✅ Decisão (B): serviço de assinatura como máquina de estado, billing-agnóstico.**
Uma única API de domínio:
```
SubscriptionService.activate({ tenantId, feature, source, externalRef?, actor, idempotencyKey })
SubscriptionService.startTrial({ tenantId, feature, days, actor })
SubscriptionService.suspend / reactivate / cancel / expire (...)
```
- `source ∈ {MANUAL, STRIPE}`; a ação do painel chama com `MANUAL`, o webhook
  Stripe chama com `STRIPE` + `stripe_subscription_id`.
- **Idempotência de primeira classe** (`idempotencyKey`) — exigência do webhook,
  inofensiva no manual — desenhada **agora** para o Stripe não exigir refactor.
- Toda transição grava `subscription_events` (source, actor, externalRef).
**Justificativa:** a diferença entre manual e Stripe é só *quem chama* e se há
IDs externos. Encapsular a transição num serviço idempotente torna o Stripe um
adaptador fino — exatamente o que "migrar sem reescrever" exige.

### Riscos residuais
- **Conciliação manual** até a Fase 3: status `ACTIVE` no banco não garante
  pagamento real — processo operacional, não técnico.
- Webhooks Stripe são **at-least-once e fora de ordem** → a idempotência e a
  máquina de estado precisam tolerar reentrega/atraso desde já.
- Preço da feature vive em dois lugares na Fase 3 (nosso `feature_prices` e o
  Stripe Price) → definir o Stripe como fonte de verdade quando entrar.

---

## 7. Consequências

**Positivas**
- Papéis e assinaturas modelados por chave composta correta ((user,tenant) e
  (tenant,feature)); nada de gambiarra global.
- RLS do ADR-001 preservado: poder cross-tenant confinado a impersonation
  auditada (sem BYPASSRLS no MVP; `platform_reader` adiado — DP-001).
- Trial com expiração, grace e métricas reais (events append-only).
- Caminho para Stripe sem reescrita (serviço idempotente + colunas nullable).

**Negativas / custos**
- Novas tabelas: `tenant_members`, `subscription_events`, `platform_settings`,
  `feature_prices` (+ colunas Stripe). Migração dos usuários legados do Scheduler.
- Métricas globais por iteração de tenant no MVP (custo de performance que cresce
  com o nº de tenants — gatilho de revisão em DP-001).
- `auth.js` evolui para autorização por (tenant, role); middleware de contexto
  passa a derivar de membership/impersonation.
- Gating de assinatura precisa entrar no **caminho quente** do webhook (ADR-003).

**Backlog / próximos ADRs**
- **ADR-008**: contrato de **auditoria de impersonation** e retenção de logs.
- E-stories: `tenant_members` + RBAC middleware; SubscriptionService + máquina de
  estado; cron de expiração + notificações; painel comercial `/admin`; gating de
  feature no webhook; migração de papéis legados.

---

## 8. Resumo das decisões
| # | Tema | Decisão | Rejeitado |
|---|------|---------|-----------|
| 1 | Roles | 4 papéis; `PLATFORM_ADMIN` global, demais por `(user,tenant)`; NextAuth IdP + papel resolvido no servidor (híbrido) | Roles 100% no token; role global única |
| 2 | Trial | Por feature; cron **diário** (D-3/D-1/vencimento, **apenas Leo** no MVP — DP-002); **grace period** read-only com automação gated na hora | Corte imediato; cron por minuto |
| 3 | Painel Leo | Endpoints `/admin/*` via **serviço de assinatura**; métricas de `subscription_events`; `platform_settings`/`feature_prices` | SQL de status espalhado nos handlers |
| 4 | Isolamento | Impersonation auditada (ação por-tenant) + **agregados iterando por tenant, sem BYPASSRLS** no MVP (`platform_reader` adiado — DP-001) | Bypass total; ativar `platform_reader` agora |
| 5 | Stripe | Colunas Stripe **nullable agora**; "converter" manual e webhook chamam o **mesmo SubscriptionService idempotente** | Handler manual descartável |

---

## Apêndice — esboço de modelo de dados (a detalhar nas E-stories)
```
users (NextAuth)                 + is_platform_admin boolean
tenant_members(user_id, tenant_id, role)            UNIQUE(user_id, tenant_id)
tenants                          + stripe_customer_id text NULL
tenant_subscriptions(tenant_id, feature, status, trial_started_at,
    valid_until, grace_until, converted_at, canceled_at,
    stripe_subscription_id NULL, stripe_price_id NULL)  UNIQUE(tenant_id, feature)
subscription_events(id, tenant_id, feature, type, source, actor,
    external_ref, idempotency_key, metadata jsonb, created_at)   -- append-only
platform_settings(default_trial_days, grace_days, ...)           -- linha única
feature_prices(feature, monthly_amount, currency)
-- papel de banco platform_reader (BYPASSRLS, read-only): ADIADO — ver DP-001
```
