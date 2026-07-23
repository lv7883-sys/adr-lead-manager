# ADR-027 — Reativação: ciclo de vida 100% DERIVADO de eventos
**Status:** Aceito | **Data (formalização):** 2026-07-23
**Contexto:** As decisões do ciclo de reativação (Etapa 1) viviam desde o início **inline no código**
(`src/routes/tenant.js` `GET /leads` + `dashboard/routes/leads.js` `estadoReativacao`), sem doc
próprio. Este arquivo formaliza o princípio fundador e registra a **emenda #8** (re-fonte da
retomada). Não altera o comportamento do bucket de dormência (ADR-028).

---

## Tese central (princípio fundador)

O estágio do lead na Reativação **nunca é um status marcado à mão** — é **100% derivado de
eventos** na leitura. A aba Reativação = bucket `historico` (lead vivo dormente > `dormancy_days`,
ADR-028). Sobre esse conjunto, `estadoReativacao` deriva o chip por precedência terminal-first:

| chip | regra (derivada) |
|---|---|
| `recuperado` | matriculou DEPOIS de uma retomada (atribuição honesta) |
| `resolvido` | desfecho terminal MANUAL (decisão via kanban) — sai do ciclo, não é Perdido |
| `reengajou` | o cliente respondeu APÓS a retomada |
| `perdido` | retomou, não respondeu, e passou de `reactivation_expiry_days` (só TEMPO) |
| `em_reativacao` | retomou, aguardando |
| `candidato` | dormente, ainda NÃO tocado |
| `fora` | não pertence ao ciclo (ativo, ou conversão sem retomada) |

Dois rastros alimentam isso a partir do payload de `/leads`: **`retomada_enviado_em`** (quando
re-abordamos) e **`retomada_reengajou`** (o cliente voltou depois).

---

## Emenda 2026-07-23 (#8) — a retomada passa a derivar do LOG REAL DE ENVIO

**Problema.** `retomada_enviado_em`/`retomada_reengajou` derivavam de `reabordagem_tentativas` com
`status='enviado'`. Mas **essa tabela só ganha um `'enviado'` pelo endpoint SEMI `enviar-retomada`**
(botão "✨ Iniciar reativação"). Na prática a recepção re-aborda o dormente pela **fila normal de
rascunho → `/approve`**, que envia via Evolution + grava `staff_outbound_samples`, mas **nunca toca
`reabordagem_tentativas`**. Resultado: **0 linhas `enviado` tenant-wide** → `retomada_enviado_em`
sempre NULL → todo dormente colava em `candidato`; `em_reativacao`/`reengajou`/`perdido` eram
**inalcançáveis**. (Diag: 18 dormentes na Valinhos, ≥6 com retomada real 7–16 dias após o inbound,
todos exibidos como "nunca tocado".) `retomada_reengajou` ainda comparava contra um `enviado_em`
sempre NULL — bug latente.

**Decisão (Opção B).** A retomada passa a ser **derivada do log real de envio**
(`staff_outbound_samples`), não do ledger de tentativas:

- **`retomada_enviado_em`** = a **última saída nossa cuja lacuna desde o inbound ANTERIOR** (o mais
  recente antes dela) é **≥ `dormancy_days`** do tenant (ADR-028, já no payload). Sem inbound
  anterior → a comparação é NULL → **não** conta (evita falso-positivo de 1º contato / resposta
  same-day). Implementado por um `LEFT JOIN LATERAL rtm` em `GET /leads`.
- **`retomada_reengajou`** = existe inbound do lead **APÓS** `rtm.retomada_em` (corrige o bug do
  NULL de comparação).

**Propriedades.** (a) **Retroativo** — captura retomadas passadas sem backfill (os 6 reais saem de
`candidato` na hora). (b) **Desacoplado** — zero mudança em caminho de escrita; captura `/approve`
E `enviar-retomada` E qualquer caminho futuro. (c) **Consumidor inalterado** — os **nomes de campo
no payload não mudam**, então `estadoReativacao` (dashboard) não muda. (d) **Multi-tenant** — o
corte usa `dormancy_days` por-tenant, sem hardcode. (e) **Read-path puro** — não move lead, não
envia nada; kill-switch = reverter a subquery.

**Fonte única passa a ser:** `staff_outbound_samples` para "houve retomada". `reabordagem_tentativas`
**continua** sendo lida só para `retomada_sugestao_pendente` (a fila de sugestão da IA), que é outra
coisa (rascunho pronto), não "foi enviado".

**Escopo.** Só `src/routes/tenant.js` (`GET /:tenantId/leads`). itest 6/6 (em_reativacao / reengajou
/ candidato-sem-falso-positivo / perdido / os 6 reais saem de candidato / corte por-tenant).

**Fora desta fase (#8 Fase 2, separada):** o acúmulo de `pendente` duplicado em
`detectar-silenciosos.js` (dedup furado por `enviado_em` com `DEFAULT now()`) e a limpeza dos 249
pendentes. Não tocado aqui.

## Emenda 2026-07-23 (#8 Fase 2) — higiene do ledger de sugestão

A tabela `reabordagem_tentativas` acumulou **249 `pendente` para 77 leads (~3.2/lead)**: o dedup do
job `detectar-silenciosos.js` ancorava em `enviado_em > now()-3d`, mas `pendente` tinha
`enviado_em = DEFAULT now()` (hora da GERAÇÃO, não do envio) → após 3 dias regenerava. Três correções:

1. **Dedup** (`detectar-silenciosos.js`): o `NOT EXISTS` passa a bloquear se **já existe `pendente`
   aberto** pro lead (`rt.status='pendente' OR rt.enviado_em > now()-3d`) — não só a janela de 3d.
2. **Coluna honesta**: `enviado_em` passa a significar **só "enviado de verdade"**. O INSERT de
   pendente grava `enviado_em=NULL`; o INSERT de envio (`enviar-retomada`) grava `now()` explícito;
   a **migração 073** dropa o `DEFAULT now()`. (Fase 1 não depende disso — lê `staff_outbound_samples`.)
3. **Limpeza (073, idempotente)**: purga pendentes de leads não mais candidatos (status fora de
   QUALIFYING/QUALIFIED, `desfecho` definido, ou **não mais dormente** por `dormancy_days` do tenant)
   + colapsa duplicatas → **1 pendente por (tenant_id, lead_id)**, o mais recente. Dry-run:
   249 → **46** (purga 58 + dedup 145), exatamente 1/lead. Multi-tenant, sem hardcode.

itest 8/8 (`test/reabordagem-cleanup.itest.js`, migração 073 testada verbatim). Não altera o chip
(Fase 1 intacta) nem caminho de envio (só carimba `enviado_em` explícito).

## Emenda 2026-07-23 (#8 Fatia B) — fonte única de retomada estendida a metrics.js e plantao.js

A Fase 1 re-fonteou a retomada (reabordagem_tentativas → staff_outbound_samples) **só no `/leads`**.
`metrics.js` (BI de gestão) e `plantao.js` (card de saúde) ficaram na fonte antiga → **3 fontes
divergentes** de "retomada". Pior: a limpeza da Fase 2 mexeu nos números da gestão (metrics contava
**46** sugestões `pendente` como "enviadas"; denominador `reabIds` caiu 77→49). Regressão nossa.

**Decisão.** A regra da Fase 1 (retomada = saída nossa cuja lacuna desde o inbound anterior ≥
`dormancy_days`) vira **helper compartilhado `src/reativacao.js`** (`retomadaLateral` + `reengajouExists`),
usado pelos **três** lugares — `tenant.js` (/leads, **refatorado** pra usar o helper), `metrics.js`
e `plantao.js`. Assim os 3 dão o **mesmo número** pros mesmos dados. Correções acopladas:
- **metrics.js**: `reabordados_no_prazo`/`taxa_retomada` derivam de staff_outbound; **universo
  corrigido** (`status NOT IN NOT_LEAD/REVIEW_QUEUE` — antes o JOIN contava leads que o gate
  suprimiu); `reabIds` idem. **Par de qualidade novo**: `reengajaram` + `taxa_reengajamento`.
- **plantao.js**: mesma re-fonte + **fuso corrigido** (`HOJE` de UTC → America/Sao_Paulo, aplica a
  todas as linhas do card — antes divergia ~3h do resto).

Read-path puro (não move lead, não envia). Extraí helper (não dupliquei) porque a regra é idêntica
nos 3; plantão usa o mesmo helper com `schema='lead_manager.'` e `since=SP_HOJE`. Multi-tenant
(`dormancy_days` por tenant). Prova: metrics real passou de **46 falsos → 22 reais** (30d); os 3
lugares consistentes na mesma janela. itest 7/7 (`test/retomada-fonte-unica.itest.js`), Fase 1 6/6
sem regressão. Fica de fora (Fatia A): régua canônica de "lead ativo"/"convertido" (vazamento de `desfecho`).
