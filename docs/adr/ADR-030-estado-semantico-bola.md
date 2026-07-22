# ADR-030 — Estado semântico da bola: "passamos a bola ou enrolamos?"
**Status:** Proposto | **Data:** 2026-07-01
**Contexto:** Sequência do Passo 1 (fix "bola vencida" na leitura, commit 10324b0). Este ADR cobre o Passo 2.
> **Nota de numeração:** confirmar em prod o próximo número de ADR livre antes de commitar — a numeração já andou em sessões anteriores. Se 030 estiver tomado, renumerar sem mudar o conteúdo.

---

## Tese central

A direção e o timestamp da última mensagem **não** dizem de quem é a bola — o **conteúdo** dela diz. "Qual instrumento você toca?" passa a bola pro cliente; "vou ver e te aviso" não passa, é só ganhar tempo. O Passo 1 consertou a leitura de forma mecânica (qualquer saída posterior vence o "aguardando nós") e por isso carrega um falso negativo: o "enrolar" tira o lead da urgência quando a bola ainda é nossa. O Passo 2 lê o conteúdo da saída e mantém o `conversation_state` correto **também na saída**, não só no inbound.

## O que muda vs. o Passo 1

O Passo 1 compensa na **leitura** um estado que fica desatualizado na saída. O Passo 2 conserta a **escrita**: passa a atualizar `conversation_state` quando a recepção responde. No instante em que o Passo 2 liga a escrita, a compensação da leitura do Passo 1 **é removida no mesmo commit** — nem antes (abriria um vão onde respostas somem de novo), nem depois (leitura dupla contando os dois). O Passo 1 não foi gambiarra; foi o comportamento de leitura que o Passo 2 torna obsoleto ao consertar a origem.

---

## Pipeline de decisão (saída da recepção)

```
recepção responde (console | WhatsApp Web | celular | áudio)
        │
   captura em staff_outbound_samples  (já existe, Passo 1)
        │
   SKIP barato?  ── estado já AGUARDANDO_CLIENTE? ──────────► não classifica
                └─ mídia sem transcrição ainda? ───────────► aguarda transcrição
                └─ rajada (N msgs seguidas)? ──────────────► só a última
        │
   Camada 1: gate determinístico (~0ms, sem IA)
        │
   termina com "?" / pede info explícita ──► PASSOU A BOLA
   bate padrão de enrolação ("vou ver",
     "te aviso", "já retorno", "deixa eu ver") ──► ENROLOU
   ambíguo ──► Camada 2
        │
   Camada 2: classificador leve (Gemini Flash, saída {verdict, confidence, reason})
        │
   confidence < threshold ──► ENROLOU (viés conservador: na dúvida, bola nossa)
        │
   ┌─────────────── PASSOU A BOLA ───────────────┐   ┌────── ENROLOU ──────┐
   │ grava AGUARDANDO_CLIENTE                     │   │ estado inalterado    │
   │ (transição AGUARDANDO_RECEPCAO→CLIENTE)      │   │ relógio SEGUE contra │
   │ relógio da bola: encerra ciclo nosso         │   │  nós (não zera)      │
   └──────────────────────────────────────────────┘   │ +1 no contador de    │
                                                       │  "adiamos"           │
                                                       └──────────────────────┘
```

---

## Resumo das decisões

| # | Tema | Decisão | Rejeitado |
|---|---|---|---|
| 1 | Sinal da bola | Conteúdo decide, não direção/timestamp. Classificador roda na saída da recepção. | Regra mecânica pura (Passo 1) como estado final |
| 2 | Convivência c/ Passo 1 | Passo 2 **aposenta** a compensação da leitura. Corte sincronizado: remover leitura compensatória no mesmo commit que liga a escrita. | Manter os dois (leitura dupla) ou trocar em commits separados (vão/janela cega) |
| 3 | Escrita no estado | Única transição gravada no motor: `AGUARDANDO_RECEPCAO → AGUARDANDO_CLIENTE`. "Passou a bola" grava; "enrolou" não toca o estado. | Escrita defensiva / re-carimbo a cada saída |
| 4 | Enrolar | **Não é neutro.** Relógio segue contra nós **e** cada enrolada vira evento contável (`adiamentos`). Sinal de gestão de atendimento. | Enrolar como no-op silencioso (perde o sinal) |
| 5 | Relógio de urgência | Marco **próprio** ("desde quando a bola é genuinamente nossa"), gravado só na virada não-nossa→nossa, preservado pelos pings e pelos "vou ver". | Usar `state_computed_at` (anda a cada ping → relógio mentiroso) |
| 6 | Custo Gemini | Três camadas: gate determinístico → modelo leve só no resíduo → skip do que não muda estado. | Classificar toda saída (dobraria as chamadas) |
| 7 | Áudio | Transcrição de saída (reusa pipeline do inbound) é **pré-requisito**. Sem texto, cai no viés conservador (seguro, mas cego). | Classificar áudio sem transcrever |
| 8 | Rollout | Nasce em **shadow** (`bola_shadow_log`), calibra contra o próximo movimento real da recepção, só então liga a escrita + o corte do Passo 1. | Ligar ao vivo direto (erro invisível: rebaixa lead que é nosso) |

---

## Por que o relógio precisa de marco próprio (decisão 5)

`state_computed_at` anda a cada mensagem do lead. Um lead que cutuca 3× em 2 dias sem resposta nossa: a bola é nossa desde o **primeiro** ping (2 dias — urgente), não desde o último. Um relógio baseado em `state_computed_at` mostraria "chegou agorinha" e furaria a fila na frente de quem espera há horas — ou seja, mediria errado justamente os casos mais urgentes. Por isso um marco separado, escrito **só** na transição não-nossa→nossa e **preservado** através dos pings seguintes e dos "vou ver".

## Por que enrolar não é no-op (decisão 4)

Enrolar não é só "a bola continua nossa" — é um **evento que merece ser visto**. Três "já te aviso" sem resposta de verdade é um lead sendo empurrado com a barriga: sinal de gestão sobre qualidade de atendimento, não só urgência acumulada. Custa quase nada gravar e abre uma métrica que o Passo 1 jogava fora. O relógio nunca alivia; o contador só torna o padrão visível.

---

## Schema (a confirmar contra o banco antes de migration)

```sql
-- leads: marco do relógio + contador de enroladas
ALTER TABLE lead_manager.leads
  ADD COLUMN bola_nossa_desde   timestamptz,  -- marco do relógio (decisão 5)
  ADD COLUMN adiamentos          int NOT NULL DEFAULT 0;  -- contador (decisão 4)
-- bola_nossa_desde: escrito quando estado vira AGUARDANDO_RECEPCAO vindo de
--   não-nossa; preservado enquanto continuar nossa; limpo ao virar CLIENTE.
--   Verificar antes se algum campo existente já serve (evitar coluna redundante).

-- shadow log (irmão de gate_shadow_log)
CREATE TABLE lead_manager.bola_shadow_log (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL,          -- RLS
  lead_id         uuid NOT NULL,
  outbound_sample_id bigint,              -- a saída que disparou a classificação
  camada          text NOT NULL,          -- gate | modelo_leve | skip
  veredito        text NOT NULL,          -- passou_bola | enrolou
  confidence      numeric,                -- null quando gate determinístico
  reason          text,
  estado_atual    text,                   -- o que ESTÁ gravado (não muda em shadow)
  estado_sugerido text,                   -- o que o Passo 2 GRAVARIA
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

## Camada 1 — gate determinístico (contrato)

```javascript
// Sem IA. Resolve os extremos, custo zero.
// PASSOU A BOLA: termina com "?" OU pede info explícita (padrões).
// ENROLOU: bate lista de adiamento ("vou ver", "te aviso", "já retorno",
//          "deixa eu verificar", "assim que ..." etc. — curar a lista).
// Nenhum match com confiança → devolve "ambiguo" → Camada 2.
//
// ESCOPO DA LISTA (ver "Vocabulário por ramo" abaixo): ENROLACAO_PATTERNS
// NÃO pertence à bola nem ao tenant — é vocabulário de RAMO. Hoje mora num
// Set de piloto (seed "escola de música", curado da Valinhos). NÃO é lei da
// plataforma: uma clínica/academia enrola com outras palavras. A bola apenas
// CONSOME essa lista; ela não é dona dela.
// A lista de enrolação É a materialização do "vou ver e te aviso" —
// vale curá-la de qualquer forma; aqui ela vira código.
{ veredito: "passou_bola | enrolou | ambiguo", via: "gate" }
```

## Camada 2 — classificador leve (contrato)

```javascript
// Só o resíduo ambíguo. Gemini Flash (não o pesado), fallback já existente.
{ verdict: "passou_bola | enrolou", confidence: 0.0-1.0, reason: "..." }
// threshold conservador: confidence < 0.7 → enrolou (bola nossa)
```

---

## Rollout faseado (CRÍTICO)

1. **Sobe em shadow.** Classificador na saída loga em `bola_shadow_log` o que gravaria, **sem** tocar `conversation_state`, sem mexer na tela. Passo 1 segue no ar resolvendo a dor.
2. **Calibração.** Leo lê o log: quanto o gate determinístico resolve sozinho e com que acerto; quantos casos vão pro modelo; onde erra. Compara veredito com o próximo movimento real da recepção (o lead voltou? a recepção respondeu de novo?).
3. **Corte sincronizado.** Só quando o log convencer: **no mesmo commit**, liga a escrita do `conversation_state` na saída **e** remove a compensação de leitura do Passo 1 (os 3 pontos: `awaiting_reply`, `esperandoNos`, `computePainel`).
4. **Relógio acende junto.** A ordenação por urgência passa a usar `bola_nossa_desde`. Não antes — o relógio precisa medir o estado já correto.

## Riscos e armadilhas

- **Toca o motor** (`engine.js`/`classifyConversa`) — código sensível. Mitigação: shadow + a única escrita ser uma transição só.
- **Erro invisível.** Rebaixar um lead que é nosso não some com ele (continua ativo, Passo 1 garantiu), mas cai no ranking e recebe menos atenção. Mitigação: viés conservador em toda camada + shadow antes de ligar.
- **Custo/latência Gemini.** As três camadas mantêm o volume real bem abaixo do teto (dobrar). Shadow mede o volume real antes de confiar.
- **Áudio cego sem transcrição.** Até a transcrição de saída entrar, áudio cai no conservador (bola nossa) — seguro, mas não lê o conteúdo.
- **Discriminador Scheduler.** Se um dia o auto-send ligar, usar `raw->data->source` (web/android/ios = humano) pra lembrete automático não "responder" pelo lead. Hoje o webhook só recebe humano; o guard fica pronto.

## Próximos ADRs / dependências

- Transcrição de saída: reusa o pipeline do inbound; pré-requisito do áudio nesta decisão.
- Relaciona-se com ADR-021 (bucket "aguardando nós") e com o Portão 0 (mesma família: decisão de IA que altera a fila — mas aqui o erro é recuperável, então gate mais leve).

## Vocabulário por ramo (dependência de fundação — decisão NÃO tomada aqui)

A `ENROLACAO_PATTERNS` é **vocabulário de ramo**, não da bola nem do tenant. O conceito de "ramo" (do qual tenants herdam vocabulário) ainda não existe na plataforma e tem **vários irmãos** que precisam dele — instrumentos/serviços, vocações de sala/recurso, estágios de funil, rótulos de nicho. A enrolação é só o primeiro a bater nessa parede. Por ser transversal, o conceito de ramo **nasce no ADR de fundação multi-tenant**, não aqui — criá-lo dentro deste recurso seria vazamento.

Estrutura acordada (a detalhar no ADR de fundação): **duas camadas** — ramo dá o seed do vocabulário; tenant ajusta em cima (adiciona/remove). A lista de enrolação da Valinhos será promovida a seed do ramo "escola de música"; a 2ª escola de música herda direto.

Folga de sequência: a 2ª escola (cliente em vista) é do **mesmo ramo** da Valinhos → herda o vocabulário como está e **não** depende do conceito de ramo estar pronto. O ramo só vira obrigatório quando o **ramo diferente** chegar. Portanto o Passo 2 sobe em shadow com o `Set` de piloto sem bloqueio; quando a fundação de ramo existir, a lista passa a **consumi-la** sem redesenho.

## Emenda 2026-07-22 — a SAÍDA como fonte de estado (flip) + aba de auditoria (Fatia 0)

Tira a bola do shadow: em **`bola_mode='on'`**, `classificarSaida` passa a **escrever** `conversation_state` (o corte sincronizado do Passo 2), mantendo o `bola_shadow_log` gravando **sempre** (age E presta contas). Construído/uncommitted; o flip do modo é passo separado pós-revisão.

**(a) Wire (`engine.js`).** Após a decisão (`passou_bola → AGUARDANDO_CLIENTE` / `enrolou → AGUARDANDO_RECEPCAO`), em `'on'` chama `_aplicarEstadoBola` que grava `conversation_state` + `state_reasoning` + `state_computed_at` + `bola_nossa_desde` + `adiamentos` (colunas já existentes na 058 — **sem migração**). `'shadow'` só loga; `'off'` inerte. **Default conservador:** erro do Gemini (503) na Camada 2 → `AGUARDANDO_RECEPCAO` (nunca passa a bola no escuro).

**(b) Override respeitado via proveniência (070).** A escrita passa por **`aplicar_scraping('lead', leadId, 'conversation_state', …, 'bola')`**: sem trava → `ESCREVE`; travado por humano (revert) → `DIVERGE`/`IGUAL` → **não escreve** (a bola respeita) e a divergência fica **auditável** em `field_divergence`. O `revert` da aba chama `marcar_edicao_humana('lead', …)` + restaura o valor anterior. Fronteira: o path **INBOUND** (`classifyConversa`) NÃO passa por essa trava — um novo inbound é evento novo e re-deriva legitimamente; o override protege contra a bola re-decidir nas NOSSAS saídas.

**(c) Aba "Bola" no Monitor do Filtro** (`/f/:slug/monitor-filtro`, 2ª aba; "Filtro" intacta). Lê `bola_shadow_log` (última decisão/lead): estado marcado, camada (**Determinístico** vs **Gemini Flash**), o **texto da saída** que disparou, timestamp, flag de override. Botão **↩ Reverter** por lead. Multi-tenant (tenant da URL).

**(d) Invariantes.** `conversation_state` muda de **VALOR, não de contrato** — `awaiting_reply` (tenant.js), badge (recep-leads.js) e SLA (metrics.js) seguem lendo igual. `bola_mode` por-tenant; aba por-tenant; `bolaGate` genérico. **Kill-switch:** `UPDATE tenant_lead_config SET bola_mode='shadow'` (volta a só-calcular, sem deploy). **Interação com o bug da reação (diag #3):** com a bola gravando `AGUARDANDO_CLIENTE`, o `awaiting_reply` sai do fallback-por-timestamp (só-NULL) que a reação sabota → fecha o #3 pela raiz. itest do flip: 5/5 (`_aplicarEstadoBola` escreve/respeita-override, `gateSaida`, cross-tenant).
