# Runbook — Validação E2E da Caixa de Entrada (ADR-042 / E12)

**Objetivo:** rodar dashboard + LM juntos e confirmar que a tela **Caixa de Entrada** conversa
de verdade com a API (`/tenant/:tid/inbox/*`). O backend está verificado (16 itests); o que
falta provar é a **costura frontend↔LM** (Service Token, tenant da franquia, `lmFetch`).

---

## ⚠️ 3 cuidados antes de começar

1. **Migration 080** precisa estar aplicada no banco do LM (adiciona `conversations.last_read_at`).
   Sem ela, a listagem do inbox dá erro 500.
2. **Rode o LM com o código NOVO** (minhas mudanças ainda não estão deployadas). O caminho seguro
   é subir o LM **localmente** a partir da working tree — não apontar o dashboard pra produção
   (`leads-api.leovecchi.com`), que ainda roda o código antigo (sem as rotas `/inbox`).
3. **Enviar mensagem dispara WhatsApp REAL** (via Z-API). Na hora de testar o envio, use **um
   contato/conversa que você controla**. Ler a lista e abrir a thread **não** envia nada.

---

## Passo 1 — Subir o LM local (porta 3002)

No `C:\dev\adr-lead-manager`, com um `.env` (ou `.env.claude-code`) apontando pro banco do piloto
(ou uma cópia/staging). Mínimo p/ ler lista+thread: `DATABASE_URL`, `JWT_SECRET`, `PORT=3002`.
Para **enviar**, também `ZAPI_*` e as credenciais Evolution do tenant no banco.

Aplicar a migration 080 (uma vez):
```bash
docker exec -i <container-pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f db/migrations/080_conversation_last_read.sql
```

Subir:
```bash
node src/server.js
```
Confirme: `GET http://localhost:3002/health` responde `{"status":"ok"}`.

## Passo 2 — Subir o dashboard local

No `C:\dev\adr-whatsapp-scheduler\dashboard`, com as envs (as mesmas que já fazem a console
`/leads` funcionar, só mudando a base do LM p/ o local):
```
DATABASE_URL=...              # banco do próprio dashboard (franquias/usuários)
LEAD_MANAGER_API_URL=http://localhost:3002
SERVICE_TOKEN=<o mesmo já usado hoje>     # já serve o /inbox (mesmo middleware das rotas de leads)
LEAD_MANAGER_TENANT_ID=<tenant do piloto> # ou a coluna lead_tenant_id da franquia
PORT=3001
```
> O `SERVICE_TOKEN` **não muda**: as rotas `/inbox` usam o mesmo `authenticate + requireTenantAccess`
> das rotas de leads que já funcionam. Se `/leads` abre hoje, `/inbox` autentica igual.

Subir:
```bash
npm start
```

## Passo 3 — Logar e abrir a tela

1. Acesse `http://localhost:3001/login` e entre com um usuário da recepção (email + senha).
2. Vá para a franquia do piloto.
3. No menu lateral (seção de captação), clique em **Caixa de Entrada** (`/f/<slug>/inbox`).

## Passo 4 — Checklist do que validar

**Lista (painel esquerdo)**
- [ ] Conversas carregam (lead **e** não-lead no mesmo fluxo).
- [ ] Filtros **Todas / Leads / Outras** trocam a lista.
- [ ] **Badge de fonte** (● WhatsApp) aparece por conversa.
- [ ] **Pill LEAD** aparece só em quem é lead; **verde** = lead ativo.
- [ ] **Contador de não-lidas** (bolinha azul) nas conversas com inbound novo.
- [ ] **Busca** por nome e por telefone filtra.

**Thread (painel central)** — clique numa conversa
- [ ] Bolhas: entrada do lead à **esquerda**, recepção/IA à **direita**.
- [ ] Marcadores **"(editada)"** e **"🚫 Mensagem apagada"** quando houver.
- [ ] Ao abrir, o **contador de não-lidas zera** (marca-lido).

**Envio (⚠️ dispara WhatsApp real)**
- [ ] Escreva numa conversa de **teste** e clique Enviar → a bolha aparece à direita **e** a
      mensagem chega no WhatsApp do contato.

## Passo 5 — Se algo quebrar, onde olhar

| Sintoma | Provável causa |
|---|---|
| Banner "SERVICE_TOKEN não configurado" | env `SERVICE_TOKEN` ausente no dashboard |
| Banner "unidade sem tenant do Lead Manager" | `LEAD_MANAGER_TENANT_ID` ou `franquia.lead_tenant_id` ausente |
| Lista vazia / "falha ao carregar conversas" | LM fora do ar, base errada, ou migration 080 não aplicada (olhar log do LM) |
| 500 no LM ao listar | migration 080 faltando, ou schema divergente — ver `tenant.inbox.*` no log do LM |
| Envio não chega | instância Evolution do tenant desconectada (o endpoint devolve `instancia=<estado>`) |

Me mande o que aparecer (print ou o texto do erro/log) que eu ajusto na hora.
