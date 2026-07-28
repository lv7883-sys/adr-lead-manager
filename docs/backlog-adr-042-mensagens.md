# NOVA — Backlog: Central de Mensagens "Regente" (ADR-042)

**Data:** 2026-07-28 | **Status:** RASCUNHO p/ refino | **ADR:** [ADR-042](adr/ADR-042-central-mensagens-inbox-disparo.md)

> **Premissa de UI travada (Fase 1):** o inbox é **fluxo único** — todas as conversas
> (lead + não-lead + grupos) numa lista só, estilo WhatsApp Web, com **filtros/visões**
> (Todas · Leads · Não-lead · por fonte). A visão "só Leads" é um filtro salvo, não uma
> aba separada. Se a intenção for abas fixas, E12-04 muda.

Escala de complexidade: **P** (≤1d) · **M** (2–3d) · **G** (4–6d) · **GG** (>1 sprint).

---

## Épicos

| ID | Épico | Entrega |
|---|---|---|
| **E12** | Inbox 1:1 WhatsApp | "Descartados"→"Mensagens": shell 3 painéis, lista unificada, receber/enviar/editar/apagar em conversas diretas WhatsApp |
| **E13** | Painéis laterais | Arquivos de acesso rápido + biblioteca de mensagens prontas |
| **E14** | Grupos & Comunidades | Ingestão e envio em grupos/comunidades via Z-API |
| **E15** | Waseller (disparo) | Agendamento + disparo em massa via **reuso** do engine do Scheduler |
| **E16** | Omnichannel pleno | IG DM + Messenger no inbox (envio por canal) + Google |

---

## E12 — Inbox 1:1 WhatsApp (MVP da tela Mensagens)

| ID | Story | Cx | Depende de | Agente |
|---|---|---|---|---|
| E12-01 | Rebranding rota/label **Descartados→Mensagens** + item de nav | P | — | NEON |
| E12-02 | Shell 3 painéis (layout esq/centro/dir, responsivo) | M | E12-01 | NEON |
| E12-03 | API de **listagem unificada** de conversas diretas (lead + não-lead) com **fonte** (`leads.origem`) e flag **"é lead ativo"** projetada (ADR-041), sob RLS | G | — | CORE·LOGIC |
| E12-04 | Sidebar esquerda: lista com badge de fonte, **pill LEAD**, busca e **filtros** (Todas/Leads/Não-lead/fonte) | G | E12-02, E12-03 | NEON |
| E12-05 | Thread central: render inbound/outbound, role, mídia, estados **editada/apagada** (migr. 063–066) | G | E12-02 | NEON |
| E12-06 | **Enviar mensagem humana** (outbound) via Z-API a partir da thread (reusa staff outbound, migr. 010) | G | E12-05 | BRIDGE·CORE |
| E12-07 | Editar / apagar mensagem pela UI (reusa 063–066) | M | E12-05, E12-06 | NEON·BRIDGE |
| E12-08 | Near-realtime da thread e da lista (webhook→push/polling) | M | E12-04, E12-05 | BRIDGE·NEON |
| E12-09 | Deep-link bidirecional **Inbox↔telas de Lead** (abrir lead da conversa e voltar) | M | E12-04 | NEON |
| E12-10 | RBAC (quem envia/apaga) + auditoria de ações do inbox | M | E12-06 | SHIELD |

**Marco:** recepção responde qualquer conversa WhatsApp dentro do Regente. Entrega valor sozinho.

---

## E13 — Painéis laterais (arquivos rápidos + mensagens prontas)

| ID | Story | Cx | Depende de | Agente |
|---|---|---|---|---|
| E13-01 | Modelo + CRUD `canned_messages` (texto + variáveis `{{nome}}` + categoria) | M | E12-03 | CORE |
| E13-02 | Painel direito: biblioteca de mensagens prontas com busca + **inserção 1-clique** + substituição de variáveis | G | E13-01, E12-05 | NEON·LOGIC |
| E13-03 | Modelo + CRUD `quick_files` (reusa `resources`/uploads) | M | — | CORE |
| E13-04 | Painel direito: arquivos de acesso rápido com preview + **anexar 1-clique** na thread | G | E13-03, E12-06 | NEON·BRIDGE |
| E13-05 | Gestão (admin) das bibliotecas por tenant | M | E13-01, E13-03 | NEON |

---

## E14 — Grupos & Comunidades

| ID | Story | Cx | Depende de | Agente |
|---|---|---|---|---|
| E14-01 | **Spike:** viabilidade Z-API grupos/comunidades + política Meta ✅ **GO-CONDICIONAL** ([spike](adr/SPIKE-E14-grupos-comunidades.md)) | P | — | ATLAS·BRIDGE |
| E14-01b | **Validação em sandbox Z-API real** (payload de comunidade, LID sem telefone, teto de rate, volume de webhook em grupo grande) — gate p/ E14-03/04 | P | E14-01, credencial Z-API | BRIDGE |
| E14-02 | Migr `conversation_kind` (DIRECT/GROUP/COMMUNITY) + `groups` + `group_members` (**telefone + LID**) | M | E14-01 | CORE |
| E14-03 | Ingestão de mensagem de grupo no webhook (autoria por participante) | G | E14-02 | BRIDGE |
| E14-04 | Envio em grupo | G | E14-03, E12-06 | BRIDGE |
| E14-05 | UI: abas Grupos/Comunidades na sidebar + autoria por participante na thread | G | E14-03, E12-04 | NEON |
| E14-06 | Sync de metadados de grupo (nome, participantes, admin) | M | E14-02 | BRIDGE |

---

## E15 — Waseller (agendamento + disparo em massa)

| ID | Story | Cx | Depende de | Agente |
|---|---|---|---|---|
| E15-01 | **Contrato de API interna LM↔Scheduler** (spec §6 do ADR + auth serviço-a-serviço, ADR-005) | G | — | BRIDGE·ARC |
| E15-02 | Cliente no LM p/ enfileirar disparo (`/dispatch/schedule`) + `dispatch_ref` | M | E15-01 | BRIDGE |
| E15-03 | Webhook de progresso Scheduler→LM refletido no inbox | M | E15-02, E12-08 | BRIDGE |
| E15-04 | UI: compositor de disparo (seleção de alvos, mensagem pronta/template, janela/agenda) | G | E15-02, E13-02 | NEON |
| E15-05 | UI: painel de acompanhamento de campanhas (status por alvo) | M | E15-03 | NEON |
| E15-06 | Enforcement anti-bloqueio (LM **não** burla regras) + limites por assinatura | M | E15-02 | SHIELD·LOGIC |
| E15-07 | Guardrail ADR-006 (MANUAL/SEMI/AUTO) aplicado ao disparo | M | E15-02 | LOGIC |

> **Nota D2:** toda regra anti-ban mora no Scheduler. O LM só enfileira. Ver ADR-042 §6.

---

## E16 — Omnichannel pleno (IG · Messenger · Google)

| ID | Story | Cx | Depende de | Agente |
|---|---|---|---|---|
| E16-01 | **Envio** por canal IG DM + Messenger — janela 24h/`HUMAN_AGENT` + inscrição `messages` no webhook. **Sender in-window JÁ EXISTE** (`meta.sendMessage`, rota viva). **Contas da própria ADR Valinhos = só ligar, SEM App Review** ([spike](adr/SPIKE-E16-envio-meta.md)) | ~~GG~~ **M** | E12-05 (Valinhos) | BRIDGE·ARC |
| E16-02 | Unificação da UI multi-canal no inbox (render + envio pelo canal correto) | G | E16-01, E12-05 | NEON |
| E16-03 | Identidade/dedup de pessoa cross-canal (herda ADR-007 §2.4) | G | E16-01 | CORE·LOGIC |
| E16-04 | **Spike:** Google (Business Profile messaging vs. lead forms de Ads) | M | — | ATLAS |
| E16-05 | **Dashboard self-service de conexão de canais por tenant** (cada unidade/empresa pluga suas próprias contas Meta/WhatsApp; sem administração central pelo super-admin). Estende `onboardingMeta.js`/FLB | G | E16-01 | NEON·BRIDGE |
| E16-06 | **Meta App Review + Advanced Access + Live mode** — gate p/ 1º tenant EXTERNO (contas de terceiros via self-service). NÃO bloqueia Valinhos. Abrir em paralelo antes do 1º cliente externo | M | E16-05 | ATLAS·SHIELD |

---

## Ordem de execução recomendada

```
E12 (01→02→03→04→05→06→07→08→09→10)          ← MVP, entrega valor sozinho
  ├─► E13 (painéis laterais)                   ← em paralelo após E12-05/06
  ├─► E14 (grupos)   [gated por spike E14-01]
  └─► E15 (disparo)  [gated por contrato E15-01]
        └─► E16 (omnichannel pleno) [gated por ADR-007]
```

**Caminho crítico técnico:** E12-03 (API de listagem unificada) destrava toda a UI.

**Gates externos (status pós-spikes 2026-07-28):**
- **E14 (grupos):** 🟡 GO-CONDICIONAL — receber + enviar humano na thread OK; broadcast
  automático em grupo/comunidade só via Scheduler (D2) + gate ADR-006. Confirmar em sandbox
  Z-API (E14-01b) antes de E14-03/04.
- **E16 (Meta):** 🟢 **ADR Valinhos = sem gate** — o envio IG/Messenger das contas da
  própria Valinhos é "só ligar" (sender já existe; app opera sobre assets próprios, sem
  App Review). O **Meta App Review + Live mode** só vira gate quando o **1º tenant EXTERNO**
  conectar contas de terceiros via o **dashboard self-service (E16-05)** — aí é caminho
  crítico de semanas, aberto em paralelo ANTES do 1º cliente externo (Fase 2 do roadmap),
  não agora. Ver `docs/meta-app-review-guia.md`.

## Fora de escopo (explícito)

- Envio automático ao cliente sem supervisão (guardrail — só sob ADR-006).
- Reimplementar disparo/anti-ban no LM (proibido por D2).
- Editar o Scheduler fora desta feature (autorização D1 é escopada).
- Dedup de pessoa cross-canal antes de existir o 2º canal de **envio** (E16).
