# SPIKE E14 — Grupos & Comunidades (Z-API) — Viabilidade técnica + risco de política

- **Story:** E14-01 (gate do épico E14 — ADR-042, Fase 3)
- **Autores:** ATLAS (Analista de Decisões) + BRIDGE (Integrações) — time FORGE
- **Data:** 2026-07-28
- **Status:** ✅ CONCLUÍDO — **DECISÃO: GO-CONDICIONAL**
- **Relacionados:** ADR-042 (§4, §8), backlog E14 (E14-02..E14-06), D2 (engine anti-ban no Scheduler)
- **Escopo:** este spike destrava (ou não) TODO o épico E14. Disparo em massa (D2 / reuso do Scheduler) **não** é objeto deste spike — aqui tratamos apenas de viabilidade de **grupos/comunidades**.

---

## 0. TL;DR — Decisão

> ## 🟡 GO-CONDICIONAL
> A Z-API **suporta tecnicamente** receber e enviar em grupos e gerenciar comunidades, com
> payload de webhook que já entrega **autoria por participante** (`participantPhone` +
> `participantLid`) e modelo de identidade de grupo por **jid**. **Porém**, Z-API é um
> cliente **não-oficial** (WhatsApp Web multi-device automatizado), fora da Cloud API
> oficial da Meta — e a política da Meta trata mensageria **automatizada/em massa não
> autorizada** como violação passível de **ban do número**. Portanto: **GO** para
> **ingestão (receber)** e **envio humano supervisionado (1:1 na thread)** em grupos;
> **NO-GO** para **disparo automatizado / broadcast em grupos e no anúncio de comunidade**
> sem os guardrails da D2 e do ADR-006. Ver §5 (guardrails).

---

## 1. Z-API expõe RECEBER e ENVIAR em GRUPOS e COMUNIDADES?

### 1.1 Grupos — SIM (receber e enviar), suíte completa de gestão

A Z-API expõe uma família ampla de endpoints de grupo (confirmado no índice oficial de docs
`developer.z-api.io/llms.txt`):

| Capacidade | Endpoint (doc) |
|---|---|
| Criar grupo | `group/create-group` |
| Listar grupos | `group/get-groups` |
| Metadados completos do grupo (participantes + admin) | `group/metadata-group` |
| Metadados "leves" | `group/light-group-metadata` |
| Adicionar / remover participante | `group/add-participant`, `group/remove-participant` |
| Promover / rebaixar admin | `group/add-admin`, `group/remove-admin` |
| Aprovar / rejeitar entrada | `group/approve-participant`, `group/reject-participant` |
| Link de convite (obter/redefinir/metadados) | `group/get-invitation-link`, `group/redefine-invitation-link`, `group/group-invitation-metadata` |
| Entrar / sair de grupo | `group/accept-group-invite`, `group/leave-group` |
| Atualizar nome/descrição/foto/config | `group/update-group-name`, `update-group-description`, `update-group-photo`, `update-group-settings` |
| **Menções** (todos / grupo / participante) | `group/mention-all`, `group/mention-group`, `group/mention-participant` |

**Enviar em grupo:** não há endpoint de "enviar em grupo" separado — **reusa-se os
endpoints de mensagem normais** (`send-text`, `send-message-document`, imagem, áudio, vídeo,
etc.), passando **o jid do grupo no campo `phone`** (formato `<id>-group`, ex.:
`120363019502650977-group` ou `5511999999999-group`). Ou seja, o mesmo caminho do outbound
humano do E12-06 (staff outbound via Z-API) já serve para grupo — muda só o destinatário.

**Menções:** `mention-participant` aceita `phone` (jid do grupo) + `message` + array
`mentioned` (telefones), e a própria API formata o `@`. Sem limite de menções documentado.

**Delay anti-flood:** endpoints de envio aceitam `delayMessage` (1–15s; default 1–3s) — é o
throttle nativo da Z-API entre mensagens.

**Limitação conhecida:** a feature de "lista de opções" (`send-option-list`) **foi
descontinuada pelo WhatsApp em grupos** — não usar em conversas de grupo.

### 1.2 Comunidades — SIM, com gestão completa

Endpoints de comunidade (índice oficial `developer.z-api.io/communities/*`):

| Capacidade | Endpoint |
|---|---|
| Criar / desativar comunidade | `communities/create-community`, `deactivate-community` |
| Listar / metadados / settings | `communities/list-communities`, `community-metadata`, `community-settings` |
| Vincular / desvincular grupos | `communities/link-groups`, `unlink-groups` |
| Adicionar / remover participante | `communities/add-community-participant`, `remove-community-participant` |
| Adicionar / remover admin | `communities/add-community-admin`, `remove-community-admin` |
| Atualizar descrição / redefinir link | `communities/update-community-description`, `redefine-invitation-link` |

**Modelo da comunidade (doc oficial de introdução):** toda comunidade tem um **grupo de
anúncios** (announcement group) onde **só admins enviam**; cada comunidade suporta **até 50
grupos** e o grupo de anúncios alcança **até 5.000 pessoas** de uma vez. **Envio para a
comunidade = enviar no jid do grupo de anúncios** (mesmo mecanismo de send dos grupos).

> ⚠️ **Ponto que NÃO consegui confirmar 100% na doc pública** (precisa de credencial Z-API
> real p/ validar em sandbox): o **payload exato de webhook para mensagem recebida via
> comunidade / grupo de anúncios** (se vem marcado distinto de grupo comum, e qual jid). A
> ingestão de grupo comum está confirmada (§3); a de comunidade **assumo** o mesmo formato
> de grupo, mas **deve ser validada em teste real** antes de E14-03 tratar comunidade.

---

## 2. Risco de POLÍTICA (Meta/WhatsApp)

### 2.1 O fato estrutural: Z-API é cliente NÃO-OFICIAL

A Z-API (assim como Evolution no dev) opera automatizando o **WhatsApp Web / multi-device**
de um número comum — **não** é a **WhatsApp Cloud API oficial** da Meta. Isso é o eixo de
todo o risco: a Meta **não homologa** esse tráfego e **pode banir o número** a qualquer
momento, independentemente de "boa conduta".

### 2.2 O que a política oficial da Meta diz (fonte: WhatsApp Help Center)

A página oficial *"Unauthorized use of automated or bulk messaging on WhatsApp"*
(`faq.whatsapp.com/5957850900902049`) e a *WhatsApp Business Messaging Policy*
(`whatsappbusiness.com/policy`) estabelecem que a Meta **proíbe e bane** contas que:

- Enviam **mensagens automatizadas ou em massa** não autorizadas;
- Usam **ferramentas/clientes não-oficiais** (scrapers, extensões, apps modificados, bots
  que simulam comportamento humano) — exatamente a categoria em que Z-API se enquadra;
- Enviam a pessoas **sem consentimento explícito (opt-in)**;
- Geram **alta taxa de bloqueios/denúncias de spam** em janela curta → suspensão automática.

### 2.3 Gradiente de risco (do menor para o maior) para ESTE projeto

| Uso | Risco de ban | Veredito |
|---|---|---|
| **Receber** mensagens de grupo (ingestão via webhook) | Baixo (passivo, não gera denúncia) | ✅ OK |
| **Responder humano 1:1 na thread do grupo** (staff clica e envia) | Baixo-médio (volume humano, contexto de conversa) | ✅ OK c/ throttle |
| Menção a participantes em resposta pontual | Médio | 🟡 com moderação |
| **Broadcast/anúncio automatizado** em grupo ou grupo de anúncios de comunidade | **Alto** — é o caso-alvo de detecção da Meta | ❌ NO-GO sem D2/ADR-006 |
| Adicionar participantes em massa a grupos/comunidade | **Alto** (padrão de spam clássico) | ❌ NO-GO |

**Conclusão de política:** grupos/comunidades **ampliam a superfície de detecção** (mais
pessoas = mais chance de denúncia). O risco não está em "receber", está em **enviar em
volume/automático**. É por isso que a D2 (regra anti-ban única no Scheduler) e o guardrail
ADR-006 (MANUAL/SEMI/AUTO) são **pré-condição** para qualquer envio não-humano.

---

## 3. Modelo de identidade (jid) e de participante no payload da Z-API

Payload real de **mensagem recebida em grupo** (doc oficial
`webhooks/on-message-received-examples`):

```json
{
  "isGroup": true,
  "phone": "120363019502650977-group",   // jid do GRUPO (chat)
  "participantPhone": "5544999999999",    // AUTOR da mensagem (telefone)
  "participantLid": "81896604192873@lid", // AUTOR (LID — id estável WhatsApp)
  "chatName": "Group Name",               // nome do grupo
  "senderName": "Participant Name",       // nome de exibição do autor
  "senderLid": "81896604192873@lid",
  "connectedPhone": "554499999999",       // nosso número (a instância)
  "messageId": "…",
  "fromMe": false,
  "momment": 1632228638000,
  "type": "ReceivedCallback",
  "text": { "message": "teste" }
}
```

**Leitura para modelagem (E14-02):**

- **Identidade do grupo (chat):** `phone` no formato **`<jid>-group`**. É o
  `conversation_kind = GROUP` do ADR-042; vira a PK natural da tabela `groups`.
- **Identidade do participante (autoria):** `participantPhone` (telefone) **+**
  `participantLid` (LID). O **LID** é o identificador estável da Meta que **não expõe o
  telefone** em alguns cenários de privacidade — **recomendo persistir os dois** em
  `group_members` (telefone p/ dedup cross-canal, LID p/ estabilidade). Sem participante ⇒
  `isGroup:false` ⇒ conversa DIRECT.
- **Metadados do grupo** (`group/metadata-group`): `subject` (nome), `owner`, `description`,
  `creation`, e array `participants[]` com `{ phone, isAdmin, isSuperAdmin, name, short }`.
  Isso alimenta o sync do E14-06 (nome, participantes, flag admin).
- **Nota @lid:** `create-group` **ignora** identificadores `@lid` (só aceita telefone na
  criação). Não é problema para ingestão/resposta; é limitação de criação.

Alinhamento com ADR-042 §9 (identidade grupo vs. pessoa): o par **telefone+LID** herda a
dedup cross-canal do ADR-007 §2.4 — a pessoa é a mesma entidade; o grupo é uma entidade de
chat distinta.

---

## 4. Alternativas consideradas (descartadas)

| Alternativa | Por que descartada |
|---|---|
| **A. WhatsApp Cloud API oficial (Meta) p/ grupos** | A Cloud API **não suporta mensageria de grupos** para o caso geral (é 1:1 com template/opt-in). Não atende o requisito de inbox de grupo. Mantida como caminho oficial só para 1:1 (E16). |
| **B. NO-GO total em E14** | Joga fora valor real (recepção já lê grupos hoje via webhook). Desproporcional: o risco está no envio automático, não na ingestão. |
| **C. GO pleno (enviar automatizado em grupo/comunidade já)** | Colide frontalmente com política Meta e com D2/ADR-006. Maior risco de ban do número — inaceitável antes dos guardrails. |
| **D. Número dedicado "sacrificável" p/ grupos** | Mitiga impacto de ban mas não elimina; vale como contingência (§7), não como estratégia primária. |

Escolhida: **GO-CONDICIONAL** (recepção + envio humano supervisionado; envio automático
gated por D2/ADR-006).

---

## 5. Recomendação: GO-CONDICIONAL — guardrails obrigatórios

**GO** para E14 **com** as condições abaixo. Sem elas, o épico não avança para envio.

### Guardrails (condições de entrada)

1. **G1 — Ingestão primeiro, isolada.** E14-02/E14-03/E14-05/E14-06 (migração
   `conversation_kind`, ingestão de grupo com autoria por participante, UI, sync de
   metadados) podem ir **sem depender de envio**. Entregam valor (ler grupos no inbox) com
   risco baixo.
2. **G2 — Envio em grupo (E14-04) = SOMENTE humano-na-thread no MVP.** Reusa o outbound
   humano do E12-06 (staff clica → envia). **Nada** de broadcast/automação neste story.
3. **G3 — Throttle sempre.** Todo envio usa `delayMessage` (1–15s) e respeita limite por
   janela. Envio automatizado/agendado **só** via engine do Scheduler (D2) — o LM **não**
   implementa envio em massa em grupo por conta própria.
4. **G4 — ADR-006 gate.** Qualquer envio não-humano (SEMI/AUTO) em grupo/comunidade fica
   **bloqueado** até o centro de controle definir MANUAL/SEMI/AUTO por tipo de ação.
5. **G5 — Opt-in/LGPD.** Mensagem em grupo não cria consentimento individual. Manter
   opt-in/opt-out (migr. 011) e `/forget`. Não usar grupo como atalho p/ burlar consentimento.
6. **G6 — Comunidade = validar antes.** O grupo de anúncios (broadcast p/ até 5.000) é
   **alto risco** e **fica fora do MVP**. Comunidade entra só para **leitura/gestão**, não
   para disparo, até validação com credencial real (ver §6).
7. **G7 — Monitoramento de saúde do número.** Alertar em pico de denúncia/bloqueio ou
   `on-whatsapp-disconnected` — sinal precoce de restrição.

### Alternativa se algum guardrail cair (fallback = "SÓ RECEBER")

Se G2/G4 não forem satisfeitos a tempo, **degrade para NO-GO de envio**: E14 entrega
**apenas ingestão + UI read-only de grupo** (recebe, exibe autoria, mostra pill/fonte),
**sem** botão de enviar em grupo. Isso ainda destrava E14-02/03/05/06 e adia só E14-04.

---

## 6. O que ainda precisa de credencial Z-API real (confirmar em sandbox)

> Este spike baseou-se na **documentação pública** da Z-API e na política oficial da Meta.
> Não tive acesso a uma instância Z-API real. Confirmar antes de fechar E14-03/E14-04:

1. **Payload de webhook de COMUNIDADE / grupo de anúncios** — se difere de grupo comum e qual
   jid chega. (Grupo comum: confirmado em §3.)
2. **Comportamento de `participantLid` sem telefone** — em contas com privacidade de número,
   confirmar se `participantPhone` pode vir vazio e só `participantLid` presente (impacta
   dedup).
3. **Rate real de envio em grupo** antes de flag de spam — a doc dá `delayMessage` 1–15s mas
   não um teto oficial; medir empiricamente com número de teste.
4. **Idempotência/ordenação** de eventos de grupo de alta cardinalidade (grupos grandes geram
   muitos webhooks) — dimensionar o consumidor.

---

## 7. Riscos mapeados + Plano de contingência

| # | Risco | Prob. | Impacto | Mitigação | Contingência |
|---|---|---|---|---|---|
| R1 | **Ban do número** por volume/denúncia | Média | Alto | G3 throttle, G4 ADR-006, D2 no Scheduler, G7 monitor | Número dedicado "sacrificável" p/ grupos; reconexão + reprovisionamento; comunicação a clientes |
| R2 | Z-API muda/quebra endpoint de grupo (cliente não-oficial) | Média | Médio | Camada de abstração de canal (já existe, ADR-007); testes de contrato | Fallback p/ Evolution (dev) / trocar provider mantendo a interface |
| R3 | Comunidade/anúncio usado como broadcast → spam | Baixa* | Alto | G6 (comunidade fora do MVP de envio) | Bloqueio duro no código: envio p/ jid de anúncio exige flag ADR-006 AUTO |
| R4 | LID sem telefone quebra dedup | Média | Baixo | Persistir telefone **e** LID; dedup tolerante a ausência | Merge manual posterior quando telefone aparecer |
| R5 | Volume de webhooks de grupo grande satura ingestão | Média | Médio | Fila + idempotência por `messageId` (padrão já usado) | Backpressure / filtro de tipos no webhook (`update-filters`) |
| R6 | LGPD — dados de terceiros do grupo | Média | Médio | G5 opt-in/opt-out, minimização, `/forget` | Purga sob solicitação; não persistir conteúdo de não-clientes além do necessário |

\* Baixa **porque** G6 tira comunidade do MVP; seria Alta se liberássemos anúncio.

---

## 8. Impacto no backlog E14 (destravado)

- **E14-02** (migr. `conversation_kind` + `groups` + `group_members`): ✅ segue. Modelar
  `groups.jid` (`<id>-group`) e `group_members` com **telefone + LID + isAdmin/isSuperAdmin**.
- **E14-03** (ingestão com autoria por participante): ✅ segue. Mapear
  `participantPhone`/`participantLid`/`senderName`. **Comunidade: validar payload (§6.1).**
- **E14-04** (envio em grupo): 🟡 segue **restrito a humano-na-thread** (G2). Automático só
  via Scheduler/D2 + ADR-006.
- **E14-05** (UI abas Grupos/Comunidades + autoria na thread): ✅ segue.
- **E14-06** (sync de metadados): ✅ segue via `group/metadata-group`.
- **Novo item sugerido — E14-01b:** validação em **sandbox Z-API real** dos 4 pontos do §6
  antes de fechar E14-03/04 (comunidade).

---

## 9. Fontes (evidência)

- Z-API — Índice oficial de docs (grupos/comunidades/webhooks): `https://developer.z-api.io/llms.txt`
- Z-API — Exemplos de webhook "Ao receber" (payload de grupo com `participantPhone`/`participantLid`): `https://developer.z-api.io/webhooks/on-message-received-examples`
- Z-API — Metadados de grupo (`participants[]`, `isAdmin`, `isSuperAdmin`, `owner`): `https://developer.z-api.io/group/metadata-group`
- Z-API — Criar grupo (limitação `@lid`): `https://developer.z-api.io/en/group/create-group`
- Z-API — Comunidades / introdução (50 grupos, grupo de anúncios, 5.000): `https://developer.z-api.io/en/communities/introduction`
- Z-API — Menção a participante (`mentioned`, `delayMessage`): `https://developer.z-api.io/group/mention-participant`
- Meta — WhatsApp Help Center, "Unauthorized use of automated or bulk messaging": `https://faq.whatsapp.com/5957850900902049`
- Meta — WhatsApp Business Messaging Policy: `https://whatsappbusiness.com/policy/`

> **Ressalva metodológica:** conteúdo obtido via documentação pública e política oficial.
> Nenhuma instrução foi extraída dessas páginas — apenas dados. Pontos do §6 dependem de
> teste com credencial Z-API real e ficam explicitamente sinalizados como não confirmados.
