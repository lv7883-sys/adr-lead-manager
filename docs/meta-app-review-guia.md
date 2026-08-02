# Guia — Meta App Review (DM + Comentários IG/Messenger) — ADR-042 / E16

**Criado:** 2026-07-28 · **Atualizado:** 2026-08-02 | **Dono da execução:** Leo | **Refs:** [SPIKE-E16](adr/SPIKE-E16-envio-meta.md), [ADR-007](adr/ADR-007-multicanal.md)

> **⚠️ Escopo (esclarecido por Leo, 2026-07-28):** este review **NÃO bloqueia a ADR Valinhos**
> para **DM/Messenger** sobre os **próprios** ativos. O **Messenger da Valinhos já está LIGADO de
> verdade** (subscribed_fields confirmados no servidor) e o envio pelo inbox funciona. O review
> vira gate obrigatório quando o **1º tenant EXTERNO** conectar as **próprias** contas via o
> dashboard self-service (E16-05) → app usado por negócios sem role nele → Meta exige **App
> Review + Advanced Access + Live + Business Verification**. Abrir **em paralelo, antes** desse
> cliente (aprovação leva semanas).
>
> **Instagram é o caso que precisa de review antes:** o modelo de integração do IG (mensagens e
> comentários) exige app **Live + Advanced Access** para operar com o público em geral — mesmo na
> conta própria. Por isso o **IG está parqueado** aguardando este processo, enquanto DM do
> Messenger já roda.

> **O que eu (Claude) NÃO faço por você** e por quê: login na conta Meta, aceite de termos,
> verificação de negócio e a submissão do review envolvem credenciais e consentimento legal em
> nome da empresa — por política, são seus. Eu preparo **todo o material** (textos de caso de uso,
> roteiro de screencast, checklist LGPD, justificativa multi-tenant) — pronto abaixo — e reviso o
> que você montar.

---

## 🔴 BLOQUEIO ATUAL (2026-08-02) — resolver primeiro

O **token Meta da Valinhos EXPIROU** (`OAuthException 190/463: Session has expired on 01-Aug-26
15:00`). O token cifrado no banco **não é** o System User "Nunca" — é o efêmero do Graph API
Explorer (30/jul). Consequência: Messenger não busca nome/envia, leadgen para, e atribuição de
campanha (messaging_referrals) + comentários **não ativam**.

**Ação (só você, no Business Manager):** gerar um token de **System User com expiração "Nunca"**,
com a Página Valinhos **e** o Instagram atribuídos ao System User, e colar em `/f/valinhos/meta`.
Isso reconecta e o `subscribeLeadgen` **re-assina todos os campos automaticamente**. Permissões no
token: `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, **`pages_manage_engagement`**
(comentários FB), e — quando o IG entrar — `instagram_basic`, `instagram_manage_messages`,
`instagram_manage_comments`. Depois de colar, eu verifico server-side (token nunca no chat).

---

## Visão geral do caminho crítico

```
1. Business Verification (Meta Business Suite)              ← mais demorado, começar por aqui
2. App em Live mode + produtos (Messenger + Instagram) adicionados
3. Advanced Access das permissões (App Review)              ← depende de 1 e 2
4. Feature "Human Agent" (estende janela de resposta p/ 7 dias)
5. Inscrever webhooks no código                            ← ✅ JÁ FEITO (ver §5)
```

## Permissões a solicitar (Advanced Access)

| Canal | Permissão | Para quê |
|---|---|---|
| Instagram DM | `instagram_manage_messages` | enviar/receber DM da conta IG (via Facebook Login for Business) |
| Instagram comentários | `instagram_manage_comments` | ler/responder/ocultar comentários de posts IG *(já adicionada ao app)* |
| Messenger | `pages_messaging` | enviar/receber mensagens da Página FB *(✅ já ativo na Valinhos)* |
| FB comentários | **`pages_manage_engagement`** | responder/ocultar comentários de posts da Página **(FALTA adicionar)** |
| Base | `instagram_basic`, `pages_manage_metadata`, `pages_read_engagement` | vincular contas, ler metadados, assinar webhooks |
| Ambos | **Human Agent feature** | estende a janela de 24h → **7 dias** para atendimento **humano** (bot proibido na janela estendida) |

> A feature **Human Agent** casa com o guardrail do LM (envio sob supervisão da recepção) — é
> argumento a favor na submissão. A resposta a **comentário** é pública no post e **não** está
> sujeita à janela de 24h (regra das mensagens); ainda assim exige as permissões de comentário.

## Regras de envio que o review cobra (e o código respeita)

- **Janela de 24h (DM):** dentro, envio livre; fora, mensagem padrão **bloqueada** — só com tag
  `HUMAN_AGENT` (7 dias, humano) ou template de Marketing/Utility aprovado.
- Tags antigas (`CONFIRMED_EVENT_UPDATE`/`ACCOUNT_UPDATE`/`POST_PURCHASE_UPDATE`) dão **erro 100
  desde 27/04/2026** — não usar. Promocional fora da janela = Marketing Messages/Utility Templates.

---

## Passo a passo (você executa; material de apoio pronto abaixo)

### 1. Business Verification — comece hoje
- [ ] Meta Business Suite → **Configurações do negócio → Central de Segurança → Verificação do negócio**.
- [ ] Em mãos: CNPJ, comprovante de endereço da empresa, contato validável (telefone/e-mail no domínio).
- [ ] Submeter e acompanhar — é o item que mais atrasa; o resto anda em paralelo.

### 2. App e produtos
- [ ] App **ADR Lead Manager** (id `1042359435406836`) — confirmar em Live mode (não Development).
- [ ] Adicionar/confirmar os produtos **Messenger** e **Instagram**.
- [ ] Política de privacidade pública + URL de exclusão de dados (LGPD — já temos `/privacidade` e
      `/forget`; validar públicos e apontados no App).

### 3. App Review — submissão
- [ ] Solicitar **Advanced Access**: `instagram_manage_messages`, `instagram_manage_comments`,
      `pages_messaging`, `pages_manage_engagement` (+ base).
- [ ] Colar o **texto de caso de uso** de cada permissão (§"Material" abaixo).
- [ ] Anexar o **screencast** (roteiro abaixo).
- [ ] Justificar o modelo **multi-tenant** (§"Material").

### 4. Human Agent
- [ ] Marcar a feature **Human Agent** e explicar que o envio é por **atendente humano** (recepção),
      não bot — alinhado ao guardrail.

### 5. Webhook (código) — ✅ JÁ FEITO
`onboardingMeta.subscribeLeadgen` hoje assina: **`leadgen,messages,messaging_postbacks,messaging_referrals,feed,comments`**.
Cobre DM, atribuição de campanha (referral) e comentários (FB `feed` + IG `comments`). Re-assina
sozinho a cada (re)conexão de token.

---

## Material que preparei (pronto pra colar)

### Caso de uso — Instagram DM (`instagram_manage_messages`)
> Our app "ADR Lead Manager" powers the customer-service inbox ("Regente") used by music-school
> receptionists. Prospective students send direct messages to the school's Instagram account asking
> about lessons, prices and schedules. We use `instagram_manage_messages` to receive those DMs into
> the receptionist inbox and let a **human receptionist** reply. No bots send messages in the
> extended window; automated replies are limited to out-of-hours acknowledgements within policy.

### Caso de uso — Instagram comentários (`instagram_manage_comments`)
> People comment on the school's Instagram posts asking about lessons. We use
> `instagram_manage_comments` to bring those comments into the same receptionist inbox, so a human
> can **reply publicly** to the comment and, when appropriate, **hide** spam/abusive comments. This
> improves response time to genuine prospective-student questions on public posts.

### Caso de uso — Messenger (`pages_messaging`) e FB comentários (`pages_manage_engagement`)
> The school's Facebook Page receives messages and post comments from prospective students. We use
> `pages_messaging` to route Page messages to the receptionist inbox for **human** reply, and
> `pages_manage_engagement` to let receptionists **reply to and hide** comments on the Page's posts.

### Roteiro do screencast (grave com a Valinhos, tela real do Regente)
1. Mostrar o app em Live e a Página/IG conectados em `/f/valinhos/meta` (status "assinado").
2. **DM:** de outro celular, enviar um DM ao Instagram/Messenger da escola → mostrar a mensagem
   **chegando na Caixa de Entrada** → recepcionista **humana digita e envia** a resposta → mostrar
   a resposta chegando no app de origem.
3. **Comentário:** comentar num post da escola → mostrar o comentário **aparecendo como conversa**
   (pill "💬 comentário", aviso "resposta pública") → responder → mostrar a resposta pública no post
   → demonstrar **ocultar** um comentário de spam.
4. Narrar em cada passo que **quem responde é uma pessoa** (recepção), não um bot.
5. Mostrar `/privacidade` e `/forget` (política + exclusão de dados) rapidamente.

### Justificativa multi-tenant (rascunho)
> ADR Lead Manager is a multi-tenant SaaS for music schools. Each school connects its **own** Meta
> assets (Facebook Page + Instagram account) through our self-service onboarding (Facebook Login for
> Business), granting access explicitly. We never access assets without the business owner's consent,
> and each tenant's data is isolated (row-level security). Access is used solely to operate that
> school's own customer-service inbox.

### Checklist LGPD/privacidade (a Meta valida)
- [ ] Política de privacidade **pública** e linkada no App (`/privacidade`).
- [ ] Fluxo de **exclusão de dados** público e funcional (`/forget`).
- [ ] Consentimento na conexão (o onboarding FLB registra o grant do dono do ativo).

---

## Dados de referência (para a submissão)
- App **ADR Lead Manager**: `1042359435406836`
- Businesses: Academia Do Rock `1312218778912484` · Academia do Rock Valinhos `185299724662635`
- Config FLB "Regente Conectar Pagina": `1711062123261550` (token System User + Nunca)
- Valinhos: tenant `ed731a58-62e5-45ad-acba-a5502ff39e92` · page `229583146901202`
- Webhook callback: `https://leads-api.leovecchi.com/webhook/meta`

## Dependências de código — status
- [x] Inscrever `messages`/`messaging_postbacks` no onboarding — **feito**.
- [x] `messaging_referrals` (atribuição de campanha) — **feito** (migr. 086).
- [x] Ingestão + responder + ocultar **comentários** (`feed`/`comments`) — **feito** (migr. 087).
- [ ] [BRIDGE] janela de 24h: parametrizar `messaging_type`/`tag` em `meta.sendMessage`
      (suporte `HUMAN_AGENT`) + erro legível quando a janela fecha (`meta.js`).
- [ ] Mapear tenant por **ig_id** (ingestão de comentário/DM do IG quando `entry.id` é a conta IG,
      não a Página) — hoje resolve por page_id; follow-up quando o IG entrar em produção.
- [ ] Botão 🙈 **ocultar por bolha** no dashboard (backend pronto; falta expor `comment_id` no timeline).

## Como acompanhar
Status de verificação e review no painel do App (**App Review → Permissions and Features**) e na
Central de Segurança. Me avise quando cada etapa mudar de estado que eu ajusto o gate de E16 no backlog.
