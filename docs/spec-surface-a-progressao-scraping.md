# Spec de build — Surface A: progressão de lead via evento canônico (ADR-022)

> Companion do **ADR-022**. Aqui é o "como construir", por repo/serviço. Build NÃO
> iniciado — aguarda liberação. Deploy sobe pelo origin (commit + push → deploy).
>
> **Modelo central (ADR §8.1):** o lead-manager consome um **evento canônico
> agnóstico de fonte** (`experimental_realizada`, `matricula_confirmada`). As fontes
> são **adapters** (scraper Extranet p/ Valinhos hoje; BI/Regente no futuro). O
> scraping é detalhe de UMA fonte — não o coração da lógica.

## Mapa de componentes (em qual repo cada peça mora)

| Peça | Repo/serviço | Toca a Extranet? |
|---|---|---|
| **Adapter Extranet** (scraping grade+detalhe+matrícula → evento canônico) | **scheduler** (`dashboard/lib/agenda.js`, `extranet.js`, `parser.js` + novo `progressao.js`) | Sim (GET, read-only) |
| **Endpoint de ingestão do evento canônico** | **lead-manager** (novo `POST /tenant/:tid/eventos-progressao`, service-token) | Não |
| **Resolução unidade→tenant** (`extranet_unit_map`, sem fallback) | **lead-manager** | Não |
| **Matcher pessoa↔lead (escopado por tenant)** + avanço/criação/conclusão | **lead-manager** (novo `src/eventos-progressao.js`) | Não |
| `lead_eval_label` (ground-truth recall) | **lead-manager** (migration nova) | Não |
| Ledger de idempotência | **lead-manager** (migration nova) | Não |

---

## Tarefas

### S1 — (investigação) telefone no detalhe da experimental
- Inspecionar o HTML de `detalhar_aula.php?id=` à procura de campo de telefone
  (além de `aluno_exp`/`responsavel_exp`). Se existir, estender `parseDetalheAula`.
- **Saída:** confirma se o match por telefone (forte) é viável; senão, match por nome.
- Repo: scheduler. Read-only.

### S2 — `extranet_unit_map` (mapa unidade→tenant, SEM fallback) — ADR §8.2
- Tabela `lead_manager.extranet_unit_map (id_unidade_extranet text/slug, tenant_id,
  ativo, created_at)`, única por `id_unidade_extranet`. **Seed: Valinhos (1ª linha).**
- Resolução no consumidor: unidade fora do mapa ⇒ evento **REJEITADO + LOGADO**
  (`evento_orfao`), **nunca** default p/ Valinhos. 2º tenant = um INSERT, zero código.
- O **adapter NÃO conhece tenant**: carimba o evento só com `id_unidade_extranet`.

### S3 — migrations (lead-manager)
- `lead_eval_label(lead_id, label, source, trigger, ai_routed_to, by, at)` —
  append-only, RLS por tenant.
- `progressao_event_ledger(tenant_id, source_adapter, source_record_id, situacao,
  evento_hash, lead_id, status, created_at)` — **chave única
  `(tenant_id, source_adapter, source_record_id, situacao)`** (idempotência por
  registro-da-fonte + situação; ADR §9.4). NÃO depende de `aula_id` específico de
  Extranet — é genérico por adapter.
- `extranet_unit_map` (S2).
- Colunas no `leads` (ADR §9): nome do **aluno** separado do contato
  (`student_name`); **proveniência/ator** da progressão (`progressao_source`
  'system'|user_id, `progressao_adapter`); **trava manual** (`auto_progress_locked`
  bool). Tag de origem `walk_in` no enum/coluna de origem (distinta de canal).
- Próximo número livre (≥ 044; 043 = lead-origem-dedup já em prod).

### S7 — (investigação) onde a Extranet expõe a matrícula (M2)
- Mapear a página/endpoint da Extranet com matrícula/contrato e os campos que casam
  com o lead (telefone/nome/responsável) + um **id estável do registro** (→
  `source_record_id`) e a **situação** (→ `situacao`). Confirmar raspagem read-only
  dentro do budget/cooldown.
- Repo: scheduler. Read-only. Guard `_assertValinhos` mantido.

### S8 — (investigação) marcador de origem/campanha na Extranet
- Catalogar **tela + seletor + formato** do módulo de captação/leads da Extranet (se
  existir), com credenciais. Confirmado (2026-06-23) que **não** vive no detalhe da
  experimental e **não** é raspado hoje. **Não bloqueia a progressão** (match é por
  telefone/nome); destrava apenas a dedupe Meta↔Extranet pelo lado da Extranet.

### S4 — adapter Extranet → evento canônico (scheduler)
- A cada ciclo, difere o estado atual contra o anterior e **emite evento canônico**:
  - experimental nova (aluno/responsável resolvido) → `experimental_realizada`.
  - matrícula nova (M2, via S7) → `matricula_confirmada`.
- POST ao LM (Bearer `SERVICE_TOKEN`) com: `id_unidade_extranet`, `source_adapter`
  (`'extranet'`), `source_record_id` (aula_id / id matrícula), `situacao`,
  `student_name`/`responsavel`, telefone (se S1), data/hora, `evento_hash`.
- **Tenant-ignorante** (§8.1). Best-effort + retry; nunca trava o ciclo de scraping.

### S5 — ingestão + progressão (lead-manager)
`POST /tenant/:tid/eventos-progressao` (service-token), dentro de `withTenant` (RLS):
1. **Resolve tenant** via `extranet_unit_map` (S2). Órfão → rejeita + loga, fim.
2. **Idempotência:** `(tenant, source_adapter, source_record_id, situacao)` já no
   ledger → no-op.
3. **Matcher escopado por tenant (§8.3):** todas as chaves casam DENTRO do
   `tenant_id`. Ordem: telefone → `student_name` → ambíguo (Revisar) → sem match (rua).
4. **Ação por tipo de evento:**
   - `experimental_realizada` + match forte → `mover-kanban` p/ etapa `experimental`;
     registra `lead_eventos` com proveniência (`system`/adapter).
   - `experimental_realizada` + sem match → cria **lead de rua** (origem **`walk_in`**,
     etapa `experimental`); dedupe por `(tenant, telefone)` ou
     `(tenant, student_name_norm, origem='walk_in')` quando sem telefone.
   - `experimental_realizada` + ambíguo → `review_queue=true` com candidatos.
   - `matricula_confirmada` + match → `desfecho` won/`matriculado`
     (`desfecho_source='extranet'`), etapa `convertido`, **+ alerta obrigatório à
     recepção**.
5. **Trava manual com exceção (§9.3):** se `auto_progress_locked` (humano moveu o
   card), `experimental_realizada` **NÃO** progride. **`matricula_confirmada` fura a
   trava** e progride mesmo assim, com alerta. **Override humano sempre prevalece:**
   não sobrescreve desfecho `recepcao`; se a recepção mexer depois, vale a recepção.
6. Emite `lead_eval_label(label='lead', source='derived_funnel', trigger=<evento>,
   ai_routed_to=<snapshot do que a IA decidira>)` ANTES de mexer no status.
7. Grava o ledger.

### S6 — painel
- Progressões na timeline do lead (`lead_eventos`) com **selo de proveniência**
  ("avançou via check Extranet" vs. ação de `user_id`).
- Card de recall (Mec. 1+2) conta os positivos derivados.
- Fila Revisar ganha os matches ambíguos, com botão de confirmar candidato.
- Alerta de conclusão automática visível à recepção.

---

## Invariantes de segurança (não-negociáveis)

- Extranet **somente leitura**; budget/cooldown/allowlist preservados; `_assertValinhos`.
- **Evento canônico agnóstico de fonte**; adapter é tenant-ignorante (§8.1).
- **`extranet_unit_map` sem fallback**: órfão é rejeitado+logado, nunca vira Valinhos.
- **Matcher escopado por `tenant_id` na aplicação** (não só RLS) — nunca cross-tenant.
- Idempotente por `(tenant, source_adapter, source_record_id, situacao)`; etapa só
  avança "para frente".
- **Trava manual:** humano move → congela auto-progressão; só `matricula_confirmada`
  fura, com alerta. Humano sempre prevalece (padrão migration 042).
- **Proveniência + ator** em toda progressão (system vs user_id + adapter).
- Lead de rua com origem **`walk_in`** distinta (não polui CAC por canal).
- `lead_eval_label` registra `ai_routed_to` antes da progressão (recall não-circular).

---

## Ordem sugerida de build (após liberação)
S2 + S3 (fundação: unit_map, ledger, colunas) → S5 (ingestão do evento canônico,
testável com evento mockado, sem Extranet) → S1 + S7 + S8 (investigações read-only,
em paralelo) → S4 (adapter Extranet real: experimental + matrícula M2) → S6 (painel +
selo de proveniência + alerta). O consumidor (S5) é construível e testável **antes**
de qualquer scraping, justamente porque o evento é agnóstico de fonte.
