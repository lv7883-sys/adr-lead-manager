# ADR-005 — Autenticação e identidade (Scheduler ↔ Lead Manager)

- **Status:** Aprovado
- **Data:** 2026-06-01
- **Autor:** ATLAS (arquitetura)
- **Relacionados:** ADR-001 (isolamento + RLS), ADR-004 (roles, assinaturas — assumiu NextAuth), E7-01 (JWT + JWT_SECRET), E9-01 (RBAC, `lead_manager.users`, `requireTenantRole`)
- **Decisores:** Plataforma (Leo) / Produto / Engenharia
- **Emenda:** corrige a premissa de IdP do **ADR-004 §1a** (NextAuth.js). Ver §6.

---

## 1. Contexto

O ADR-004 assumiu **NextAuth.js** como provedor de identidade. A inspeção do
banco durante a E9-01 desmentiu isso: o **Scheduler usa autenticação própria** —
`app.usuario` (com `senha_hash`, ids inteiros, `papel ∈ admin|gerente|
recepcionista`) e sessões em `app.sessao` (ids de sessão opacos, **não** JWT).
**Não há NextAuth.**

O **Lead Manager** já tem o seu próprio esquema de auth: **JWT** verificado com
`JWT_SECRET` (E7-01), e identidade própria em `lead_manager.users` +
`tenant_members` (E9-01), totalmente isolada do Scheduler (ADR-001).

O dashboard de leads será servido **dentro do mesmo Next.js do Scheduler**
(`agenda.leovecchi.com/leads`), onde o usuário **já está logado** via sessão do
Scheduler. Precisamos decidir como essa identidade atravessa a fronteira para o
Lead Manager **sem** acoplar os schemas nem exigir segundo login.

> **Tese central:** o Scheduler é o **IdP de fato** (dono do login e da sessão);
> o Lead Manager é um **Resource/Relying Party** que confia no Scheduler por uma
> **troca de credencial** explícita e auditável — nunca lendo `app.sessao` nem
> compartilhando estado de sessão. Identidade é **provisionada sob demanda** no
> Lead Manager, correlacionada pelo **id estável** do usuário do Scheduler.

---

## 2. Decisão 1 — Identidade unificada

**Pergunta:** como um usuário de `app.usuario` (Scheduler) vira um usuário de
`lead_manager.users` (Lead Manager)?

### Opções
- **(A)** Vínculo por **email** (`lead_manager.users.email = app.usuario.email`).
- **(B)** Login **separado** no Lead Manager (identidade distinta).
- **(C)** **SSO futuro**: por ora dois logins, com plano de unificação documentado.

### Trade-offs
- **(A) email** é humano e simples, mas **frágil**: `app.usuario` permite usuário
  **só com telefone** (constraint `usuario_login_chk`: email **ou** telefone), o
  email é **mutável** e pode colidir. Não é chave estável.
- **(B)** dobra cadastro e senha — péssima UX e fonte de divergência de dados.
- **(C)** sozinha empurra o problema; mas a direção (uma identidade, um login) é
  a correta a longo prazo.

### ✅ Decisão
**Provisionamento sob demanda, correlacionado pelo ID estável do Scheduler
(não pelo email), com o caminho de SSO de (C) como destino.** Concretamente:
- `lead_manager.users` ganha `scheduler_user_id int UNIQUE NULL` (sem FK
  cross-schema — preserva o isolamento ADR-001) como **chave canônica** de
  correlação; `email` fica como **atributo** (e dica de merge), não como chave.
- Na primeira vez que um usuário do Scheduler acessa o Lead Manager, a troca de
  token (Decisão 2) **provisiona** (upsert idempotente por `scheduler_user_id`)
  a linha em `lead_manager.users`.
- Não há segundo cadastro (rejeitamos B); o email isolado (A) é insuficiente
  como chave por causa de usuários telefone-only e da mutabilidade.

**Justificativa:** o id do Scheduler é estável e sempre presente; o email não. A
correlação por id torna o provisionamento determinístico e idempotente.

### Riscos residuais
- **Merge retroativo:** se um usuário existir no LM por email antes de termos o
  `scheduler_user_id`, é preciso reconciliar — mitigado provisionando sempre via
  troca (que carrega o id) e tratando email como secundário.
- `scheduler_user_id` é uma referência *soft* (sem FK): exclusão no Scheduler não
  propaga — aceitável; limpeza é processo operacional.

---

## 3. Decisão 2 — Sessão e token (MVP)

**Pergunta:** como o Lead Manager autentica requests no MVP?

### Opções
- **(A)** Manter **JWT próprio** (E7-01) — login separado no Lead Manager.
- **(B)** Lead Manager aceita o **token de sessão do Scheduler** (`app.sessao`).
- **(C)** Endpoint de **troca**: sessão do Scheduler → JWT do Lead Manager.

### Trade-offs
- **(A)** reusa o que já existe, mas implica login separado (mesma dor do 1-B).
- **(B)** **acopla** o LM ao schema do Scheduler: `app.sessao` é id opaco; o LM
  teria de **ler `app.sessao`** (cross-schema), violando o isolamento do ADR-001
  e criando dependência de runtime entre os sistemas. **Rejeitada.**
- **(C)** mantém o LM **stateless** (só verifica o **seu** JWT, reusando E7-01),
  sem ler estado do Scheduler; a troca é o único ponto de confiança, explícito e
  auditável.

### ✅ Decisão
**(C) — endpoint de troca no Lead Manager.** Fluxo:
1. O **servidor Next.js** (que tem a sessão válida do Scheduler) emite uma
   **asserção de troca** de vida curta: um JWT assinado com o `JWT_SECRET`
   compartilhado, com claims `{ scheduler_user_id, email, papel, iss:"scheduler-web",
   aud:"lead-manager-exchange", exp:+60s }`.
2. Chama `POST /auth/session-exchange` no Lead Manager (server-to-server).
3. O LM **verifica** a asserção (HMAC + `aud`/`iss`/`exp`), **provisiona** o
   `lead_manager.users` (upsert por `scheduler_user_id`) e **emite o JWT de
   acesso do LM** (`sub = lead_manager.users.id`, `iss/aud = lead-manager`, TTL
   curto, ex.: 30–60 min).
4. Requests subsequentes ao LM levam esse JWT; o backend já o valida (E7-01) e
   resolve `is_platform_admin`/papel **no banco** (E9-01) — o token **não**
   carrega autorização, só identidade.

**Justificativa:** o LM permanece desacoplado e stateless; a confiança fica num
único ponto verificável; a autorização continua sendo decidida no LM (DB), não
herdada do Scheduler.

### Riscos residuais
- **`JWT_SECRET` compartilhado** = raio de explosão único; rotação precisa ser
  coordenada entre Scheduler-web e LM. (Ver §7; evolução: chaves assimétricas.)
- A asserção precisa de **TTL curto + `aud`/`iss`** para não virar token de longa
  duração forjável.

---

## 4. Decisão 3 — Frontend unificado

**Pergunta:** o dashboard fica no mesmo Next.js (`agenda.leovecchi.com/leads`).
Como o frontend autentica?

### Opções
- **(A)** Sessão do Scheduler já logada → **troca por JWT do LM** via endpoint.
- **(B)** **Login duplo** (usuário loga separado no LM).
- **(C)** Compartilhar `JWT_SECRET` e **aceitar o token do Scheduler diretamente**.

### Trade-offs
- **(C)** não se sustenta: o "token do Scheduler" é **`app.sessao` (id opaco)**,
  não um JWT assinado com `JWT_SECRET`. Aceitá-lo "diretamente" exigiria o
  Scheduler emitir JWT — o que ele não faz hoje. Inviável como descrito.
- **(B)** dobra login no mesmo domínio onde o usuário já está logado — UX ruim.
- **(A)** é a consequência natural da Decisão 2-C: o servidor Next.js troca a
  sessão por um JWT do LM.

### ✅ Decisão
**(A) — troca server-side, token do LM nunca exposto ao browser como bearer
manipulável.** No carregamento de `/leads`, o **servidor** Next.js faz a troca
(Decisão 2) e então:
- **preferencial:** atua como **BFF/proxy** — as chamadas do browser vão ao
  Next.js, que repassa ao LM anexando o JWT server-side (o JWT do LM nunca vai
  ao browser); **ou**
- alternativa: entrega o JWT do LM ao browser em **cookie `httpOnly`** de vida
  curta (evita roubo via XSS).

Sem segundo login (rejeitamos B); sem aceitar `app.sessao` no LM (rejeitamos C).

### Riscos residuais
- BFF/proxy adiciona um hop no Next.js (custo baixo, simplifica segurança).
- Renovação: o JWT do LM expira; o BFF re-troca de forma transparente enquanto a
  sessão do Scheduler estiver válida.

---

## 5. Decisão 4 — PLATFORM_ADMIN (Leo)

**Pergunta:** Leo não existe em `app.usuario` como PLATFORM_ADMIN. Como ele
acessa o `/admin` no MVP?

### Opções
- **(A)** Criar Leo **manualmente** em `lead_manager.users` com `is_platform_admin=true`.
- **(B)** **Seed/bootstrap** no banco (script).
- **(C)** Variável de ambiente `PLATFORM_ADMIN_EMAIL` reconhecida pelo middleware.

### Trade-offs
- **(A)** funciona, mas é ad-hoc e não reproduzível entre ambientes.
- **(B)** reproduzível e versionado.
- **(C)** **eleva privilégio em tempo de request** a partir de env — cria uma
  **segunda fonte de verdade** de autorização (fora do `is_platform_admin` do
  DB), frágil e fácil de configurar errado. Como *gatekeeper* de authz, perigoso.

### ✅ Decisão
**(B) bootstrap idempotente, parametrizado por `PLATFORM_ADMIN_EMAIL`, mas com a
autorização permanecendo no DB.** Um passo de bootstrap (script/seed rodado no
deploy) lê `PLATFORM_ADMIN_EMAIL` e faz **upsert** de `lead_manager.users` com
`is_platform_admin=true`. Em runtime, o middleware (E9-01) continua lendo
`is_platform_admin` **do banco** — **não** consulta a env por request.
- Login do Leo: ele entra pelo Scheduler (é admin lá), a troca (Decisão 2)
  provisiona/correlaciona o `lead_manager.users`, e o bootstrap por email marca
  `is_platform_admin=true`. O poder de plataforma é um conceito **do LM**, não do
  Scheduler.

**Justificativa:** combina reprodutibilidade (B) com configurabilidade (C) sem
mover a decisão de autorização para fora do banco. Rejeitamos C puro (elevação
por env em request) e A puro (manual não reproduzível).

### Riscos residuais
- Se o email do bootstrap não casar com o email que vem na asserção de troca, o
  Leo provisiona um usuário sem a flag → mitigado correlacionando também por
  `scheduler_user_id` e tornando o bootstrap idempotente nos dois campos.
- `PLATFORM_ADMIN_EMAIL` é configuração sensível — tratar como segredo de deploy.

---

## 6. Relação com o ADR-004 (emenda)

ADR-005 **substitui a premissa de IdP** do **ADR-004 §1a** ("NextAuth como IdP
único"): o IdP real é a **auth própria do Scheduler**, e o LM confia via **troca
de token**. **O resto do ADR-004 permanece válido** — em especial a Decisão 1
(papel resolvido no servidor por `(user, tenant)`), pois o LM continua emitindo o
seu JWT e resolvendo autorização no DB; muda apenas **de onde vem a identidade**
(troca com o Scheduler, não NextAuth). Recomenda-se anotar no ADR-004 §1a um
ponteiro "ver ADR-005".

---

## 7. Consequências

**Positivas**
- Isolamento do ADR-001 preservado: o LM **não** lê `app.sessao` nem o schema
  `app`; a única ponte é uma troca verificável.
- Sem segundo login; UX de SSO "de fato" reusando a sessão já existente.
- LM continua **stateless** (só valida o próprio JWT) e com autorização **no DB**.
- Caminho de unificação (Decisão 1-C) aberto sem reescrever.

**Negativas / custos**
- Nova coluna `lead_manager.users.scheduler_user_id` + endpoint
  `/auth/session-exchange` + lógica de provisionamento idempotente.
- **Trabalho do lado do Scheduler-web** (Next.js): emitir a asserção e o
  BFF/proxy — coordenação entre os dois times/repos.
- `JWT_SECRET` compartilhado: acoplamento de segredo e rotação coordenada.
- Bootstrap de PLATFORM_ADMIN como passo de deploy.

**Backlog / próximos ADRs**
- E-story: migration `scheduler_user_id` + endpoint de troca + provisionamento.
- E-story: BFF/proxy no Next.js (`/leads`) + emissão da asserção.
- E-story: bootstrap idempotente do PLATFORM_ADMIN (`PLATFORM_ADMIN_EMAIL`).
- ADR futuro: migrar `JWT_SECRET` simétrico → **par de chaves assimétricas**
  (Scheduler assina, LM valida com a pública) para reduzir o raio de explosão.

---

## 8. Resumo das decisões

| # | Tema | Decisão | Rejeitado |
|---|------|---------|-----------|
| 1 | Identidade | Provisionamento sob demanda, **correlação por `scheduler_user_id`** (email = atributo); SSO como destino | Login separado; chave só por email |
| 2 | Token | **Endpoint de troca**: asserção do Scheduler → **JWT do LM** (LM stateless, authz no DB) | Ler `app.sessao` (acopla); login separado |
| 3 | Frontend | Sessão do Scheduler **trocada server-side** (BFF/proxy ou cookie httpOnly); sem 2º login | Login duplo; aceitar `app.sessao` direto |
| 4 | PLATFORM_ADMIN | **Bootstrap idempotente** por `PLATFORM_ADMIN_EMAIL`, mas authz **no DB** | Elevação por env em request; manual ad-hoc |

---

## Apêndice — fluxo de troca e formato dos tokens

```
Navegador (logado no Scheduler)
   │  GET agenda.leovecchi.com/leads
   ▼
Next.js (servidor, tem a sessão do Scheduler em app.sessao)
   │  1) monta asserção de troca (JWT HMAC com JWT_SECRET):
   │       { scheduler_user_id, email, papel,
   │         iss:"scheduler-web", aud:"lead-manager-exchange", exp:+60s }
   │  2) POST /auth/session-exchange   (server-to-server)
   ▼
Lead Manager  /auth/session-exchange
   │  verifica HMAC + aud/iss/exp
   │  upsert lead_manager.users por scheduler_user_id (provisiona)
   │  emite JWT de acesso do LM:
   │       { sub:<users.id>, iss:"lead-manager", aud:"lead-manager", exp:+30-60min }
   ▼
Next.js (BFF) anexa o JWT do LM nas chamadas à API do LM
   │  (token do LM não exposto ao browser, ou em cookie httpOnly)
   ▼
Lead Manager API → authenticate (verifica JWT) → requireTenantRole (DB) → handler

Autorização NUNCA vem do token: is_platform_admin e role saem do banco (E9-01).
```
