# Onboarding de Página Meta por-cliente — Item 2 (BUILD)

> **Autor:** BRIDGE (Integrações / FORGE) · **Branch:** `feat/onboarding-meta-page`
> **Base:** auditoria do Item 1 em [`docs/audit-meta-connector.md`](./audit-meta-connector.md).
> **Natureza:** aditivo. NÃO toca o caminho de resolução/ingestão Meta (`src/meta.js`
> só teve o **default de versão Graph** v21.0→v25.0; lógica byte-idêntica). Deploy só
> após o gate verde (§4).

## 1. O que foi construído

Onboarding self-service: **um botão** "Conectar Página do Facebook" no `/configuracoes`
do dashboard. Toda a parte server-side (troca de code, cifragem, dupla-escrita, inscrição
leadgen) é invisível pro cliente. Resolve também a **pendência do Item 1**: a dupla-escrita
de `page_id` (`tenants` + `tenant_lead_source`) numa única transação.

### Lado Lead Manager (`leads-api.leovecchi.com`)
- **`src/onboardingMeta.js`** (novo) — lógica: `state` assinado, cliente Graph próprio
  (não reusa `meta.js`), troca code→token, resolução da Página, dupla-escrita transacional,
  inscrição leadgen, status vivo.
- **`src/routes/onboarding-meta.js`** (novo) — endpoints:
  - `GET /onboarding/meta/start?tenant=<uuid>&return_to=<dashboard url>` — **autenticado**
    (service JWT). Monta a URL do dialog FLB e devolve `{ url }`.
  - `GET /onboarding/meta/callback` — **público**, protegido pelo `state` HMAC. Faz toda a
    troca + persistência + inscrição e **302** de volta pro `return_to` com `?meta=...`.
  - `GET /onboarding/meta/status?tenant=<uuid>` — **autenticado**. Estado vivo (checa Graph).
- **`src/server.js`** — mount `/onboarding` com rate-limiter por IP (`RL_ONBOARDING`, def. 60).
- **`src/meta.js`** — default de versão Graph `v25.0` (env `META_GRAPH_VERSION` sobrescreve).

### Lado Dashboard (`agenda.leovecchi.com`)
- **`lib/leadManager.js`** (novo) — cliente fino do LM (`lmFetch` + `tenantIdDaFranquia`),
  extraído p/ reuso fora de `routes/leads.js` (que ficou intocado).
- **`routes/franquia.js`** — GET `/configuracoes` agora busca o status Meta (só gerente,
  best-effort); nova rota GET `/configuracoes/meta/conectar` (gerente) → pede a URL ao LM
  e 302 o browser pro dialog.
- **`views/recep-configuracoes.js`** — card "Conexão com o Facebook" + flash do retorno.
  Estados legíveis, sem IDs crus: **Não conectado / Conectado (nome da Página) / Conectado
  — inscrição de leads pendente / Erro**. Conectado → botão "Reconectar / Trocar Página".

## 2. Decisões travadas (com o lead)

- **Token guardado** = **PAGE access token** (em `tenants.meta_page_token_enc`), derivado do
  System User token não-expira do FLB → long-lived. É o que a ingestão usa
  (`meta.fetchLead`/`fetchUserName`/`sendMessage`). Ingestão intacta, sem refresh novo.
- **`/start` autenticado via proxy**: o botão chama uma rota do dashboard (gerente) que pede
  a URL ao LM server-to-server (Bearer SERVICE_TOKEN) e 302 o browser. Nenhum segredo no
  client. O `state` HMAC (segredo = `META_APP_SECRET`) é defesa-em-profundidade + anti-CSRF.
- **`tenant` = uuid do LM** (`f.lead_tenant_id`), não slug — o LM não conhece slug.
- **Falha de env = explícita** (sem fallback que mascare): `requireEnv` lança `env_missing`
  → 500 com a env faltante no log/resposta.
- **`return_to` no `state`**: o LM não conhece a base do dashboard; o `/start` embute no
  `state` assinado a URL completa de retorno que o dashboard mandar (allowlist de host
  contra open-redirect). O callback volta pra ela — não monta `/f/<slug>` por conta própria.
- **Inscrição leadgen não mente**: falha → status distinto ("Conectado — inscrição de leads
  pendente") e re-tentável (Reconectar). Sem gap silencioso. O status faz **checagem viva**
  na Graph (não flag persistida que pode driftar) — também detecta token expirado → "Erro".
- **`state`**: exp 10 min + nonce single-use (best-effort via Redis; se Redis cair, HMAC+exp
  seguem protegendo, e loga `nonce_miss` — não mascara).
- **Versão Graph**: confirmada contra a doc do Meta = **v25.0** (lançada 2026-02-18). Default
  no código; `META_GRAPH_VERSION` só sobrescreve.

## 3. CONFIG necessária no ambiente (ação do lead)

### Envs no container do **Lead Manager** (falha explícita se faltarem):
- `META_APP_ID` — **AUSENTE no `.env.claude-code`** (provisionar).
- `META_LOGIN_CONFIG_ID` — **AUSENTE** (provisionar; config FLB com Páginas[req]+IG[opt] e
  permissões leads_retrieval, pages_show_list, pages_manage_metadata, pages_read_engagement,
  business_management).
- `PUBLIC_BASE_URL=https://leads-api.leovecchi.com` — **AUSENTE** (necessária p/ o `redirect_uri`).
- `META_GRAPH_VERSION` — opcional (default `v25.0`).
- `META_ONBOARDING_RETURN_HOSTS` — opcional (default `agenda.leovecchi.com`).
- Já presentes: `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `LM_ENCRYPTION_KEY`, `JWT_SECRET`.

### Envs no container do **Dashboard** (já usadas por leads.js, confirmar):
- `LEAD_MANAGER_API_URL` (default `https://leads-api.leovecchi.com`), `SERVICE_TOKEN`,
  `DASHBOARD_BASE_URL` (default `https://agenda.leovecchi.com`), `LEAD_MANAGER_TENANT_ID`
  (piloto, se a franquia não tiver `lead_tenant_id`).

### **redirect_uri a REGISTRAR na app Meta** (ação do lead):
> **`https://leads-api.leovecchi.com/onboarding/meta/callback`**
> Adicionar em **"URIs de redirecionamento OAuth válidos"** da app Regente (ADR Lead Manager).

## 4. GATE (bloqueante) — E2E contra a Página do próprio ADR (app em modo dev)

**Offline (roda no dev, já VERDE):** `node --test test/onboardingMeta.test.js` — 8/8
(state HMAC/exp/malformado, allowlist de return_to, falha explícita de env). ✅

**E2E vivo (roda no CONTAINER deployado — precisa de DB + app Meta):**
1. Setar as envs do §3 no container e registrar o `redirect_uri` na app Meta.
2. `/configuracoes` da unidade ADR → "Conectar Página do Facebook" → login FLB → callback.
3. `docker exec -it adr-lead-manager node test/gate-onboarding-meta.js <TENANT_ID_DO_ADR>`
   — checa, sem escrever: token decifra · `tenant_lead_source` ativo · `meta_page_id ==
   entity_id` (Item 1 fechado) · 1 fb_page ativa (idempotente) · leadgen inscrito
   (subscribed_apps vivo) · `page_id` resolve de volta pro tenant (ingestão intacta).
4. Reconectar (mesma Página) → re-rodar o gate: continua 1 fb_page ativa (não duplica).

> **Sem todos verdes, NÃO deploya.** O gate E2E **não pôde rodar do sandbox de dev** (DB/Meta
> fora de alcance — `ECONNRESET`); precisa do container. Offline está verde.

## 5. Edge cases sinalizados (não resolvidos aqui)
- **Multi-página num grant**: `me/accounts` com >1 página → pega a 1ª e loga `multi_page`.
  Seleção de qual página fica p/ depois (self-onboarding ADR = 1 página).
- **Página já vinculada a OUTRO tenant**: o `UNIQUE(platform,entity_id)` + RLS fariam o
  `ON CONFLICT` falhar (linha de outro tenant invisível). Não ocorre no self-onboarding;
  tratar com mensagem clara quando virar multi-tenant de verdade.
- **Refresh de token** (risco §7.2 do audit do Item 1): segue sem refresh; o status vivo
  ao menos **detecta** expiração/revogação → "Erro / Reconecte".
