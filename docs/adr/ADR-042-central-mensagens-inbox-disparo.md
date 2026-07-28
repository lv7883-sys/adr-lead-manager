# ADR-042 — Central de Mensagens "Regente" (Inbox Omnichannel + Disparo)

- **Status:** ✅ **DECIDIDO (fronteiras)** — 🚧 escopo por fase a refinar no backlog
- **Data:** 2026-07-28
- **Autor:** proposta de escopo (sessão Claude Code / time FORGE) — decisões D1/D2 travadas por Leo Vecchi
- **Relacionados:** ADR-007 (multicanal — ingestão/identidade/envio por canal; **consumido** por este ADR), ADR-003 (funil de triagem, abstração de canal), ADR-006 (centro de controle de automação MANUAL/SEMI/AUTO), ADR-031 (fidelidade de captura), migr. 043 (`leads.origem`), 041 (`tenant_lead_source`), 015/030 (canais Meta), 063–066 (edição/deleção de mensagem), 010 (staff outbound), 055 (gate shadow log).

> Rebatiza a tela **"Descartados" → "Mensagens"** e a promove a central de comunicação
> estilo WhatsApp Web dentro do Regente, com camada de disparo (Waseller) reusando o
> engine anti-bloqueio do Scheduler.

---

## 1. Contexto / motivação

A tela "Descartados" do Lead Manager é hoje, na prática, o balde das **conversas que não
são lead** (staff, alunos, fornecedores, falso-positivo — separadas pelo gate em
`bolaGate.js`/`known_contacts`). Ela é read-only: lista, não permite responder nem enviar.

Leo quer trazer **todo o WhatsApp para dentro do Regente** e, no futuro próximo,
Instagram/Facebook/Google — uma central onde **toda** mensagem (lead ou não) é recebida,
lida, editada, respondida e disparada. As mensagens que **são lead** continuam aparecendo
nas telas de lead que o LM já tem, mas dentro do inbox aparecem **sinalizadas** e
**marcadas por fonte** (`whatsapp`/`instagram`/`facebook`/`google`).

O alicerce já existe e é grande (ver §3), então este ADR **não é um greenfield**: é a
camada de **inbox (UI + envio humano)** + **disparo (Waseller)** sobre uma base que já
ingere múltiplos canais e já tem origem imutável de lead.

## 2. Decisões travadas

### D1 — Fronteira do Scheduler: **AUTORIZADA para esta feature**
A tela "Mensagens" vive no **frontend Next.js do Scheduler** (`agenda.leovecchi.com`),
junto da console `/leads` que já mora lá. Leo autorizou **editar arquivos do Scheduler**
para esta feature especificamente. A regra global do FORGE ("não tocar o Scheduler sem
ordem expressa") **continua valendo fora do escopo desta feature** — a autorização é
escopada, não geral.

### D2 — Engine de disparo: **REUSAR o do Scheduler** (não reimplementar no LM)
Agendamento e disparo em massa com regras anti-bloqueio **já são o produto do Scheduler**.
O LM **não** reimplementa essa lógica; ele **chama o Scheduler** via API interna para
enfileirar campanhas. Fonte única das regras anti-ban = menor risco de bloqueio do número.
Duplicar essa lógica em dois serviços é o maior risco operacional e fica **proibido**.

## 3. O que já existe (reuso — não reconstruir)

| Capacidade | Onde |
|---|---|
| Ingestão WhatsApp + IG DM + Messenger + Meta Lead Ads | `webhook.js`, `webhook-meta.js`, `metaIngest.js` |
| `conversations.channel` + `leads.origem` **imutável** (first-touch) | migr. 043, 015 |
| Roteamento multi-plataforma genérico `tenant_lead_source` | migr. 041 |
| Editar / apagar mensagem (inbound + staff outbound) | migr. 063–066 |
| Outbound humano (staff outbound) | `staffSamples.js`, migr. 010 |
| Gate lead vs. contato conhecido + shadow log | `bolaGate.js`, `known_contacts`, migr. 055 |
| Multi-tenant RLS, Redis `lm:`, Z-API/Evolution | infra base |

## 4. O que é novo

- **Grupos e Comunidades** (o LM é 1:1 hoje) — endpoints de grupo da Z-API + modelo de
  participantes. Maior incógnita técnica e de política.
- **UI de inbox 3 painéis** (esq: contatos/grupos/comunidades · centro: thread · dir:
  arquivos rápidos + mensagens prontas).
- **Arquivos de acesso rápido** e **biblioteca de mensagens prontas** (com variáveis
  `{{nome}}`) como painéis de 1º nível.
- **Camada Waseller** (agendamento + massa) via **reuso** do engine do Scheduler (D2).
- **Projeção de "é lead ativo"** no inbox (pill LEAD) + badge de **fonte** por conversa.

## 5. Modelo de dados (migrations aditivas, schema `lead_manager`)

> **⚠️ Reconciliação com o código real (contrato ARC-042, 2026-07-28).** A revisão
> arquitetural achou 3 premissas erradas nesta seção — corrigidas abaixo. Detalhe em
> `docs/adr/ARC-042-contrato-inbox-fase1.md`.

- **Dois flags distintos, não um.** O §5 original confundia:
  - `is_lead` = **gate** (lead vs. não-lead; `known_contacts`/`bolaGate.js`). Separa quem
    entra no funil de quem é staff/aluno/fornecedor.
  - `is_lead_ativo` = **ciclo de vida** (régua canônica ADR-041 / `lifecycle.js`). É o que
    acende o **pill "LEAD"**. NÃO é trivialmente projetável: depende de `max(received_at)`
    + `tenant_lead_config.dormancy_days` e **muda só com o tempo** → **calculado no
    endpoint** reusando os fragmentos de `lifecycle.js` (não materializar, não view).
- **`fonte`** = `COALESCE(leads.origem, conversations.channel)` — `leads.origem` só existe
  para leads; não-lead cai no canal da conversa.
- **Outbound NÃO está em `messages`.** A thread é **UNION de 3 fontes** (inbound
  `messages` + `staff_outbound_samples` + IA `pending_approvals`) — já implementada em
  `tenant.js:892–1009`. Reusar, não recriar.
- **Sem FK conversa↔lead.** O vínculo é por **dígitos** de `conversations.external_id` vs
  `leads.phone/meta_psid` (`regexp_replace(...,'[^0-9]','','g')`). Intra-tenant, sob RLS.
- **`nao_lidas` é estado NOVO** — não há rastreio de "lido" no schema. **Migration 080**
  (próximo livre): `conversations.last_read_at` — **compartilhado por tenant** (caixa
  compartilhada, decisão de Leo 2026-07-28), não por operador.
- `conversations.conversation_kind`: `DIRECT | GROUP | COMMUNITY` (Fase 3).
- `groups` (jid/grupo, nome, tenant) + `group_members` (**telefone + LID** — LID p/
  estabilidade quando o número é privado; Fase 3).
- `quick_files` (arquivo rápido por tenant — reusa `resources`/uploads).
- `canned_messages` (texto + variáveis + categoria).
- Disparo: **sem** tabela de campanha própria no LM (D2) — apenas `dispatch_ref`
  (id da campanha no Scheduler) para rastreio/auditoria.

## 6. Contrato de API interna LM ↔ Scheduler (a detalhar na Fase 4)

Direção **LM → Scheduler** (o LM é cliente; o Scheduler é dono das regras anti-ban):
- `POST /internal/dispatch/schedule` — enfileira envio agendado/massa (tenant, alvos,
  template/mensagem, janela, throttling). Retorna `campaignId`.
- `GET  /internal/dispatch/:campaignId` — status (enfileirado/enviando/concluído/erro).
- Webhook **Scheduler → LM** de progresso (por alvo enviado) para refletir no inbox.
- Autenticação serviço-a-serviço (ver ADR-005 — session-exchange/BFF); tenant isolado.

> A modelagem fina do payload e das regras anti-bloqueio pertence ao Scheduler e será
> especificada com BRIDGE + o dono do Scheduler antes da Fase 4.

## 7. Fases

| Fase | Entrega | Épico | Depende de |
|---|---|---|---|
| **0** | Este ADR + contrato de API + modelo de dados travados | — | D1, D2 ✅ |
| **1** | "Descartados"→"Mensagens": UI 3 painéis + receber/responder/editar/apagar em conversas **diretas WhatsApp**, badge de fonte + pill LEAD | **E12** | Fase 0 |
| **2** | Painéis laterais: arquivos de acesso rápido + mensagens prontas | **E13** | E12 |
| **3** | Grupos & Comunidades (ingestão + envio Z-API, participantes) | **E14** | E12 |
| **4** | Waseller: agendamento + disparo em massa via engine do Scheduler | **E15** | E12, contrato §6 |
| **5** | Omnichannel pleno no inbox: IG DM + Messenger (envio por canal — ADR-007) e Google depois | **E16** | ADR-007, E12 |

Sequência recomendada: **0 → 1 → 2 → 3 → 4 → 5**. A Fase 1 já entrega valor sozinha
(recepção responde qualquer conversa dentro do Regente).

## 8. Riscos

- **Ban do número WhatsApp** — mitigado só por D2 (regra anti-ban única no Scheduler).
  Reimplementar disparo no LM está proibido justamente por isso.
- **Política Meta/WhatsApp** — grupos/comunidades e disparo em massa fora da Cloud API
  oficial têm risco de política; validar antes da Fase 3/4.
- **LGPD** — inbox omnichannel amplia a base de dados pessoais; herda opt-in/opt-out
  (migr. 011, consent) e o direito ao esquecimento `/forget`.
- **Guardrail de supervisão** — nada de envio automático ao cliente antes da recepção
  onboarded e do centro de controle (ADR-006) definir MANUAL/SEMI/AUTO por tipo de ação.
- **Escopo da autorização D1** — editar o Scheduler é liberado **só** para esta feature;
  qualquer toque fora dela volta a exigir ordem expressa.

## 9. Pontos em aberto (decidir na implementação)

- Identidade de grupo vs. identidade de pessoa (dedup cross-canal — herda §2.4 do ADR-007).
- Envio por canal Meta (Send API, janela 24h, templates) — depende de ADR-007 sair de
  "pendente".
- Google: qual produto (Business Profile messaging vs. lead forms de Ads) — ADR-007 §3.
- Como o pill "LEAD" reage quando uma conversa comum vira lead no meio do fio (transição
  pela régua canônica ADR-041).

## 10. Próximos passos

1. Backlog NOVA: quebrar **E12–E16** em stories com complexidade e dependências.
2. Especificar o contrato §6 com BRIDGE + dono do Scheduler.
3. Gerar prompts FORGE (ARC/NEON/CORE/BRIDGE) com o contexto desta feature.
