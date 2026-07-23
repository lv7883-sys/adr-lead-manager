# ADR-041 — Régua canônica de "lead ativo" / "convertido" / "terminal"
**Status:** Aceito | **Data:** 2026-07-23
**Contexto:** A auditoria de indicadores (2026-07-23) achou **6 definições divergentes de "lead
ativo"** e **2 de "convertido"** espalhadas por dashboard + LM. O tile "Leads ativos" mostrava
**64** vazando **11** leads com desfecho terminal (inclusive matriculados aparecendo como ativos),
e a Reativação mostrava **36** vazando **18**. Raiz: `classificarLead` excluía por **STATUS**
(CONVERTED/WON) e **ignorava DESFECHO**.

---

## Decisão — definição ÚNICA

| Conceito | Definição |
|---|---|
| **TERMINAL** | `status ∈ {CONVERTED, WON}` **OU** `desfecho IS NOT NULL` (qualquer desfecho registrado = terminal) |
| **CONVERTIDO** | `status ∈ {CONVERTED, WON}` **OU** `desfecho = 'matriculado'` (⊂ TERMINAL) |
| **STATUS_VIVO** | `status ∈ {NEW, QUALIFYING, QUALIFIED, EXPERIMENTAL_AGENDADA}` |
| **LEAD ATIVO** | `STATUS_VIVO ∧ ¬TERMINAL ∧ não-dormente` (dormência ORTOGONAL, por `dormancy_days` do tenant) |

- **TERMINAL cobre desfecho** — fecha o vazamento (matriculados E não-matriculados saem de ativo E de reativação).
- **CONVERTIDO unifica** status e `desfecho='matriculado'` — antes o funil contava só `status='CONVERTED'` e os matriculados sem esse status caíam em QUALIFYING/QUALIFIED (divergindo do BLOCO 3).
- **Dormência é ortogonal**: quem quer "ativo com dormência" (tile) compõe `∧ não-dormente`; quem quer "ativo sem dormência" (métricas de espera) usa só `STATUS_VIVO ∧ ¬TERMINAL`. EXPERIMENTAL_AGENDADA fora dos buckets de espera é uma **especialização** documentada do ADR-021 (não da régua).

## Fonte única (sem cópia solta)
- **LM `src/lifecycle.js`** — fragmentos SQL (`terminalSql`/`convertidoSql`/`statusVivoSql`) + predicados JS (`isTerminal`/`isConvertido`/`isStatusVivo`). Usado por `metrics.js` (funil convertido, ativo021, engajamento).
- **Dashboard `lib/lifecycle.js`** — ESPELHO fiel (os repos não compartilham código); `isTerminal`/`isConvertido`. Usado por `classificarLead` (fix do vazamento) e `estadoReativacao` (convertido).
- itest garante **SQL ≡ JS** (mesma contagem) — nenhuma das duas representações pode driftar sem quebrar o teste.

## Números (real, Valinhos, pós-régua)
| | antes | depois |
|---|---|---|
| tile "Leads ativos" | 64 | **54** (removeu 10 terminais; a estimativa "~53" era aproximada) |
| Reativação | 36 | **18** (os 18 dormentes reais do #8) |
| convertido (funil) | 4 (só status) | **7 all / 6 no feed** (unificado com matriculados) |

## Prova
LM itest 5/5 (`test/lifecycle-canonico.itest.js`: desfecho→terminal, matriculado-sem-CONVERTED→convertido,
dormente→reativação, **SQL≡JS**, multi-tenant). Dashboard 17/17 (`tools/test-invariante-vivos.js`
estendido: k/l/m desfecho→excluido). SQL do metrics validado read-only na base real (sem bug de param — lição da Fatia B).

## Fora desta fatia (Fatia C)
Os 425 rascunhos pendentes, proxy "Aula agendada" (intent/status vs agenda real), métricas mortas
(`bloco_respostas`/`pct_lead_parou`), "Taxa de entrega" (inclui opt-out).

## Smoke-test obrigatório pós-deploy (endpoints reais)
1. `/tenant/:tid/leads` → contar `classificarLead==='ativo'` = **54** e `historico` = **18** (via dashboard ou replicando o bucket).
2. `/tenant/:tid/metrics?period=30d` HTTP **200** → `funil.CONVERTED` bate com `bloco3.matriculados`; engajamento universo ≈ 54.
3. Tile "Leads ativos" no dashboard real = 54; aba Reativação = 18.
