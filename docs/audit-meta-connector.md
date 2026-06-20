# Auditoria — Conector de captação Meta por-tenant (map-first)

> **Autor:** BRIDGE (Integrações / FORGE) · **Repo:** `adr-lead-manager` @ `c4e63d6` (main)
> **Natureza:** auditoria de evidência. NENHUM arquivo de produção foi alterado. Único
> artefato é este doc. Toda afirmação tem âncora `arquivo:linha`; o que não foi achado
> está marcado **NÃO ENCONTRADO**.
>
> **TL;DR (corrige a premissa da tarefa):** a captação Meta **NÃO está cravada no tenant
> ADR**. A resolução de tenant já é **derivada do `page_id` do payload** via função SQL
> `tenant_by_meta_page()` (`db/migrations/015_meta_channels.sql:40`), e as credenciais de
> página já são **por-tenant, cifradas** (`tenants.meta_page_token_enc`). O que ainda é
> single-tenant é o **app Meta global** (`META_APP_SECRET` / `META_WEBHOOK_VERIFY_TOKEN`)
> e o **mapeamento de campos domain-specific** (instrumento musical). Metade do design que
> a tarefa pediu pra "propor" já existe; a generalização real é extrair page_id pra uma
> tabela `tenant_lead_source` multi-plataforma e tornar o app-secret per-tenant.

---

## 1. Ground truth — qual caminho existe de verdade

| Caminho candidato (doc) | Existe no código? | Entrada |
|---|---|---|
| **(a) Webhook Graph leadgen DIRETO** (verify-token, X-Hub-Signature, subscription) | ✅ **SIM — é o caminho real** | `GET/POST /webhook/meta` em `src/routes/webhook-meta.js:29,49` |
| **(b) Indireto via Playwright na extranet filtrando origem=meta-ads** | ❌ **NÃO existe** para captação de lead Meta | — |

**Evidência de (a):**
- Handshake de verificação `hub.verify_token` → `webhook-meta.js:29-39`.
- Recepção de eventos + validação `X-Hub-Signature-256` → `webhook-meta.js:49-64`, `src/meta.js:124-133`.
- Cliente Graph API (`graph.facebook.com`) → `src/meta.js:11,14,35,75`.
- Orquestração leadgen/DM → `src/metaIngest.js` (todo o arquivo).
- Schema de canais Meta → `db/migrations/015_meta_channels.sql`, `db/migrations/030_meta_psid.sql`.

**Evidência de que (b) NÃO existe:** os termos `meta-ads`, `meta_ads`, `cron-adr-bi`,
`CRON_SECRET`, `ad_account` = **NÃO ENCONTRADOS** em `src/`. `playwright`/`extranet`
aparecem **só em `docs/backlog-adicional.md:13,52`** como trabalho **futuro** (E8-02 sync de
alunos / E11-02 ex-alunos), e o próprio backlog diz "não há Playwright" (`backlog-adicional.md:52`).
Nada disso captura lead de anúncio nem está implementado. **A extranet/Playwright pertence ao
`adr-whatsapp-scheduler` (scraper de grade), não a este repo.**

> Os Lead Ads chegam pelo **webhook Graph direto**. Não há nenhum caminho indireto Meta no código.

---

## 2. Inventário da superfície (ingestão de lead Meta)

| Etapa | Arquivo:linha | Função |
|---|---|---|
| Mount da rota (endpoint único) | `src/server.js:77` | `app.use('/webhook', webhook-meta)` |
| Captura do corpo BRUTO (p/ assinatura) | `src/server.js:24-28` | `express.json({ verify: req.rawBody = buf })` |
| Verify handshake (GET) | `src/routes/webhook-meta.js:29-39` | `router.get('/meta')` |
| Receiver de eventos (POST) | `src/routes/webhook-meta.js:49-64` | `router.post('/meta')` — ACK 200 imediato + ingest assíncrono |
| Validação de assinatura | `src/meta.js:124-133` | `verifySignature(rawBody, header)` |
| Dispatcher do payload (entries → leadgen/DM) | `src/metaIngest.js:96-118` | `ingest(body)` |
| Parsing/enriquecimento leadgen | `src/metaIngest.js:31-64` | `ingestLeadgen(value, isUpdate)` |
| Fetch de detalhes do form (Graph) | `src/meta.js:75-80` | `fetchLead(leadgenId, pageToken)` |
| field_data → mapa | `src/meta.js:93-102` | `fieldDataToMap()` |
| Mapeamento de campos (name/phone/instrumento) | `src/metaIngest.js:15-20,45-48` | `findInstrument` + extração |
| Copy de 1ª mensagem (domain-specific) | `src/metaIngest.js:24-29` | `buildLeadgenMessage(name, instrument)` |
| Resolução de tenant | `src/meta.js:104-109` | `tenantByPageId(pageId)` |
| Credenciais de página (por-tenant) | `src/meta.js:111-119` | `pageCredsForTenant(tenantId)` |
| **Junção com o pipeline unificado** | `src/metaIngest.js:63,92` → `src/engine.js:411` | `engine.processInbound(tenant, msg, …)` |
| Persistência do lead (upsert) | `src/engine.js:646-665` | INSERT `leads … ON CONFLICT (tenant_id, meta_leadgen_id)` |
| Schema (colunas/índices/função) | `db/migrations/015_meta_channels.sql`, `030_meta_psid.sql` | — |

DM (Messenger/IG) compartilha o mesmo arquivo: `ingestMessage` (`metaIngest.js:66-93`),
dedup por `meta_psid` (`engine.js` ~666). Fora do escopo de *Lead Ads* mas mesma superfície.

---

## 3. Catálogo de hardcodes (tipo × natureza)

| Item | Tipo | Natureza | Onde | Estado vs multi-tenant |
|---|---|---|---|---|
| `META_APP_SECRET` | app_secret | **env global única** | `src/meta.js:125` | **1 app p/ todos os tenants.** HMAC da assinatura usa 1 secret só → bloqueia per-tenant app |
| `META_WEBHOOK_VERIFY_TOKEN` | verify_token | **env global única** | `src/routes/webhook-meta.js:33` | 1 token de verificação p/ a inscrição única |
| `META_GRAPH_VERSION` | (versão API) | env global (default `v21.0`) | `src/meta.js:11` | Global, mas neutro a tenant (ok) |
| `meta_page_id` / `meta_ig_id` | page_id | **coluna no banco (por-tenant)** | `db/migrations/015_*.sql:28-29`; lido em `src/meta.js:114` | ✅ **JÁ per-tenant** (resolve tenant) |
| `meta_page_token_enc` (Page Access Token) | page access token | **coluna cifrada (por-tenant)** | `db/migrations/015_*.sql:30`; decifrado `src/meta.js:113-118` | ✅ **JÁ per-tenant** (AES-256-GCM via `LM_ENCRYPTION_KEY`, `src/crypto.js:16,27`) |
| `app_id` / `META_APP_ID` | app_id | — | **NÃO ENCONTRADO** em `src/` | Não usado (só o app_secret entra, no HMAC) |
| `ad_account_id` | ad_account | — | **NÃO ENCONTRADO** | Não usado p/ roteamento nem ingestão |
| `form_id` | form_id | — (só leitura) | `src/meta.js:77` (campo pedido no fetch) | Buscado como metadado; **NÃO** roteia tenant nem mapeia campos |
| Mapa de campos `full_name`/`phone_number`/`first_name`/`last_name` | field mapping | constante em código | `src/metaIngest.js:45-47` | Nomes-padrão do form Meta (genéricos), mas a lista é fixa em código |
| Heurística de **instrumento** (`/instrument\|instrumento/i`) | field mapping | **constante em código (domain)** | `src/metaIngest.js:15-20,48` | **Domain-specific (escola de música)**, não tenant-id |
| Copy "Vim pelo anúncio… aula de {instrumento}/nas aulas" | field mapping/copy | **constante em código (domain)** | `src/metaIngest.js:24-29` | **Domain-specific**; deveria vir do `lead_definition` por-tenant |
| **uuid do tenant ADR no caminho Meta** | tenant_id | — | **NÃO ENCONTRADO** em `meta.js`/`metaIngest.js`/`webhook-meta.js`/`engine.js` | ✅ Não há tenant cravado na ingestão Meta |

**Tipo extranet (caminho b):** N/A — caminho (b) não existe. `URL extranet`, `CRON_SECRET`,
assunção de unidade Valinhos no caminho Meta = **NÃO ENCONTRADOS**. (A única referência a
Valinhos cravado é `src/jobs/validar-classificador-conversa.js:18`, um job de validação do
classificador — **fora** da ingestão de lead.)

---

## 4. Resolução de tenant hoje (o ponto crítico)

**Classificação: `DERIVADO` (do envelope do payload).** — *não* cravado, *não* inexistente.

Linha exata para um Lead Ad:
```
src/metaIngest.js:37   const tenantId = await meta.tenantByPageId(pageId);
src/metaIngest.js:32   const pageId  = value && value.page_id;   // vem do webhook
```
`tenantByPageId` (`src/meta.js:104-109`) chama a função SQL:
```
db/migrations/015_meta_channels.sql:40-45
  FUNCTION lead_manager.tenant_by_meta_page(p_page_id) RETURNS uuid SECURITY DEFINER
  SELECT id FROM tenants WHERE (meta_page_id = p_page_id OR meta_ig_id = p_page_id)
                           AND lead_manager_active LIMIT 1;
```
DM segue idêntico: `metaIngest.js:76` (`tenantByPageId(pageId)` com `pageId = entry.id`, `metaIngest.js:113`).

**Implicações:**
- O mecanismo `(entity_id) → tenant_id` que a tarefa pediu pra propor **já existe**, porém:
  - Limitado a **Meta** (sem dimensão de plataforma).
  - **1 página por tenant** (colunas `meta_page_id`/`meta_ig_id` em `tenants`, com UNIQUE
    index — `015:32-35`), não N entidades.
  - Sem `form_id`/`ad_account_id` como chave (granularidade fica no page).
- Se `page_id` não casar com nenhum tenant ativo → descarta silencioso (`metaIngest.js:38`
  `meta.leadgen.unknown_page`). Fail-safe correto.

> **Este é o achado mais importante e ele INVERTE a hipótese da tarefa:** o tenant não está
> cravado — está derivado por `page_id`. O trabalho de generalização é **estender** esse
> lookup (multi-plataforma, multi-entidade), não criá-lo do zero.

---

## 5. Fronteira de abstração + shape do lead normalizado

**Junção:** `engine.processInbound(tenant, msg, rawBody, deps)` — `src/engine.js:411`.
Chamada por ambos os lados:
- Meta leadgen → `src/metaIngest.js:63`
- Meta DM → `src/metaIngest.js:92`
- WhatsApp (Z-API/Evolution) → `src/routes/webhook.js:205`

**Acima da junção = source-specific** (o futuro conector): receiver, assinatura, fetch Graph,
mapeamento de campos, resolução de tenant. **Abaixo = compartilhado e já genérico** (gating de
assinatura, classificador, funil, persistência) — `engine.js:411+`.

**Shape do "lead normalizado" (contrato `msg` que o engine consome)** — união observada em
`engine.js:424-427,607,640-665` e produzida por `metaIngest.js:50-61,83-90` / `webhook.js:29-65`:

| Campo | Origem/uso | Obrigatório | Anchor |
|---|---|---|---|
| `channel` | `'meta_lead_ads'` \| `'instagram_dm'` \| `'facebook_messenger'` \| `'whatsapp'` (default) | sim | `engine.js:424`, `metaIngest.js:51` |
| `phone` / `externalId` | identidade telefônica → `toE164` | um de (phone\|psid\|leadgenId) | `engine.js:426`, `metaIngest.js:52-53` |
| `psid` | identidade DM (sem telefone) | — | `engine.js:425`, `metaIngest.js:85` |
| `leadgenId` | dedup `meta_leadgen_id` | leadgen | `engine.js:646`, `metaIngest.js:57` |
| `sender` | nome | opcional | `metaIngest.js:54,87` |
| `body` | texto da 1ª mensagem | sim | `metaIngest.js:55,88` |
| `externalMessageId` | idempotência (`messages.external_message_id`) | recomendado | `engine.js:635-639`, `metaIngest.js:59-60` |
| `skipTriage` | leadgen já é lead → pula Portão 1 | leadgen=`true` | `engine.js:607`, `metaIngest.js:56` |
| `media` | mídia WhatsApp (não-Meta) | — | `webhook.js:59`, `engine.js`(downstream) |
| `fromMe`/`isGroup`/`source` | tratados em `webhook.js` ANTES da junção; Meta não seta | — | `webhook.js:35-61,164-175` |

> **Contrato mínimo que QUALQUER conector futuro deve produzir:**
> `{ channel, (phone|externalId|psid|leadgenId), sender?, body, externalMessageId?, skipTriage? }`
> + um `tenant` (`{ id }`) resolvido. Tudo abaixo de `processInbound` já é tenant-genérico.

---

## 6. Proposta da abstração de conector por-tenant (design, sem código)

### 6.1 Interface `LeadSourceConnector` (conceitual)
- `verifyWebhook(req) → challenge | 403` — handshake (hoje: `webhook-meta.js:29`).
- `authenticate(req, rawBody) → ok | reject` — assinatura/segredo **selecionado pelo entity_id
  do envelope** (ver 6.4 e §7).
- `parseInbound(payload) → NormalizedLead[]` — payload→contrato do §5 (hoje: `metaIngest.js:96`).
- `resolveTenant(envelope) → tenant_id` — via `tenant_lead_source` (6.2). Hoje: `meta.js:104`.
- `enrich(normalizedLead, creds) → NormalizedLead` — fetch de detalhes do form/usuário
  (hoje: `meta.fetchLead`/`fetchUserName`, `meta.js:75,83`).
- `mapFields(rawForm, leadDefinition) → {name, phone, …}` — **mapa por-tenant** (substitui a
  heurística cravada de `metaIngest.js:15-29`).

Downstream (`processInbound`) **não muda**.

### 6.2 Tabela `tenant_lead_source` (generaliza `meta_page_id`/`meta_ig_id`)
Shape proposto:
```
tenant_lead_source(
  id              uuid pk,
  tenant_id       uuid  -> tenants(id),
  platform        text  check in ('meta','google','tiktok', …),
  entity_kind     text  check in ('fb_page','ig_account','lead_form','ad_account', …),
  entity_id       text,                       -- page_id / ig_id / form_id / ad_account_id
  field_map       jsonb,                      -- {full_name:'name', phone_number:'phone', …} por-tenant
  active          boolean default true,
  created_at      timestamptz default now(),
  UNIQUE (platform, entity_id)                -- a chave de roteamento do webhook
)
```
- `resolveTenant` = `SELECT tenant_id FROM tenant_lead_source WHERE platform=$1 AND entity_id=$2 AND active`.
- Migração: as colunas `tenants.meta_page_id`/`meta_ig_id` (`015:28-29`) viram linhas
  `(platform='meta', entity_kind∈{fb_page,ig_account})`. Mantém a função SECURITY DEFINER
  (mesmo padrão sem-RLS de `015:40`), agora parametrizada por `(platform, entity_id)`.

### 6.3 Credenciais por-tenant
- **Já existe** o padrão certo: coluna cifrada AES-256-GCM (`tenants.meta_page_token_enc`,
  `015:30` + `crypto.js:16-27`). Generalizar para `tenant_lead_source.credentials_enc`
  (ou tabela `tenant_lead_source_secret(tenant_id, platform, secret_enc)`), por
  `(tenant_id, platform)`.
- **RLS:** a resolução de tenant roda ANTES de haver contexto de tenant → manter
  `SECURITY DEFINER` (como `tenant_by_meta_page`, `015:38-46`) para o lookup; depois de
  resolver, todo acesso a dados do lead segue sob `withTenant` (RLS normal, `meta.js:113`).
  A tabela de segredos deve ficar **fora do alcance do `lead_manager_user` comum** (só a
  função definer lê), pra um app_secret de um tenant nunca ser legível por outro.

### 6.4 Roteamento de webhook — endpoint único vs path por-tenant

| Opção | Como | Trade-off |
|---|---|---|
| **Endpoint único `/webhooks/meta/leadgen`** (resolve tenant do payload) — **é o padrão Meta atual** (`server.js:77`, `metaIngest.js:37`) | A Meta só permite **1 callback URL por app**; tenant sai do `page_id` | ✅ Compatível com o modelo de app único da Meta. ❌ Precisa selecionar o app_secret certo **pelo `page_id` antes de validar** (§7) — risco de segurança a desenhar |
| **Path por-tenant `/webhook/zapi/:tenantId`** — padrão WhatsApp (`server.js:80`, `webhook.js:211`) | tenant no URL + token | ✅ Tenant trivial, secret per-path. ❌ **Não aplicável ao Meta** (callback URL única do app) |

> Recomendação: **endpoint único por plataforma** para Meta/Google/TikTok (eles impõem 1
> callback por app), com resolução por `entity_id`. O modelo per-path do WhatsApp continua
> válido para provedores que deixam a URL livre (Z-API/Evolution).
>
> **Nota de risco operacional:** hoje `/webhook/meta` está montado **fora** do rate-limiter
> keyed-por-tenant (`server.js:76-77` vs `:80`), porque o limiter casa o uuid no path
> (`server.js:71`) e `/webhook/meta` não tem. Endpoint único multi-tenant precisa de um
> limiter próprio (por IP ou por `page_id` pós-parse).

### 6.5 Extensão multi-plataforma (Google, TikTok)
- Nova **implementação da mesma interface** (6.1) + novas **linhas** em `tenant_lead_source`
  (`platform='google'|'tiktok'`). `parseInbound`/`mapFields`/`authenticate` específicos da
  plataforma; `resolveTenant` reusa a tabela; **zero mudança downstream** de `processInbound`.
- O contrato do §5 é o único acoplamento — cada conector só precisa emitir um `NormalizedLead`.

### 6.6 Plano de migração — ADR vira a 1ª linha (tenant comum)
1. Criar `tenant_lead_source` (6.2) e migrar `tenants.meta_page_id`/`meta_ig_id` → linhas
   `(platform='meta', …)`. **Hoje o `meta_page_id` do ADR NEM é seedado** (NÃO ENCONTRADO em
   `db/seeds/` — provisão manual), então é só inserir a 1ª linha com o page_id real do ADR.
2. Tirar do hardcode, para essa 1ª linha funcionar como tenant comum:
   - `META_APP_SECRET` global (`meta.js:125`) → secret por `(tenant, platform)` selecionado
     por `page_id` (§7).
   - `META_WEBHOOK_VERIFY_TOKEN` global (`webhook-meta.js:33`) → pode seguir por-app (a
     verificação é por-app, não por-tenant), mas documentar como config do app, não do tenant.
   - `findInstrument` + `buildLeadgenMessage` (`metaIngest.js:15-29`) → `field_map` +
     template de 1º contato vindos do `lead_definition`/`tenant_lead_source` por-tenant
     (o `lead_definition` já existe na migr. `039` para o classificador — reusar).
3. Manter `META_GRAPH_VERSION` global (neutro).

---

## 7. Riscos / edge cases (sinalizar, NÃO resolver)

1. **Assinatura per-tenant antes de confiar no payload** (o nó górdio). Hoje `verifySignature`
   usa `META_APP_SECRET` global (`meta.js:125`) e a validação ocorre ANTES de resolver o
   tenant (`webhook-meta.js:52`). Multi-app exige: ler o `page_id` do **corpo bruto NÃO
   confiável** só para *selecionar* o app_secret, e só então validar o HMAC. Desenhar com
   cuidado (parse mínimo e defensivo do envelope; entry pode ter múltiplos page_ids num
   batch → validar por entry). Hoje há **fail-open**: se `META_APP_SECRET` ausente, processa
   mesmo assim (`webhook-meta.js:47,57-59`, `meta.js:126`) — aceitável em rollout single-app,
   **inaceitável** multi-tenant.
2. **Expiração/refresh do Page Access Token longo-vivo.** `meta_page_token_enc` é estático
   (`015:25`, `meta.js:117`); não há refresh nem detecção de token expirado (Graph 190).
   Multi-tenant amplifica (N tokens expirando em datas diferentes).
3. **Mapa de campos variável por-tenant.** `full_name`/`phone_number`/`instrument`
   (`metaIngest.js:45-48`) assume o form do ADR. Forms de outro tenant/vertical têm nomes de
   campo diferentes e sem "instrumento". Precisa `field_map` por (tenant, form).
4. **Dedup do mesmo lead via ad × WhatsApp orgânico.** Hoje a identidade é fragmentada:
   leadgen dedup por `meta_leadgen_id`, DM por `meta_psid`, WhatsApp por `phone`
   (`engine.js:642-666`). Uma pessoa que preenche o Lead Ad e depois manda WhatsApp vira
   **2 leads** (chaves diferentes). Não há reconciliação por telefone entre `meta_leadgen_id`
   e o lead de WhatsApp. (Relaciona o backlog `ADR-007 §2.4` — `docs/adr/ADR-007-multicanal.md`.)
5. **Endpoint único sem rate-limit** (`server.js:76-77`) — ver 6.4; superfície aberta.
6. **`form_id`/`ad_account` não capturados como dimensão.** São lidos (`meta.js:77`) mas não
   persistidos nem usados p/ roteamento; se o futuro quiser mapear campos por-formulário
   (não por-página), falta gravar o `form_id` no lead.

---

## 8. Checklist de saída

- [x] **NENHUM arquivo de produção foi alterado.** O working tree de `main` foi apenas
      materializado (checkout) para leitura; a única escrita é este doc novo
      (`docs/audit-meta-connector.md`). Sem edição de `src/`, `db/`, configs ou migrations.
- [x] Caminho real determinado por grep, não por doc: **(a) webhook Graph direto**; (b) Playwright
      **NÃO existe** (§1).
- [x] Toda afirmação ancorada em `arquivo:linha`; ausências marcadas **NÃO ENCONTRADO**
      (app_id, ad_account_id, uuid ADR no caminho Meta, CRON_SECRET, seed de meta_page_id).
- [x] Achado crítico (§4): tenant **DERIVADO de `page_id`**, não cravado — inverte a premissa.
- [x] Contrato da junção documentado (§5): `engine.processInbound` @ `src/engine.js:411`.
- [ ] **Pendente de validação humana** antes de qualquer código/migration (próxima tarefa):
      tabela `tenant_lead_source`, app_secret per-tenant, dedup cross-canal.

> Doc não commitado — deixado no working tree para revisão. Confirmar antes de versionar.
