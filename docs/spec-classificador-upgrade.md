# Spec — Upgrade do classificador para context-aware

> Spec de design derivada do mapeamento desta sessão (jun/2026). Não introduz
> decisão nova: registra o estado atual do Portão 1 e a direção acordada.

## 1. Diagnóstico — como o classificador funciona HOJE

### 1.1 Input: mensagem isolada, sem conversa
`classify({ message, examples })` (`src/gemini.js:102`) recebe **uma única string** — o
inbound atual (`msg.body`) — e os exemplos de few-shot. **Não recebe histórico da
conversa nem nada do contato.** Call site: `src/engine.js:358`
(`cls = await classify({ message: msg.body, examples })`). O prompt global
`TRIAGE_PROMPT` (`gemini.js:64-85`) pede "analise o CONTEXTO COMPLETO da mensagem",
mas o modelo só vê aquela frase + few-shot. Modelo `gemini-2.5-flash`, `temperature: 0`,
saída JSON: `is_lead`, `confidence`, `reasoning`, `suggested_temperature`, `profile_signals[]`.

### 1.2 Skip da conversa estabelecida (`engine.js:355`)
```js
if (!msg.skipTriage && !conversaEstabelecida) {   // só classifica se NÃO estabelecida
  cls = await classify(...);
```
`conversaEstabelecida` (`engine.js:302-316`) = existe `staff_outbound_samples` (não-grupo)
para o número. Quando a recepção já respondeu, **a triagem é pulada inteira** — a
mensagem vai direto ao Portão 2. Isso evita re-travar um lead real, mas significa que
**toda conversa em andamento deixa de ser classificada** (perde-se o sinal de contexto).

### 1.3 Confiança → status (thresholds 0.85 / 0.40)
Constantes globais `AUTO_THRESHOLD = 0.85`, `REVIEW_THRESHOLD = 0.40` (`engine.js:18-19`):

| confiança | caminho | status |
|---|---|---|
| `>= 0.85` | Portão 2 (vira lead, gera rascunho) | NEW→QUALIFYING |
| `0.40–0.85` | `captureForReview` | REVIEW_QUEUE (+ notifica) |
| `< 0.40` | `captureForReview` | NOT_LEAD (silencioso) |

Confiança gravada em `leads.classification_confidence` (em `captureForReview` e no
UPDATE do Portão 2, `engine.js:428`). **É volátil** — sobrescrita a cada inbound.

### 1.4 Loop de feedback (`classification_feedback`)
Escrita por ações da recepção via `_registrarFeedback` (`tenant.js:790`): promover/ignorar
no /unclassified, decidir review, marcar não-lead/é-lead. Leitura por `_fewShotExamples`
(`engine.js:22-34`): **últimos 10 por tenant**, injetados como EXEMPLOS POSITIVO/NEGATIVO
no prompt (`_fewShot`, `gemini.js:90-100`). O loop já fecha; mas é "últimos 10", sem
similaridade com a mensagem atual.

### 1.5 Latch-rescue é score-independent
A âncora de resgate **não olha o score**: (a) pula a triagem quando há staff_outbound
(`engine.js:355`); (b) o Portão 2 promove `NEW/NOT_LEAD/REVIEW_QUEUE → QUALIFYING`
com guard `review_result IS NULL` (`engine.js:579-585`), independente da confiança. Foi
por isso que a remediação puxou professores (têm staff_outbound). O rescue deve permanecer
como rede de segurança **ortogonal** ao score.

### 1.6 Steering: só por few-shot, hoje
- `TRIAGE_PROMPT` é **global/fixo** — sem override de prompt de classificação por tenant.
- Thresholds são **constantes globais**.
- O único steering por-tenant é o few-shot (`classification_feedback WHERE tenant_id`).
- `system_prompt_override` (tenant_lead_config) é do **Portão 2 (geração)**, não toca a triagem.

### 1.7 Cego ao contato
`classify` não recebe tipo de contato, flag de conhecido/interno, histórico, canal nem
telefone. A única consideração de contato é **fora** do classificador: o Gate 0
(`internal_contacts`, `engine.js:333`) é um pré-filtro binário antes da triagem.

## 2. Direção — context-aware

Princípio: **mecanismo genérico, dado (ADR/tenant) por cima**. Tornar a triagem
sensível ao contexto sem quebrar o rescue.

1. **Histórico da conversa** como input (não só a mensagem isolada) — permite classificar
   conversas em andamento sem o skip cego de §1.2.
2. **Metadados de contato** como features: telefone ∈ `app.professor_notificacao`,
   `internal_contacts.type`, `desfecho` do lead, staff_outbound ("recepção já falou").
3. **Prompt e thresholds por-tenant** (hoje globais) — cada escola/tema afina.
4. **Feedback por similaridade** (retrieval sobre `classification_feedback`) em vez de
   "últimos 10".
5. **Saída tipada de intenção** (não só lead/não-lead) — alimenta contato↔oportunidade
   (ver [spec-contato-oportunidade.md](spec-contato-oportunidade.md)).

## 3. Faseamento

**Fase 1 — classificar a conversa estabelecida com contexto.** Em vez de pular a triagem
quando há staff_outbound (§1.2), classificar **com o histórico + metadados de contato**,
sob **viés recall-first**: na dúvida, não rebaixar um lead real (preferir REVIEW_QUEUE a
NOT_LEAD). O latch-rescue score-independent continua como rede de segurança. Sem mudar os
thresholds globais ainda.

**Fases seguintes (esboço):** thresholds/prompt por-tenant; retrieval de feedback por
similaridade; saída tipada de intenção integrada ao modelo de oportunidades.

## Referências de código
- `src/gemini.js:64-126` (TRIAGE_PROMPT, `_fewShot`, `classify`)
- `src/engine.js:18-34` (thresholds, `_fewShotExamples`), `:302-316,355` (estabelecida/skip),
  `:366-376` (mapeamento status), `:428` (grava confiança), `:579-585` (rescue)
- `src/routes/tenant.js:790` (`_registrarFeedback`)
- `db/migrations/023_classification_feedback.sql`
