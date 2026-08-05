# Diagnóstico — total de "não-lidas" inflado no inbox (`/inbox/nao-lidas`)

**Data:** 2026-08-05 · **Sintoma:** `/tenant/:tid/inbox/nao-lidas.total` inflado (ex.: Valinhos ~806), e badges azuis por-conversa altos (ex.: 28 numa conversa). O badge "Caixa de Entrada" do dashboard Regente lê esse total.

> Nota: o lado do **dashboard** já foi corrigido (passou a exibir o valor do LM). A fonte do número é o **Lead Manager** — é aqui que corrigimos.

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

---

## O que a Evolution expõe sobre "leitura" (investigação)

- `messages.update` com `status` READ/PLAYED/4/5 → hoje mapeado só para o ack do **nosso outbound** (`_mapAck`, `atualizarAckStatus`). Não diz respeito a inbound lido pela recepção.
- **Sinal candidato para leitura do dono:** `chats.update` (Evolution `CHATS_UPDATE`) carregando `unreadCount`. No multi-device, quando o dono lê um chat no WhatsApp Web, o `unreadCount` daquele chat zera e um `chats.update` é emitido. **A confirmar na instância Evolution do tenant** (depende de o evento estar habilitado no webhook — config externa, não está neste repo).
- Endpoint Evolution `POST /chat/markMessageAsRead/:instance` existe, mas **não está fiado** no `evolution.js`.

---

## Plano

### Fase 1 — desinflar já (feito neste branch, sem depender da Evolution)

1. **Importador marca lido** ([`src/importHistorico.js`](../src/importHistorico.js)): ao importar, avança `last_read_at` até o inbound mais novo da leva (GREATEST, monotônico). Histórico importado deixa de contar como não-lido; não-lidas legítimas posteriores (received_at > cursor) seguem contando.
2. **Backfill do acervo já importado** (migr. [`090_backfill_last_read_historico.sql`](../db/migrations/090_backfill_last_read_historico.sql)): avança `last_read_at` até a mensagem `raw.source='historico'` mais nova de cada conversa. Conservador (só histórico) e monotônico — não esconde não-lidas reais.
3. Testes: [`test/import-historico.itest.js`](../test/import-historico.itest.js) casos (6) e (7).

**Deploy da Fase 1:** deploy do código + rodar a migração manual (padrão do repo, sem runner):
```
docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f db/migrations/090_backfill_last_read_historico.sql
```

### Fase 2 — propagar leitura do WhatsApp Web (pendente; precisa de você)

1. **Habilitar `chats.update` (unreadCount)** no webhook da instância Evolution do tenant.
2. **Handler** em [`src/routes/webhook.js`](../src/routes/webhook.js): quando `chats.update` trouxer `unreadCount === 0` (ou diminuir), avançar `conversations.last_read_at = now()` da conversa correspondente (casar por `remoteJid`/external_id).
3. **(Opcional) mão dupla:** quando a recepção lê no LM, chamar `markMessageAsRead` na Evolution para zerar também no WhatsApp Web.

> Fase 2 foi deixada fora do código por depender de config externa (evento na Evolica) — scaffoldar agora seria código morto até o evento existir.

---

## Coordenação

Feito num branch isolado (`fix/inbox-nao-lidas-historico`, worktree próprio) a partir do `main`, **sem push e sem tocar o checkout principal**. Há uma sessão paralela no mesmo tema ("Lead Manager unread count sync") — este doc serve de base comum. Só uma sessão deve editar `inbox.js`/`webhook.js`/`importHistorico.js` para evitar conflito.
