# SPIKE E16 — Envio por canal Meta (IG DM + Messenger) no inbox

- **Status:** ✅ SPIKE CONCLUÍDO — decisão recomendada abaixo
- **Data:** 2026-07-28
- **Autores:** ATLAS (decisões) + ARC (arquitetura) — time FORGE
- **Destrava/adia:** épico **E16** (ADR-042 Fase 5) e a promoção do **ADR-007** (multicanal)
- **Relacionados:** ADR-042 §7 (fases), ADR-007 §2.3/§2.4, migr. 015/030/041, `src/meta.js`, `src/metaIngest.js`, `src/onboardingMeta.js`, `src/routes/tenant.js` (rota `mensagem-meta`), `docs/audit-lead-meta-superficie.md`

> **DECISÃO EM DESTAQUE:** **ADIAR a execução do E16** (UI omnichannel + dedup de pessoa) para
> **depois das Fases 1–4** — **MAS iniciar AGORA, em paralelo, o trâmite de compliance
> (Meta App Review / Advanced Access)**, que é o verdadeiro caminho crítico de calendário, e
> aplicar um **fix pequeno de janela de 24h** no envio que já existe. Motivo curto: o *envio*
> Meta **não** é greenfield — o backend de envio (E6) **já está implementado**; o que falta é
> **permissão (app review, semanas–meses)**, **UI** e **guardrail de janela**.

---

## 1. O que a Meta EXIGE hoje para envio (Send API — IG DM + Messenger)

### 1.1 Permissões + App Review (Advanced Access)
- **Instagram DM:** permissão **`instagram_business_manage_messages`** (também citada como
  `instagram_manage_messages`) — enviar/receber DM. Uso em produção com usuários reais exige
  **Advanced Access via App Review**.
- **Messenger (Página FB):** permissão **`pages_messaging`** — enviar pela Send API atrelada à
  Página, aprovada por **App Review**.
- **Multi-tenant é o caminho difícil:** como o LM gerencia Páginas/contas que **não** são do
  desenvolvedor (são de cada tenant), a Meta classifica como app usada por **outros negócios** →
  exige **Advanced Access + Business Verification** e revisão rigorosa (semanas a meses). A revisão
  cobra um **caminho de escalonamento humano/opt-out** e **webhooks corretos** (inclusive deleção).
- **HUMAN_AGENT (feature à parte):** para responder **fora da janela** é preciso a feature
  **"Human Agent"** habilitada (Advanced Access) — sujeita à mesma revisão.

### 1.2 Janela de 24h + tags
- **Janela padrão de 24h:** quando o usuário manda mensagem (ou clica CTA/reage), abre-se uma
  janela de **24h** em que o negócio pode enviar **qualquer** conteúdo, inclusive promocional.
  **Fora da janela, mensagem padrão é bloqueada.**
- **`HUMAN_AGENT` tag:** estende a janela para **até 7 dias** para **atendimento humano** a um caso
  não resolvido em 24h. **Proibido para bot/automação** — a Meta detecta abuso. É human-authored
  (casa exatamente com o guardrail de supervisão do LM — envio humano pela recepção).
- **Tags promocionais/estruturadas:** para envio proativo fora da janela a Meta migrou para
  **Marketing Messages / Utility Templates** (estrutura de template + categoria, análogo ao WhatsApp).
  Além disso, as tags `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` retornam
  **erro 100 a partir de 27/04/2026** — não usar.

**Fontes (oficiais + confirmação secundária):**
- [Send Messages — Instagram API (Meta Developers)](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/)
- [Send API — Messenger Platform (Meta Developers)](https://developers.facebook.com/docs/messenger-platform/reference/send-api/)
- [Instagram Platform Overview (Meta Developers)](https://developers.facebook.com/docs/instagram-platform/overview/)
- [Meta Advanced Access — quais permissões exigem App Review](https://singhamandeep.com/what-is-meta-advanced-access/)
- [HUMAN_AGENT tag — Chatwoot user guide](https://www.chatwoot.com/hc/user-guide/articles/1745225158-what-is-human-agent-tag-in-instagram-messenger-channel)
- [Instagram Messaging API 24-Hour Window (2026)](https://www.keyapi.ai/blog/instagram-messaging-api-policy/)
- [Enviar fora das janelas 24h/7d — Manychat](https://help.manychat.com/hc/en-us/articles/14281199732892-How-to-send-messages-outside-the-24-hour-and-7-day-windows-in-Messenger-and-Instagram)

---

## 2. Estado atual do LM — já temos vs. falta (baseado no código)

### JÁ TEMOS (o "envio Meta pendente" do ADR-007 está DESATUALIZADO)
- **Recepção completa:** webhook Meta (Lead Ads + IG DM + Messenger) com verificação de
  assinatura `X-Hub-Signature-256` — `src/routes/webhook-meta.js`, `meta.verifySignature`.
- **Ingestão no funil:** `src/metaIngest.js` (leadgen → lead; DM → triagem).
- **Token de Página cifrado por tenant:** `tenants.meta_page_token_enc` (AES-256-GCM,
  `src/crypto.js`), lido/decifrado por `meta.pageCredsForTenant`.
- **Roteamento por página/conta → tenant:** `tenant_by_meta_page` / `tenant_lead_source`
  (migr. 015/041), resolvendo `page_id` FB **e** `ig_id`.
- **`meta_psid` por lead** (migr. 015/030), com índice único parcial `(tenant_id, meta_psid)`.
- **ENVIO já implementado (E6):**
  - `src/meta.js` → **`sendMessage({pageId, token}, psid, text)`** = `POST /{page_id}/messages`
    com `messaging_type: 'RESPONSE'`.
  - **Rota HTTP viva:** `POST /tenant/:tid/leads/:id/mensagem-meta` (`src/routes/tenant.js:1492`)
    — resolve `meta_psid` + canal, decifra Page Token, envia, persiste em
    `staff_outbound_samples`, dispara classificação de saída (shadow). RBAC `WRITE_ROLES`.
- **Onboarding self-service da Página:** `src/onboardingMeta.js` (Facebook Login for Business,
  troca de code→token, dupla-escrita transacional, inscrição `leadgen`).

### FALTA para enviar de fato IG DM + Messenger no inbox
- **Compliance (o gargalo real):** **App Review / Advanced Access** para
  `instagram_business_manage_messages` + `pages_messaging` (+ feature **Human Agent**) e
  **Business Verification**. Sem isso o envio só funciona para contas de teste/roles do app.
- **Assinatura de `messages` na Página:** o onboarding inscreve **só `leadgen`**
  (`subscribeLeadgen`, `subscribed_fields: 'leadgen'`) — falta inscrever **`messages`/
  `messaging_postbacks`** para IG/Messenger receberem/enviarem no fluxo pleno.
- **Guardrail de janela de 24h:** `messaging_type` está **fixo em `'RESPONSE'`**
  (`src/meta.js:69`) — só funciona **dentro** da janela; sem checagem "janela aberta?" nem
  suporte a **`tag: HUMAN_AGENT`** (7 dias) para envio humano fora da janela. Envio fora da
  janela hoje **falha silenciosamente** com erro do Graph (502 na rota).
- **UI de inbox omnichannel (E16-02):** renderizar/enviar pelo canal correto dentro da tela
  "Mensagens"; hoje a rota existe mas não há tela que a consuma no inbox.
- **Mídia por Meta:** `sendMessage` só envia **texto** (sem anexos/imagem via Send API).
- **Identidade/dedup de pessoa cross-canal (§2.4 / E16-03):** não implementado.
- ~~**Bug latente de vínculo** (do `audit-lead-meta-superficie.md`): quando o **WhatsApp chega
  antes** do leadgen, o `ON CONFLICT (tenant_id, meta_leadgen_id)` **não cobre** a colisão de
  `phone` → `unique_violation` não tratada → vínculo Meta perdido.~~ ✅ **RESOLVIDO** (commit
  `4b47c2f`): o upsert do leadgen faz `findByPhone` (BR-aware) e **funde** no lead existente,
  gravando `meta_leadgen_id`; cobre as duas ordens de chegada. A **corrida** (WhatsApp commita
  entre o `findByPhone` e o INSERT) foi blindada depois com `SAVEPOINT` + tratamento do 23505 de
  `uq_leads_tenant_phone` → reconsulta e merge (`src/engine.js`, gate `test/gate-lead-origem-dedup.js`).

---

## 3. Identidade cross-canal (ADR-007 §2.4) — recomendação

**Como `leads` é chaveado hoje:** três índices ÚNICOS PARCIAIS na **própria tabela `leads`**,
um por canal:
- `uq_leads_tenant_phone (tenant_id, phone) WHERE phone IS NOT NULL` (migr. 004)
- `leads_meta_psid_uq (tenant_id, meta_psid) WHERE meta_psid IS NOT NULL` (migr. 015/030)
- `leads_meta_leadgen_id_uq (tenant_id, meta_leadgen_id) WHERE meta_leadgen_id IS NOT NULL`

`conversations` já é `(tenant_id, channel, external_id)`, e a timeline da recepção agrega **por
dígitos do identificador** (`coalesce(phone, meta_psid)`), não por `conversation_id`.

### Recomendação: **manter a identidade em `leads` (chave por-canal já existente) — NÃO criar `lead_identities` agora**
- **Ancoragem:** o modelo `(tenant, channel, external_id)` já **existe de fato** em `leads` na
  forma de índices parciais por canal + em `conversations`. É o menor delta e zero migração de
  dados. `phone` é `nullable` e o índice é parcial — DM sem telefone já convive.
- **`lead_identities` (1 lead → N identidades)** é a modelagem **certa** para o problema do §2.4
  (mesma **pessoa** em WhatsApp + IG + FB), mas esse problema **só existe quando há 2º canal de
  ENVIO vivo** — ou seja, **depois** do E16 destravado. Criar a tabela antes é infra sem cliente.
- **Portanto:** para E16-01/02 (enviar pelo canal correto) a chave por-canal em `leads` **basta**.
  Adote `lead_identities` apenas em **E16-03**, quando a recepção precisar **fundir pessoas**
  (merge manual + sinais nome/e-mail). Aí `leads` vira "pessoa" e `lead_identities` guarda os
  pares `(channel, external_id)`.
- **Fazer junto, barato:** corrigir o **bug latente** do §2 (Cenário B) adicionando ao upsert do
  leadgen um segundo caminho de conflito por `phone` — senão a própria identidade cross-canal
  (WhatsApp ↔ leadgen) já quebra hoje, antes mesmo do IG/FB.

---

## 4. Decisão — promover ADR-007 AGORA ou adiar E16?

### Trade-offs

| Eixo | Promover ADR-007 → completo AGORA (executar E16 já) | Adiar E16 p/ depois das Fases 1–4 |
|---|---|---|
| **Esforço** | UI omnichannel + dedup + guardrail de janela — concorre com o MVP (E12) que é o valor | Fases 1–4 entregam WhatsApp (o canal com 100% do volume hoje) sem disputa de foco |
| **Valor** | Baixo no curto prazo: o volume real é WhatsApp; IG/FB é cauda | Alto: recepção respondendo no Regente (E12) entrega sozinho |
| **Risco compliance** | **Não muda** — o app review não acelera por a gente codar UI antes | Igual — o app review corre **em paralelo**, independente de dev |
| **Calendário** | Bloqueado assim mesmo pelo review (semanas–meses) | Se o review começar **agora**, fica pronto quando as Fases 1–4 acabarem |

### Decisão recomendada
1. **ADIAR a execução do E16** (UI omnichannel E16-02 + dedup E16-03) para **depois das
   Fases 1–4**, conforme a sequência já recomendada no ADR-042 (`0→1→2→3→4→5`). O valor está em
   WhatsApp; E16 é cauda e não deve disputar foco com o MVP.
2. **GO-AGORA no que é caminho crítico de calendário e barato:**
   - **Abrir o Meta App Review / Advanced Access JÁ** (`instagram_business_manage_messages`,
     `pages_messaging`, feature **Human Agent**) + **Business Verification**. É o item de
     semanas–meses; começar agora evita que o E16 fique **bloqueado por calendário** quando as
     Fases 1–4 terminarem.
   - **Fix pequeno de janela (P):** parametrizar `messaging_type`/`tag` em `meta.sendMessage`
     (suporte a `HUMAN_AGENT` para envio humano até 7 dias) + erro claro na rota quando a janela
     está fechada. Alinha o código à política humana-supervisionada e ao guardrail do LM.
   - **Corrigir o bug de vínculo** (Cenário B do §2/§3) — barato e já melhora identidade hoje.
3. **ADR-007: NÃO promover a "completo" ainda — mas ATUALIZAR** para refletir a realidade: a
   parte de **ingestão** e o **envio in-window (E6)** **já existem** (o texto atual diz "envio
   pendente/nada implementado", o que está **stale** e induz a erro). Promover a "completo" só
   quando **app review + UI (E16-02)** estiverem entregues. A decisão de **identidade** (§3) pode
   ser **cravada agora** no ADR-007: chave por-canal em `leads`; `lead_identities` só em E16-03.

> **Resumo da decisão:** ADIAR E16 (execução) · GO-AGORA no app review + fix de janela + fix de
> vínculo · ADR-007 = atualizar (não promover a completo).

---

## 5. Próximos passos concretos

1. **[ATLAS/Leo] Abrir Meta App Review AGORA** — Advanced Access p/
   `instagram_business_manage_messages` + `pages_messaging` + feature **Human Agent**; concluir
   **Business Verification**. Preparar o roteiro do review (caminho de escalonamento humano +
   opt-out; webhook de deleção). *(caminho crítico — semanas a meses)*
2. **[BRIDGE] Fix de janela (P):** `meta.sendMessage` aceita `{ messaging_type, tag }`; a rota
   `mensagem-meta` usa `HUMAN_AGENT` para envio humano fora das 24h e retorna erro legível quando
   a janela está fechada e não há tag aplicável.
3. **[CORE] Inscrever `messages`/`messaging_postbacks`** no onboarding (`subscribeLeadgen` →
   generalizar para os campos de mensageria), para IG/Messenger fluírem além de leadgen.
4. ~~**[CORE] Corrigir o vínculo leadgen↔WhatsApp** (Cenário B): tratar conflito por `phone` no
   upsert do leadgen (elimina `unique_violation` silenciosa).~~ ✅ **FEITO** — merge por telefone
   no upsert do leadgen (commit `4b47c2f`) + blindagem da corrida via `SAVEPOINT`/23505
   (`src/engine.js`), coberto pelo gate `test/gate-lead-origem-dedup.js` (Cenários B e B-corrida).
5. **[ARC] Cravar identidade no ADR-007 §3:** chave por-canal em `leads` agora; `lead_identities`
   só em **E16-03** (dedup de pessoa) — e **atualizar o Status do ADR-007** para "ingestão +
   envio in-window implementados; UI/omnichannel e app review pendentes".
6. **[NOVA] Reordenar backlog:** rebaixar **E16-01** de "GG / envio nunca implementado" para
   "M — guardrail de janela + tag + inscrição de `messages`" (o envio-base já existe); manter
   **E16-02** (UI) e **E16-03** (dedup) como pós-Fases 1–4, gated pelo app review.
7. **[ATLAS] Revisitar E16** assim que (a) app review aprovado **e** (b) Fase 4 concluída —
   então promover ADR-007 a completo.
