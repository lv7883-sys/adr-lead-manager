# ADR-031 — Fidelidade de captura de mensagens inbound/outbound (reação, sticker, view-once)
**Status:** Aceito (piso) | **Data:** 2026-07-02
**Contexto:** Recon de "mensagens parciais" (2026-07-02). Bugfix contido — NÃO é a frente "Regente como lar das mensagens" (ADR de fundação futuro).

---

## Tese central

O Regente captura fielmente texto, imagem, áudio, vídeo e documento. Mas `detectarMidia`
(`webhook.js`) só reconhece 4 tipos; todo o resto vira `body=null` → **bolha vazia** na
timeline. São 28 registros reais na Valinhos: 24 reações emoji, 3 stickers, 1 view-once. O
conteúdo NÃO se perde (o emoji da reação vive em `raw.reactionMessage.text`) — só nunca é
extraído pro `body`.

**Agravante (pior que a bolha vazia):** reações passam pelo Portão 2 sem o guard
`if(!msg.body) return` que os helpers têm (`engine.js:1426`). Prova: 28/28 desses registros
geraram resposta ASSISTANT em <20s + `pending_approvals`. Um 👍 do lead faz a IA gerar
**rascunho fantasma** que entra na fila da recepção. É isso que mais empurra a recepção pro
WhatsApp.

## Recon do patch (payloads reais verificados — 2026-07-02)

- **Reação inbound**: `data.message.reactionMessage.text` = emoji; `.key.id` = id da
  mensagem-alvo; `data.key.fromMe=false` (lead reagindo à nossa mensagem). "Un-reaction"
  vem com `text` vazio.
- **Alvo da reação** resolve em `staff_outbound_samples` (21/24) — quase nunca em `messages`
  (0/24): o lead reage ao que a **recepção** enviou. ⇒ exibição "grudada" precisa cruzar
  tabela ⇒ é **polimento**, não piso. O alvo já está no `raw` ⇒ **nenhuma migration** é
  necessária, nem agora nem no polimento.
- **Sticker**: `stickerMessage.mimetype = image/webp` ⇒ mapeia limpo para `kind:'image'`
  (baixa via `getBase64FromMediaMessage`, renderiza `<img>` — infra já existe).
- **View-once**: chega como `secretEncryptedMessage` (encIv/encPayload/targetMessageKey) —
  payload **cifrado**, não baixável ⇒ placeholder é o certo.
- **Reações de saída (fromMe)**: hoje **0 capturadas** — `captureOutbound` descarta por
  `!body && !media`. Item 1 (2 direções) as passa a capturar.

## O que este ADR NÃO faz (fronteira)

Não implementa: histórico retroativo (`findMessages`), mídia de saída do celular com
thumbnail, contato/localização, enviar reação/sticker de volta, decodificar view-once. Tudo
isso é a frente "lar das mensagens", ADR de fundação futuro. Aqui é só estancar bolha-vazia +
rascunho-fantasma no que JÁ deveria funcionar.

---

## Decisões

| # | Item | Decisão |
|---|---|---|
| 1 | Reação emoji (2 direções) | Extrair emoji pro `body` (`[reação] 🙏`) + guardar `reactionMessage.key.id` (via `raw`). Tratar lead→nós (inbound) E nós→lead (fromMe) — mesma causa. |
| 2 | Guard Portão 2 | Reação NÃO gera classificação/rascunho: short-circuit em `processInbound` → captura-only + `return`. Piso inegociável — mata o rascunho fantasma. |
| 3 | Renderização grudada | Meta: emoji no canto da bolha-alvo, igual ao WhatsApp, cruzando `staff_outbound_samples` pelo `key.id`. **Polimento** (deferido) — a captura (1+2) já garante que a reação não some nem estraga. |
| 4 | Sticker/figurinha | `stickerMessage` → `kind:'image'`, webp. Download e `<img>` já existem → passa a renderizar. |
| 5 | View-once | Placeholder `[mensagem de visualização única]` pra não ficar em branco. |

## Piso vs. polimento

- **Piso (entregue neste ADR):** captura da reação (1) + guard do Portão 2 (2) + sticker (4)
  + view-once (5). Estanca a sangria: sem bolha vazia, sem rascunho fantasma. **Só toca
  `webhook.js` + `engine.js`** — dashboard e schema intactos.
- **Polimento (deferido):** renderização grudada da reação (3), na timeline do dashboard.

## Pontos de mudança (piso)

- `webhook.js`: `detectarMidia` reconhece `stickerMessage` (→ image/webp); `normalizeMessage`
  extrai reação (`detectarReacao` → `{emoji, targetId}`), view-once (`_isViewOnce`) e expõe
  `msg.reaction`. Export de `normalizeMessage`/`detectarMidia` p/ teste. `fromMe`: não
  classifica saída quando é reação.
- `engine.js`: short-circuit de `msg.reaction` → `captureInboundOnly` + `return` (antes de
  qualquer classificação/rascunho).
- **Sem migration.** **Sem mudança no dashboard** (sticker cai no `<img>` existente; view-once
  e reação viram bolha de texto legível).

## Riscos

- Reação de 2 direções: o guard só dispara com `reactionMessage` no payload — não confunde com
  texto. "Un-reaction" (text vazio) não vira bolha.
- Staff reagindo: filtrado antes do short-circuit pelos gates de `internal_contacts`/papel
  (comportamento preservado).
- Sticker webp: `<img>` de navegadores modernos renderiza webp (ok).
