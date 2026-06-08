# ADR-007 — Multicanal (Instagram, Facebook, Google)

- **Status:** 🚧 **PENDENTE — não implementado** (placeholder para revisão futura)
- **Data:** 2026-06-08
- **Autor:** rascunho de escopo (sessão Claude Code)
- **Relacionados:** ADR-003 (funil de triagem; Decisão 5 — abstração de canal e
  identidade cross-canal), E8-09 (abstração `ChannelAdapter` no backlog),
  [[no-auto-send-until-receptionists-onboarded]] (envio só sob supervisão).

> ⚠️ Este documento **registra escopo para revisão**, não uma decisão tomada.
> Nada aqui está implementado. Não usar como referência de comportamento atual.

> **Nota de numeração:** o backlog (`docs/backlog-adicional.md`, tabela "ADRs
> futuros") reservava **ADR-007** para "identidade unificada de contato
> cross-canal". Como identidade é **parte** do problema multicanal, este ADR-007
> **absorve** aquela reserva (ver §2.4). A dedup de pessoa cross-canal deixa de
> ser um ADR separado.

---

## 1. Contexto / motivação

Hoje o Lead Manager capta leads **apenas de WhatsApp**: a única porta de entrada é
o webhook `/webhook/zapi/:tenantId` (Z-API/Evolution), e o motor (`engine.js`)
cria toda conversa com `channel = 'whatsapp'` fixo. A identidade do lead é
**telefônica**: `leads.phone` é único por tenant e a conversa casa por
`external_id = phone`.

A Academia do Rock também recebe interessados por **Instagram Direct**,
**Facebook/Messenger** e **Google** (formulários de anúncio / mensagens do perfil
de negócio). Para esses entrarem no mesmo funil de triagem (classificar lead →
extrair dados → sugerir resposta → fila de aprovação), faltam três peças:
**ingestão por canal**, **identidade não-telefônica** e **envio por canal**.

O alicerce já ajuda: a tabela `conversations` tem a coluna **`channel`** (sem
restrição de valor) e o funil é genérico — não depende do conteúdo ser de
WhatsApp. O que falta é a borda (entrada/saída) e a identidade.

## 2. Escopo proposto (a detalhar)

### 2.1 Webhook de ingestão por canal
- Endpoint próprio por provedor, com verificação de assinatura/token própria:
  - **Instagram + Facebook/Messenger:** Meta Graph API / Messenger Platform
    (webhook único da Meta, eventos `messages`; exige app review e permissões
    `instagram_manage_messages` / `pages_messaging`).
  - **Google:** definir o produto (ver §3) — Google Business Messages foi
    **descontinuado pela Google em 2024**; alternativas: mensagens do Google
    Business Profile, ou ingestão de **lead forms** de Google Ads via webhook.
- Cada adaptador normaliza o payload para o formato interno de `processInbound`
  (reuso do `normalizeMessage`/`ChannelAdapter` — E8-09).

### 2.2 Identidade não-telefônica (canal + id externo)
- Generalizar a identidade do lead de **telefone** para **(channel, external_id)**.
  No IG/FB não há telefone — o identificador é um *page-scoped ID* (PSID/IGSID).
- `conversations` já é chaveada por `(tenant_id, channel, external_id)` — pronto.
  O gargalo é em `leads`: `phone` é único por tenant e várias queries casam por
  `phone` (inclusive a tela de leads do E3, que calcula `last_contact_at` juntando
  `messages` à conversa por `external_id = l.phone`). Propor:
  - tornar a chave de dedup do lead **(tenant, channel, external_id)**, com
    `phone` opcional (já é `nullable`; o índice `uq_leads_tenant_phone` é parcial
    `WHERE phone IS NOT NULL`);
  - ajustar a query de leads para juntar por `(channel, external_id)` em vez de
    `phone`.

### 2.3 Adaptador de envio por canal
- `sendOutbound` por canal (parte da abstração `ChannelAdapter` — E8-09):
  - WhatsApp: Evolution/Z-API (caminho de envio ainda **não** implementado);
  - Meta: Send API, respeitando a **janela de 24h** de mensagens e regras de
    template/opt-in.
- **Sujeito ao guardrail de supervisão**: nada de envio automático ao cliente
  antes de a recepção ter acesso e definir o que é automatizado
  ([[no-auto-send-until-receptionists-onboarded]]).

### 2.4 Identidade unificada de pessoa cross-canal (absorve o antigo ADR-007)
- Deduplicar **a mesma pessoa** aparecendo em WhatsApp + IG + FB (ex.: por sinais
  nome/e-mail, ou merge manual pela recepção). Decisão adiável até existir o **2º
  canal** — mas registrada aqui para não reaparecer como ADR solto.

## 3. Pontos em aberto (a decidir na implementação)

- **Modelo de dados de identidade:** chave `(tenant, channel, external_id)` em
  `leads` vs. tabela `lead_identities` (1 lead → N identidades por canal, já
  preparando a dedup de pessoa do §2.4).
- **Portão 0 (`known_contacts`)** é por telefone — para IG/FB precisa de
  identificadores por canal (ou casar na camada de pessoa, §2.4).
- **Meta (IG/FB):** app review, permissões, política de janela de 24h, opt-in.
- **Google:** qual produto exatamente (Business Profile messaging vs. lead forms
  de Ads) — escopo e viabilidade dependem disso.
- **Gating de assinatura (E9-05), ownership (E8-07) e auditoria** valem para
  todos os canais, não só WhatsApp.

## 4. Próximos passos (quando priorizado)
- Promover este placeholder a ADR completo (opções/trade-offs por canal e por
  peça: ingestão, identidade, envio).
- Abrir E-stories: webhook Meta (IG+FB); generalização da identidade
  `(channel, external_id)` + ajuste da query de leads; `ChannelAdapter.sendOutbound`
  por canal; dedup de pessoa cross-canal; definição do canal Google.
- Resolver a numeração de ADR (ver nota no topo e em `backlog-adicional.md`).
