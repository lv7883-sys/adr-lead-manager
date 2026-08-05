# Diagnóstico — total de "não-lidas" inflado no inbox (`/inbox/nao-lidas`)

**Data:** 2026-08-05 · **Sintoma:** `/tenant/:tid/inbox/nao-lidas.total` inflado (ex.: Valinhos ~806), e badges azuis por-conversa altos (ex.: 28 numa conversa). O badge "Caixa de Entrada" do dashboard Regente lê esse total.

> Nota: o lado do **dashboard** já foi corrigido (passou a exibir o valor do LM). A fonte do número é o **Lead Manager** — é aqui que corrigimos.

> **Status — RESOLVIDO em produção (2026-08-05).** Fase 1 (histórico) + Fase 2 (evento de leitura do WhatsApp Web) + reset do acervo (migr. 091). Badge Valinhos: **806 → 954 → 0**. Detalhes na seção **[Resolução](#resolução-entregue-e-verificada-em-produção--2026-08-05)**. As seções de diagnóstico abaixo ficam como registro do raciocínio.

---

## Como o LM define "não-lida" (é derivado, não é flag)

Não existe coluna de "lida" por mensagem. Tudo sai de **um cursor por conversa**, `conversations.last_read_at` (migr. `080`, ADR-042):

```
nao_lidas(conversa) = count(messages role='USER' WHERE received_at > last_read_at)
last_read_at IS NULL  ⇒  TODAS as mensagens da conversa contam como não-lidas
```

- Total do nav: [`src/routes/inbox.js:589`](../src/routes/inbox.js) — **soma mensagens** (não conversas) e exclui grupos (`@g.us`).
- Badge por-conversa: [`src/routes/inbox.js:222`](../src/routes/inbox.js) — mesmo cálculo, mas **inclui** grupos.
- Marca lido só quando a recepção abre a conversa **dentro do LM** e o front chama `POST /marcar-lido` ([`inbox.js:291`, `609`](../src/routes/inbox.js)). Abrir o thread **não** auto-marca.

## As 3 causas

**① Histórico importado conta como não-lido (causa dominante do salto).**
O importador (Fase B, commit `ec1c5c5`) insere mensagens antigas como `role='USER'` mas **não setava `last_read_at`** ([`src/importHistorico.js`](../src/importHistorico.js)). Com o cursor `NULL`, todo o backfill vira não-lido. Uma conversa com 28 mensagens históricas mostra "28". O import recente do Valinhos explica o salto para ~806.

**② Ler no WhatsApp Web não volta pro LM (a causa que o dono descreveu).**
As recepcionistas leem no WhatsApp Web; esse "lido" não sincroniza pro LM. O webhook só trata `messages.update` para o **ack das NOSSAS mensagens enviadas** (✓✓ em `staff_outbound_samples`) e edição/exclusão ([`src/routes/webhook.js:360`](../src/routes/webhook.js)). **Não há handler algum de "o dono leu essa conversa em outro aparelho".** Também não existe `markMessageAsRead` em [`src/evolution.js`](../src/evolution.js) — o LM nunca manda read receipt.

**③ Divergência de grupos (menor).** O total exclui grupos; o badge por-conversa inclui. Total e soma dos badges não reconciliam.

> **Verificado em produção (05/ago):** aqui a causa **① não existiu** — o importador de histórico nunca rodou nesta instância (`raw.source='historico'` = 0 mensagens, e a migr. 090 deu `UPDATE 0`). O 806/954 era **100% causa ②**. A Fase 1 seguiu válida (blinda import futuro), mas não movia o número do Valinhos.

---

## O que a Evolution expõe sobre "leitura" — VERIFICADO em produção (05/ago)

- **`findChats` (PULL) — sem fonte.** `POST /chat/findChats/{instance}` responde e traz o campo `unreadCount`, mas o valor vem **`null`** em todas as conversas (inclusive numa não-respondida). A Evolution não rastreia unread nesta instância → espelhar `unreadCount` não funciona. (Também só devolveu 54 chats vs 507 conversas no LM.)
- **`chats.update` (PUSH via unreadCount) — inviável** pelo mesmo motivo (mesma instância, `unreadCount` null).
- **Read-receipt do inbound (o que FUNCIONOU):** ler uma conversa no WhatsApp Web propaga um `messages.update` com `status:READ` e **`key.fromMe=false`** (recibo de leitura do INBOUND; `fromMe=true` é o cliente lendo a NOSSA msg = ack de entrega, já tratado). O payload traz os campos no **topo** do `data` (`keyId`, `remoteJid`, `fromMe`, `status`), NÃO em `.key`; o `remoteJid` vem como `@lid`.
- **Casamento certo = por ID.** O `keyId` do recibo é o id do WhatsApp da mensagem = `messages.external_message_id`. Casar `keyId → external_message_id → conversation_id` é imune à ambiguidade `@lid`/telefone.

> **Nota `@lid`:** as conversas do LM são chaveadas por telefone em formato inconsistente (`+5519…` E.164 e `5519…`). Um susto inicial de "proliferação `@lid`" foi **falso alarme** — o `+` enganou um regex `^55`. Não há duplicação por lid; é só hygiene menor de formato (o strip de dígitos absorve no casamento).

---

## Resolução (entregue e verificada em produção — 2026-08-05)

### Fase 1 — histórico não conta como não-lido
- [`src/importHistorico.js`](../src/importHistorico.js): o import avança `last_read_at` até o inbound mais novo da leva (GREATEST, monotônico).
- migr. [`090`](../db/migrations/090_backfill_last_read_historico.sql): backfill conservador do acervo histórico (só `raw.source='historico'`).
- Testes: [`test/import-historico.itest.js`](../test/import-historico.itest.js) casos (6)/(7) — 7/7 verde (runner [`test/run-import-historico-itest.sh`](../test/run-import-historico-itest.sh)).
- Em prod deu `UPDATE 0` (não havia histórico aqui) — correto e inofensivo; blinda import futuro.

### Fase 2 — leitura no WhatsApp Web volta pro inbox (o fix do sintoma)
Handler `marcarLidoPorRecibo` em [`src/routes/webhook.js`](../src/routes/webhook.js): no `messages.update`, para cada recibo `status=READ` com `key.fromMe=false`, casa `keyId → messages.external_message_id → conversa` e avança `conversations.last_read_at` (GREATEST — monotônico, preserva não-lida de inbound posterior ainda não lido). Só mexe no cursor de leitura (isolado do funil/lead). Loga `inbox.read_synced`. Parser coberto por testes de unidade com payloads REAIS em [`test/webhook.test.js`](../test/webhook.test.js). **Q1 (o evento de leitura chega ao LM?) foi verificado em produção — chega e casa.**

### Reset do backlog — migr. 091
O handler só age dali pra frente; mensagens lidas ANTES do deploy não emitem recibo novo. migr. [`091`](../db/migrations/091_reset_backlog_nao_lidas.sql) marca cada conversa como lida até o inbound mais recente (`last_read_at = max(received_at)`, GREATEST/idempotente). Defensável: o badge é "não-VISTO", e a recepção já viu tudo no WhatsApp Web. Em prod: `UPDATE 175`.

### Resultado
Badge Valinhos: **806 → 954** (durante a investigação, subindo) **→ 0** após o reset. Agora é um número **vivo** (sobe com inbound novo, cai quando a recepção lê em qualquer aparelho), não mais inflação monotônica. Handler confirmado ativo (`inbox.read_synced` disparando).

### Mantido de propósito (não é código morto)
`findChats` foi fiado em [`src/evolution.js`](../src/evolution.js) durante a investigação (tentativa de PULL) e **mantido** — é o wrapper que o backlog **E11-01** (importar histórico do WhatsApp) vai precisar. `markMessageAsRead` (mão dupla LM→WhatsApp, marcar lido também no celular quando a recepção lê no LM) segue como melhoria opcional futura.

### Causa ③ (grupos) — segue aberta (menor)
Total exclui `@g.us`; badge por-conversa inclui. Divergência pequena, fora do escopo desta correção.

---

## Coordenação

Diagnóstico e Fase 1 nasceram no branch `fix/inbox-nao-lidas-historico`; a Fase 2 + reset foram consolidados direto no `main` (commits `0341a81`, `b1c6631`). A sessão paralela ("renovação D-10/D-2") segue no seu próprio branch, sem sobreposição de arquivos.
