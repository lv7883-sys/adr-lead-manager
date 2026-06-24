# Auditoria — Lead do Meta na superfície da recepção

**Autor:** BRIDGE (FORGE) · **Tipo:** map-first, read-only · **Data:** 2026-06-21
**Repos cruzados:** `lead-manager` (LM, backend/ingestão) + `adr-whatsapp-scheduler` (dashboard/recepção)
**Confirmação:** nenhum arquivo de produção foi tocado. Só leitura + este documento em `docs/`.

> **Pergunta:** como um lead de Lead Ad da Meta cai HOJE na recepção, e o que falta
> pra ele ser trabalhado igual a um lead de WhatsApp (mesma troca de mensagens) + ter
> métrica por FONTE. Lembrando: lead ad é **formulário** (nome/telefone/email), NÃO um
> chat — a conversa real só acontece quando a recepção contata a pessoa pelo WhatsApp.

---

## 0. Jornada em uma frase

Webhook Meta → `metaIngest.ingestLeadgen` busca o lead na Graph API → `engine.processInbound`
com `skipTriage:true` → cria lead (`status NEW→QUALIFYING`, dedup por `meta_leadgen_id`),
cria conversa `channel='meta_lead_ads'`, injeta uma mensagem **sintética** de boas-vindas
("Olá! Vim pelo anúncio…") como se fosse o lead, e gera um **rascunho** de 1º contato em
modo observação → o lead aparece no kanban/fila da recepção com a resposta pronta, **sem
envio automático**. A recepção edita e dispara pelo WhatsApp da unidade. **EXISTE a espinha
dorsal**; os GAPS são de rotulagem de origem, robustez do dedup por telefone e fidelidade
da métrica por fonte.

---

## 1. INGESTÃO → lead record

### O que existe
- **Entrada:** `src/routes/webhook-meta.js:49` (`POST /webhook/meta`) responde 200 imediato,
  valida assinatura HMAC (`meta.verifySignature`, fail-open se `META_APP_SECRET` ausente —
  `webhook-meta.js:52-59`) e chama `metaIngest.ingest` fire-and-forget (`:61`).
- **Roteamento leadgen:** `src/metaIngest.js:143-148` → `ingestLeadgen` (`:74`). Resolve
  tenant por `page_id` (`meta.tenantByPageId`, hoje wrapper sobre `tenant_by_lead_source`,
  migr. 041), busca o lead na Graph API (`meta.fetchLead`, `:86`), mapeia o `field_data`
  e aplica o `field_map` por-tenant ou o `DEFAULT_FIELD_MAP` (`metaIngest.js:17-28`, `:89`).
- **Campos capturados:** `name`, `phone`, `interest` (`applyFieldMap`, `:65-72`). O `email`
  do formulário **NÃO é extraído** (não há `email_key` no field_map nem uso de `lead.email`)
  — **NÃO ENCONTRADO**, apesar de a coluna `leads.email` existir (`001_init_lead_manager.sql:28`).
- **Lead criado:** `engine.js:646-656`. `INSERT INTO leads (tenant_id, name, phone, status,
  meta_leadgen_id) VALUES (…, 'NEW', …)` com `ON CONFLICT (tenant_id, meta_leadgen_id)`.
  Promovido a `QUALIFYING` no Portão 2 (`engine.js:835-838`).

### ORIGEM/FONTE — como é (não) armazenada
- **NÃO existe coluna genérica `source`/`origem`/`fonte` em `leads`.** Schema em
  `001_init_lead_manager.sql:23-32` + `015_meta_channels.sql` só adiciona `meta_leadgen_id`
  e `meta_psid`. A origem é **inferida implicitamente** por qual coluna está preenchida
  (`meta_leadgen_id` ≠ null ⇒ veio de Lead Ad) e pelo `channel` da **conversa**, não do lead.
- **A fonte "viajável" hoje é `conversations.channel`** = `'meta_lead_ads'` (setado em
  `metaIngest.js:93` → `engine.js:425,692-697`). Valores possíveis: `meta_lead_ads`,
  `instagram_dm`, `facebook_messenger`, `whatsapp`.
- **Forward-compat:** a camada de **roteamento** já é genérica e multi-plataforma —
  `tenant_lead_source(platform, entity_id, field_map)` com `platform` "forward-compat
  (Google/TikTok depois)" (migr. `041_tenant_lead_source.sql`). Mas isso é **mapa
  entidade→tenant**, não a fonte gravada NO lead. **GAP:** o lead em si não carrega um
  campo de fonte genérico/imutável; o `channel='meta_lead_ads'` é o mais próximo e é
  **mutável** (ver §5).

### Telefone — normalização e cruzamento com WhatsApp
- Normalizado por `toE164` (`engine.js:427` → `validation.js:18-22`): apenas **tira não-dígitos
  e prefixa `+`**. `"5511988887777"` → `"+5511988887777"`.
- **NÃO existe `normalizarBR`/lógica ANATEL** (sem trato de DDI 55, sem 9º dígito, sem
  DDD) — **NÃO ENCONTRADO** no repo (`grep normaliz|anatel` só acha `toE164`).
- **Risco de cruzamento:** o telefone do **formulário Meta** pode vir sem DDI (`"11988887777"`
  → `"+11988887777"`) enquanto o do **WhatsApp/Evolution** vem com 55 (`"+5511988887777"`).
  `toE164` não reconcilia os dois ⇒ dedup por telefone (§4) **falha silenciosamente** quando
  o formato diverge. Onde o código compara por dígitos ele usa `regexp_replace(...,'[^0-9]','')`
  (ex. `engine.js:461,485,522`), o que ajuda em pontuação mas **não** em DDI/9º-dígito ausentes.

---

## 2. ONDE aparece na recepção

### O que existe
- **Mesmo funil/kanban/fila.** O leadgen entra no Portão 2 do `engine.processInbound`,
  vira `QUALIFYING` (`engine.js:835`) e ganha um `pending_approval` (rascunho, §3), igual a
  qualquer lead. Sai nas mesmas listas: kanban (`tenant.js:132` `computeKanban`), fila/leads
  (`tenant.js:594`), todas com `channel` derivado da conversa mais recente
  (`(SELECT cv.channel … ORDER BY cv.updated_at DESC LIMIT 1)` — `tenant.js:337-341, 618-621`).
- **Thread não fica vazia.** `metaIngest.buildLeadgenMessage` (`metaIngest.js:55-61`) gera
  uma mensagem **sintética em 1ª pessoa** ("Olá! Vim pelo anúncio e tenho interesse em aula
  de {interest}. Meu nome é {name}.") que entra como `USER`/inbound (`engine.js:814-822`),
  e a IA gera a resposta `ASSISTANT` (`:823-827`). Então o card renderiza com 1 mensagem do
  "lead" + 1 rascunho — a timeline (`recep-lead-detalhe.js`) tem o que mostrar.

### GAP — a origem "Meta" NÃO é visível corretamente no card
- O badge de origem do card lê `l.channel` por um mapa que **não inclui os valores reais**:
  `ORIGEM_LABEL` em `recep-leads.js:41-44` tem `whatsapp/instagram/facebook/landing_page`,
  mas **não** `meta_lead_ads`, `instagram_dm`, `facebook_messenger`. `origemLabel`
  (`:45-47`) cai no default `'WhatsApp'`. **Logo, um lead de Lead Ad aparece rotulado como
  "WhatsApp"** no kanban/fila/detalhe (`origemBadge` usado em `recep-leads.js:172`,
  `recep-lead-detalhe.js:258`). Idem para DMs (`instagram_dm`/`facebook_messenger`).
- Histórico tem o mesmo problema: `ORIGEM_HIST` (`recep-leads-historico.js:14-21`) também
  não mapeia `meta_lead_ads` → default "Histórico WhatsApp".

---

## 3. RESPONDER / iniciar conversa pelo console

### O que existe — SIM, a recepção consegue iniciar
- **Campo único "Enviar ao lead"** (`recep-lead-detalhe.js:411-444`): um textarea livre.
  Com rascunho pendente, usa `/approve`; **sem rascunho (mensagem livre)** usa `/mensagem`
  (comentário `:411-415`).
- **Endpoint de envio livre:** `POST /tenant/:tid/leads/:id/mensagem` (`tenant.js:1059`).
  Exige só: `text`, `lead.phone` (`:1067`), instância Evolution conectada (`:1068-1070`).
  **NÃO exige inbound anterior nem draft** — ou seja, o caminho "iniciar pelo console" para
  um lead que só tem telefone **existe** e dispara via `evolution.sendText` (`:1075`),
  registrando a saída em `staff_outbound_samples` (`:1077`, `_registrarSaida`).
- Para leads de DM (Messenger/IG) há o par `/mensagem-meta` (`tenant.js:1089`) que responde
  pelo mesmo canal via Graph API.
- Como o leadgen já chega com um **rascunho de 1º contato** pré-preenchido (§2), na prática a
  recepção abre o lead, edita o texto e dispara — esse é o fluxo de paridade-Waseller
  ("iniciar a conversa pela recepção"), guardado por human-in-the-loop (sem auto-send).

### Ressalvas
- O envio é texto puro via Evolution. **Não há tratamento da janela de 24h / template do
  WhatsApp Business** para mensagem proativa fora de sessão — **NÃO ENCONTRADO**. Para lead
  ad (proativo, sem inbound real) isso pode esbarrar em política do WhatsApp dependendo do
  número/instância. Não bloqueia o mapa, mas é risco operacional.

---

## 4. VÍNCULO Meta-lead ↔ conversa WhatsApp (o linchpin)

Este é o ponto mais delicado. Há **dois índices únicos concorrentes** em `leads`:
- `leads_meta_leadgen_id_uq (tenant_id, meta_leadgen_id) WHERE meta_leadgen_id IS NOT NULL`
  (`015_meta_channels.sql`)
- `uq_leads_tenant_phone (tenant_id, phone) WHERE phone IS NOT NULL` (`004_conversational_engine.sql:27`)

E o upsert do leadgen só declara `ON CONFLICT (tenant_id, meta_leadgen_id)` (`engine.js:650`),
enquanto o upsert do WhatsApp só declara `ON CONFLICT (tenant_id, phone)` (`engine.js:670`).

### Cenário A — Meta chega ANTES (caso normal)
1. Leadgen cria lead com `phone` + `meta_leadgen_id` (`engine.js:646-656`).
2. Depois a pessoa responde no WhatsApp: ramo WhatsApp faz
   `INSERT … ON CONFLICT (tenant_id, phone) DO UPDATE` (`engine.js:667-674`). Como o telefone
   **já existe** (do leadgen), **conflita no `phone` e cai no DO UPDATE do MESMO lead**.
   ✅ **Linka no mesmo lead Meta** — *desde que o telefone normalize idêntico* (§1, frágil).

### Cenário B — WhatsApp chega ANTES (ordem invertida)
1. Existe lead só com `phone`.
2. Leadgen chega: `INSERT … ON CONFLICT (tenant_id, meta_leadgen_id)` — mas o `phone`
   **colide com `uq_leads_tenant_phone`**, índice que o `ON CONFLICT` declarado **não cobre**.
   ⇒ Postgres levanta `unique_violation` **não tratada** → exceção sobe → capturada em
   `metaIngest.js:147` (`meta.leadgen.error`), **lead NÃO recebe o `meta_leadgen_id`**.
   ❌ **GAP/bug latente:** o vínculo Meta não se forma e o evento leadgen é perdido (silencioso).

### Conversas ficam SEPARADAS por canal (mesmo quando o lead é único)
- Conversa do leadgen: `channel='meta_lead_ads'`, `external_id=phone`.
- Conversa do WhatsApp: `channel='whatsapp'`, `external_id=phone`.
- O `ON CONFLICT` de `conversations` é `(tenant_id, channel, external_id)` (`engine.js:694`),
  então **são duas linhas de conversa** para o mesmo lead. A timeline da recepção é montada
  por **identidade (dígitos do telefone), não por conversation_id único** — `loadRealHistory`
  recebe `ident` e o agregado por dígitos (`engine.js:519-529`; métricas idem
  `metrics.js:476,483-486`), então as mensagens dos dois canais **convergem na mesma timeline
  do lead**. ✅ Funciona, mas o `channel` "oficial" do lead passa a ser o da conversa mais
  recente (§5).

### Dedup — ponto exato
- **Único ponto de dedup por telefone que une Meta↔WhatsApp:** o `ON CONFLICT (tenant_id,
  phone)` do ramo WhatsApp (`engine.js:670`) — e só funciona na ordem do Cenário A e com
  telefone idêntico após `toE164`. **Não há** um passo explícito de "casar lead Meta com
  inbound WhatsApp por telefone normalizado robusto" — depende inteiramente do índice e da
  normalização ingênua. **GAP.**

---

## 5. MÉTRICAS por fonte

### O que existe
- `computeMetrics(tenantId, {period, channel})` (`metrics.js:130`) **aceita filtro de canal**
  (`:273` `rows = channel ? leads.filter(l => l.channel === channel) : leads`; heatmap `:431`).
- **Há quebra por canal:** `porCanal` ("Leads por canal", `metrics.js:425-426`) e
  `matPorCanal` ("matrícula por canal", `:446-452`), expostos na gestão
  (`recep-gestao.js:386` "Leads por canal", `:414` "Taxa de matrícula por canal").
- O `channel` de cada lead vem da conversa mais recente:
  `(array_agg(channel ORDER BY updated_at DESC))[1]` (`metrics.js:165-166, 235-236, 756-757`).

### GAP 1 — atribuição de fonte é MUTÁVEL (perde a origem Meta)
Como o `channel` da métrica é o da **conversa mais recente**, no Cenário A (§4) assim que a
recepção abre o thread de WhatsApp, a conversa `whatsapp` passa a ser a mais recente e o lead
**migra de `meta_lead_ads` para `whatsapp`** na métrica. Ou seja: **a conversão de um lead que
veio de Lead Ad é creditada ao WhatsApp**, não à Meta. Não existe um campo de origem **imutável**
no lead (`leads.source` inexistente, §1) para ancorar a atribuição. **Esse é o gap central de
métrica por fonte.**

### GAP 2 — os valores do filtro de canal NÃO batem com os armazenados
Na gestão, o seletor e os rótulos usam um vocabulário **diferente** do que o backend grava:
- `recep-gestao.js:92` `CANAIS = [whatsapp, instagram, messenger, **leadgen**]`
- `recep-gestao.js:46` `CANAL_LABEL = { whatsapp, instagram, messenger, **leadgen**:'Lead Ads' }`
- mas o backend grava `whatsapp`, `instagram_dm`, `facebook_messenger`, **`meta_lead_ads`**.

Consequências:
- Filtrar por **"Lead Ads"** envia `channel=leadgen`; `metrics.js:273/431` compara
  `l.channel === 'leadgen'` e o valor real é `'meta_lead_ads'` ⇒ **retorna zero**. O filtro de
  fonte para Meta está **quebrado**.
- "instagram"≠"instagram_dm", "messenger"≠"facebook_messenger" ⇒ idem para DMs.
- Nas barras "Leads por canal" o `canalLabel` (`recep-gestao.js:47`) não acha a chave e mostra
  o **valor cru** `meta_lead_ads` / `instagram_dm` / `facebook_messenger`.

### Schema
- Suporta segmentar **enquanto** o lead estiver na conversa daquele canal — mas não há coluna
  de fonte no lead que sobreviva ao 1º WhatsApp (GAP 1). Não há tabela/coluna de **atribuição
  de campanha/ad** (campaign/adset/ad id do Lead Ad) — **NÃO ENCONTRADO** (a Graph API entrega
  `lead.campaign_id`/`ad_id` em `meta_leadgen` mas nada é persistido; o objeto vai em `rawBody`
  de `engine.processInbound(..., { meta_leadgen: lead })` e fica só no `raw` da mensagem, não
  estruturado).

---

## Resumo dos GAPS priorizados

### Mínimo para "responder igual WhatsApp" (paridade de operação)
A espinha dorsal **já funciona** (lead surge no funil, com rascunho, e a recepção consegue
iniciar pelo WhatsApp via `/mensagem`). Faltam, em ordem:

1. **Robustez do dedup por telefone (linchpin §4).** (a) Tratar o **Cenário B**: o upsert do
   leadgen precisa lidar com colisão de `phone` (hoje estoura `unique_violation` não tratada e
   perde o evento). (b) Normalização **BR-aware** (DDI 55 / 9º dígito) para que telefone de
   formulário Meta e de WhatsApp convirjam — `toE164` ingênuo não garante isso. Sem isso, o
   vínculo Meta↔WhatsApp é sorte/azar.
2. **Origem visível no card (§2).** Adicionar `meta_lead_ads`/`instagram_dm`/`facebook_messenger`
   aos mapas `ORIGEM_LABEL` (`recep-leads.js:41`) e `ORIGEM_HIST` (`recep-leads-historico.js:14`).
   Hoje a recepção vê "WhatsApp" num lead que veio do Meta — engana quem trabalha o lead.

### Métrica / refinamento (não bloqueia operar, bloqueia medir)
3. **Campo de fonte IMUTÁVEL no lead (§1, §5-GAP1).** Persistir a origem no `leads` (ex.
   `source`/`origem`, forward-compat p/ Google/TikTok) gravada **na criação** e usada pela
   métrica, em vez de derivar do `channel` da conversa mais recente — senão a conversão do
   Lead Ad é sempre creditada ao WhatsApp.
4. **Corrigir o vocabulário de canal da gestão (§5-GAP2).** Alinhar `CANAIS`/`CANAL_LABEL`
   (`recep-gestao.js:46,92`) aos valores reais — hoje o filtro "Lead Ads" retorna zero.
5. **Capturar `email` do formulário (§1)** no `field_map` (coluna `leads.email` já existe).
6. **Persistir atribuição de campanha/ad (§5-schema)** (campaign/adset/ad id) para "conversão
   por campanha", não só por canal. Hoje fica só no `raw`.

---

*Confirmação final: auditoria read-only. Nenhum arquivo de produção (LM ou dashboard) foi
modificado; o único arquivo criado é este `docs/audit-lead-meta-superficie.md`.*

---

# PARTE 2 — BUILD + GATE (branch `feat/lead-origem-dedup`, 2026-06-21)

Implementação ADITIVA dos GAPS acima. Decisão travada: **origem = primeiro toque, imutável**
(toque posterior de outro canal vira EVENTO, não re-origina).

## O que mudou
- **Migração `043_lead_origem.sql`** (aditiva/idempotente): coluna `leads.origem` + índice
  parcial `idx_leads_origem` + backfill (canal da conversa MAIS ANTIGA; fallbacks
  leadgen→`meta_lead_ads`, psid→`facebook_messenger`, senão `whatsapp`). **Snapshot antes**
  (`bkp_leads_origem_<ts>`).
- **`src/telefoneBR.js`** (novo): porta do canônico ANATEL (`dashboard/lib/telefone.js`) +
  9º dígito (`evolution.js:_toggle9BR`). `digitsBR`/`toE164BR` (escrita BR-aware, garante
  DDI 55 → envio Evolution ok) e `matchKeys` (variantes com/sem 55 e com/sem 9º dígito p/
  DEDUP). Heurística do 9º dígito **relaxada** (não exige 1º dígito local ∈ [6-9]; celular
  moderno tem dígito livre após o "9"), gated em DDD válido — match por igualdade exata de
  dígitos, então variante a mais não funde gente diferente.
- **`src/engine.js`**: (1) `phone` escrito via `toE164BR`; (2) `origem` nas 3 INSERTs, FORA
  do `DO UPDATE` (imutável por construção); (3) **merge Cenário B** no ramo leadgen
  (pré-lookup por `matchKeys` → `UPDATE meta_leadgen_id=COALESCE(...)`, `name`/`email`
  COALESCE, evento `lead_eventos tipo='meta_form_recebido'`, origem intacta); (4) **blindagem
  duplicata** no ramo WhatsApp (mesmo pré-lookup `matchKeys` antes do `ON CONFLICT`, p/ lead
  em formato antigo não duplicar quando o cliente volta normalizado); (5) gate LGPD de
  opt-out endurecido p/ digit-match `matchKeys` (não escapa por formato).
- **`src/metaIngest.js`**: captura `email` (`email_keys` no field_map + `applyFieldMap`).
- **`src/metrics.js`**: `por_canal`/`matricula_por_canal`/heatmap/filtro leem
  `COALESCE(leads.origem, canal-da-conversa)` — fonte estável (Meta trabalhado via WhatsApp
  continua Meta).
- **Dashboard**: `ORIGEM_LABEL`/`ORIGEM_HIST`/`CANAL_LABEL`/`CANAIS` alinhados aos valores
  REAIS (`meta_lead_ads`/`instagram_dm`/`facebook_messenger`); badges leem `l.origem`;
  filtro "Lead Ads" envia `meta_lead_ads` (deixa de retornar zero).

## Risco de colisão (telefone) — medido
Canonicalização BR dos telefones JÁ gravados → **0 pares colidem** (154 leads). Mesmo assim
NÃO se reescreve a base: a convergência é na camada de dedup (`matchKeys`). 10 leads com
`phone` 18-díg `1203…` são LID/JID de grupo (não-telefone), deixados intactos.

## GATE (verde) — `test/gate-lead-origem-dedup.js`, código real da branch vs DB real, IA stubada
- [x] origem gravada na criação (first-touch) e IMUTÁVEL (2º toque WhatsApp não re-origina).
- [x] backfill: WhatsApp→whatsapp (154→whatsapp, 0 NULL); fallback Meta→meta_lead_ads provado.
- [x] Cenário B: WhatsApp existe → leadgen mesmo telefone → MERGE (sem duplicata, sem evento
      perdido, `meta_leadgen_id` setado, evento registrado, origem=whatsapp).
- [x] Cenário A: Meta → inbound WhatsApp mesmo telefone → mesmo lead, origem=meta_lead_ads.
- [x] telefone com/sem 9º dígito e com/sem 55 converge no mesmo lead.
- [x] filtro "Lead Ads" (`channel=meta_lead_ads`) retorna leads (≠ zero); badges leem origem.
- [x] métrica de fonte lê `leads.origem`.
- [x] email capturado num leadgen novo.
- [x] envio Evolution: telefone gravado canônico `+55DDD9XXXXXXXX` (9º dígito/toggle ok).
- [x] no-regression: WhatsApp novo entra no funil (QUALIFYING + thread); suíte 71/72 (a 1
      falha é `gate-onboarding-meta.js`, gate manual de Item 2 que exige arg/envs — alheio).

**Sem Meta na base real** (0 leadgen/psid): Cenários A/B, convergência e fonte-Meta validados
por ingest SINTÉTICO (lead WhatsApp + leadgen mesmo telefone). Confirmação em produção quando
o 1º lead Meta real fluir. Deploy via `docker compose` (sem Coolify) pendente de OK.
