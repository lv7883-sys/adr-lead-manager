# ESTADO DO PROJETO — REGENTE / Lead Manager
_Gerado por levantamento de repositório em 2026-07-01. Fonte de verdade: este arquivo._
_Prod ≡ git ≡ `5832c14` (main == origin/main, rev-list 0 0)._

> Regra: cada afirmação tem lastro (migration / commit / arquivo / rota / tabela). O que não
> foi verificável no repo está na seção 6 (INCERTO). Não há tabela de controle de migrations
> no banco — "aplicada" é **inferido da presença do objeto no schema real de prod**
> (`adr_scheduler`, schema `lead_manager` / `resources`), não de um registro de versão.

---

## 1. NO AR (produção, funcionando)

### Leads / Triagem (motor ADR-003)
- **classifyConversa governa a conversa estabelecida** (roteia por is_lead+intent, nunca por confidence) — `76fe1e9`, `5ddc963`, `src/engine.js`, `src/gemini.js`.
- **Definição de lead multi-tenant** (sem hardcode "escola de música"): vem de `tenant_lead_config.lead_definition` — mig **039**, `4af8361`.
- **Resiliência a 503 do Gemini no Portão 1**: buffer `PENDING_CLASSIFICATION` + reprocessa conversa inteira (cron 2min) + few-shot balanceado — mig **045** (`leads.classification_pending_since` presente), `71dd1ba`, `src/jobs/reprocessar-pendentes.js`.
- **Origem imutável (first-touch) + dedup BR-aware Meta↔WhatsApp** — mig **043** (`leads.origem` presente), `4b47c2f`.
- **Sugestão de etapa pela IA** (suggestion-only, chip 1-clique) — mig **038**, `20314c0`, `src/jobs/sweep-stage-suggestion.js`.
- **Histórico por lead** (`lead_eventos`: etapa/anotações) — mig **037**, `18da4cc`.
- **Desfecho confirmado pela recepção** (ground-truth) — mig **042** (`leads.desfecho_recepcao` presente), `7e16442`.
- **Rascunho = subconjunto da fila** (status `ARCHIVED` em pending_approvals) — mig **040**, `c4e63d6`.
- **Feedback de classificação / requalificação** — mig **023**/**025**, `classification_feedback` (tabela presente).
- **Citação (quoted reply)** — mig **033**, `5348e79`.
- **Painel/fila de ação** (closer-suppression, resumo cacheado, engajamento) — `704a7ef`, `738c9b4`, `src/metrics.js` (`computePainel`).

### conversation_state (estado da conversa)
- **IA emite o estado** (AGUARDANDO_RECEPCAO | AGUARDANDO_CLIENTE | RESOLVIDO | INDEFINIDO), substitui heurística closer — mig **036**, `4f6b4d2`, `src/gemini.js` (`CONVERSA_STATES`).
- **Passo 1 — fix "bola vencida" na LEITURA**: saída nossa posterior ao estado vence "aguardando nós" (leitura só, não reescreve estado); aplicado em 3 pontos (`awaiting_reply` em `src/routes/tenant.js`, `esperandoNos` e `computePainel` em `src/metrics.js`) — `10324b0`.

### Gestão de Recursos (ADR-025 / ADR-026)
- **Schema `resources` no ar** — 9 tabelas em prod (`resource`, `capability`, `resource_capability`, `resource_availability`, `resource_exception`, `occupation_history`, `resource_source_binding`, `resource_sync_log`, `tenant_resource_config`) — migs **046** (recorrente), **047** (sync_log), **048** (datada); `3fc79cc`, `7f2a4ab`, `4fcceb3`.
- **Sincronizador diário** (Valinhos-only, adapter Extranet) — `2db2005`, `8cc3366`, `src/resources/{daily-sync.js,sync.js,adapters,extranet-lock.js,snapshot.js}`.
- **Cron do host 03:00** roda o sync: `0 3 * * * docker exec adr-lead-manager node /app/src/resources/daily-sync.js` — `deploy/crontab.resources-sync.txt` (confirmado em `crontab -l`).
- **Grade recorrente** (vãos por folga real, sweep-line, funde vãos adjacentes) + **desconta ocupação real** (slot_end, duração) — migs **049** (horário jsonb), **050** (occupation slot_end); `d31276b`, `cc6b763`, `29f70cf`, `src/resources/grade.js`.
- **Lock Extranet compartilhado** entre apps: `pg_advisory_lock(hashtext('extranet-access'))` — `src/resources/extranet-lock.js`.

### Multi-tenant / Infra
- **RLS por `app.current_tenant`** em todas as tabelas do schema (política `tenant_isolation`); backend seta o tenant por request (`src/db.js` `withTenant`).
- **RBAC + subscriptions/trial** — migs **006**/**007**, `src/rbac.js`, `src/subscriptionService.js`; cron de expiração de trial 06:00 e retenção de dados via `node-cron` em `src/server.js:106+`.
- **Credenciais Evolution cifradas por tenant** — mig **014**, `src/crypto.js`.

### Meta (Messenger/IG)
- **Onboarding de Página por-tenant** (start/callback/status, dupla-escrita transacional) — mig **015**, `375d1a1`, `src/onboardingMeta.js`, `src/routes/onboarding-meta.js`. ⚠️ código no ar mas ativação depende de envs (ver seção 4).
- **Ingestão Meta + resposta outbound (E6)** via `mensagem-meta` — `11a2d54`, `src/metaIngest.js`, rota em `src/routes/tenant.js`; `tenant_lead_source` genérico + field_map — mig **041**, `e0807d5`.

### Automação / Reativação / Notificação
- **Centro de automação (ADR-006)** — mig **032**, `539d008`, `src/routes/tenant.js` (GET/PUT automacao_config).
- **Reativação / dormência por tenant** (N de dormência, N de expiração) — migs **056**/**057** (`dormancy_days=7`, `reactivation_expiry_days=45` em prod), `5e09cd7`, `f97698a`, `src/jobs/detectar-silenciosos.js`.
- **Notificação à recepção** — mig **027**, `src/notificacao.js`.

---

## 2. EM SHADOW / OBSERVANDO (no ar, mas NÃO agindo)

- **Bola / Passo 2 (ADR-030) = `bola_mode='shadow'`** (confirmado em prod para Valinhos). Classifica a saída da recepção e loga em `bola_shadow_log`; **NÃO escreve `conversation_state`** — mig **058**, `5832c14`, `src/bolaGate.js`, `src/engine.js` (`classificarSaida`), endpoint `GET /tenant/:id/bola-shadow`.
  - **Falta pra ativar:** calibração lendo `bola_shadow_log`, depois **corte sincronizado** (ligar escrita + remover a compensação de leitura do Passo 1 no mesmo commit) — ver ADR-030 §Rollout.
- **Portão 0 / supressão por papel (ADR-029) = `gate_suppression_mode='shadow'`** (confirmado em prod). Loga o que faria em `gate_shadow_log`, sem agir — migs **054** (flag), **055** (log), `2d1b35e`, `5e09cd7`. Tabelas de apoio `contact_role`/`contact_role_member` (mig **051**), `subject_definition` (mig **052**).
  - **Falta pra ativar:** calibração + ligar `'on'`.
- **`classifier_shadow`** (mig **034**) — log histórico do classificador em modo sombra (fase 1). Tabela presente.

---

## 3. INCOMPLETO / PELA METADE

- **`feat/reasoning-surface`** (branch local **e** `origin/feat/reasoning-surface`, NÃO mergeada) — 6 commits à frente de main:
  - **ADR-022 "Surface A"** (doc existe SÓ nesta branch) — evento canônico agnóstico de fonte + hardening multi-tenant.
  - **Migration 044** (`extranet_unit_map`, ledger idempotente, `lead_eval_label`, colunas de progressão) — **NÃO aplicada em prod** (`to_regclass('lead_manager.extranet_unit_map')` = vazio).
  - Surfacing de `classification_reasoning` ("reasoning") em /leads/detalhe/kanban.
  - Lastro: `d5dad51`, `6356ee6`, `1177786`, `121b9d4`, `545ad3a`. **Isto explica o gap da migration 044.**
- **`feat/grade-recorrente`** (branch local, 1 commit `6d69961` "grade recorrente fatiada em células — fatia 1", NÃO mergeada). Provavelmente **superseı́da** pela grade já em main (`d31276b` etc.) — INCERTO (ver seção 6).
- **Onboarding Meta ao vivo**: código em main, mas ativação bloqueada por envs/registro (ver seção 4).

---

## 4. TRAVADO / BLOQUEADO

- **Meta onboarding ao vivo** — **envs CONFIRMADOS no container `adr-lead-manager`** (2026-07-01, `docker inspect`): `META_APP_ID=1042359435406836`, `META_APP_SECRET` (set), `META_LOGIN_CONFIG_ID=1711062123261550` (nome real do env — o doc antes chamava de `META_CONFIG_ID`), `META_WEBHOOK_VERIFY_TOKEN` (set), `PUBLIC_BASE_URL=https://leads-api.leovecchi.com`. Código pronto (`src/onboardingMeta.js`). **O que ainda falta pra recepção conectar uma Página:** o botão "Conectar Página do Facebook" do dashboard está só na branch `feat/onboarding-meta-page` (NÃO mergeada em `adr-whatsapp-scheduler`), então não há entrada no front em prod. Registro do `redirect_uri` na Meta e conexão real de alguma Página = não verificável daqui (seção 6).
- **Auto-send ao cliente (resposta automática da IA)** — **guardrail de produto**: nada automático antes de recepcionistas onboarded e definirem o que automatizar. Human-in-the-loop mantido por decisão, não por bug.
- **Scraping da Extranet** — Valinhos-only por desenho (momento 0, ADR-026). Depende de allowlist de IP (rate-limit 429 do LiteSpeed/Hostinger). Expansão a outras unidades = trabalho futuro (adapters por fonte).

---

## 5. DÍVIDA TÉCNICA / DOCUMENTAL

- **ADRs citados em main SEM documento** (cruzamento `git grep ADR-0XX` × `docs/adr/`): **001, 002, 008, 009, 010, 011, 016, 018, 019, 020, 021, 024, 027, 028, 029** — 15 números. Decisões vivem em código/migrations sem doc. (Docs existentes: 003, 004, 005, 006, 007, 025, 026, 030.)
- **ADR-022** existe como doc mas **só na branch** `feat/reasoning-surface` — não está em main nem citado em main.
- **Gaps de numeração de migration**: **021** (não existe arquivo em lugar nenhum) e **044** (só na branch reasoning-surface). Sequência de main: 001–020, 022–043, 045–058.
- **11 tabelas `bkp_*`** em prod (snapshots de operações: batch classify, latch, origem, stage sweep, etc.) — candidatas a limpeza pós-validação.
- **Credencial Extranet duplicada** (LM + Scheduler acessam a mesma Extranet) — mitigada por `pg_advisory_lock` compartilhado, mas é acoplamento entre apps.
- **`npm test` não fecha verde no host** (quedas de conexão no DB sob CPU steal ~90%; idêntico no HEAD limpo; zero AssertionError). Suítes de integração precisam rodar isoladas.

---

## 6. INCERTO — VERIFICAR

1. **Migrations 001–035 (as antigas) realmente todas aplicadas?** Inferido da presença de tabelas/colunas-chave (todas as tabelas esperadas existem), mas não há tabela de controle de versão — não verifiquei coluna-a-coluna das 56.
2. **`feat/grade-recorrente`** — superseı́da pela grade em main ou ainda pendente? O commit é "fatia 1" e a branch está muito atrás de main; precisa de decisão (mergear, descartar ou apagar).
3. **Meta onboarding — resíduo.** Envs no container: **RESOLVIDO — estão setados** (ver seção 4, `docker inspect adr-lead-manager`). Resta não-verificável daqui: se o `redirect_uri` foi registrado na Meta e se alguma unidade **de fato** conectou uma Página (nenhum tenant Meta ativo confirmado). O botão de conexão no dashboard segue em branch não-mergeada.
4. **Dashboard / console da recepção** — **RESOLVIDO: varrido em 2026-07-01.** Vive em `adr-whatsapp-scheduler/dashboard` (`/root/`), Express SSR em `agenda.leovecchi.com`, proxy fino deste LM via `leads-api.leovecchi.com`. Levantamento próprio em **`adr-whatsapp-scheduler/dashboard/docs/ESTADO.md`** (gêmeo deste). Não é mais zona cega.
5. **`webhook-dispatcher`** (`/apps/webhook-dispatcher`) — fronteia a Evolution para LM + Scheduler; não varri seu estado nem se o webhook da Evolution já aponta pra ele.
6. **ADR-022 / migration 044 / reasoning-surface** — intenção: mergear e aplicar, ou abandonar? Está parada há tempo; decisão humana.
7. **Números de ADR sem doc (001, 002, 008–021, 024, 027–029)** — quais merecem doc retroativo vs. quais são referências informais em comentário. Precisa de curadoria.
8. **Backups `bkp_*`** — quais já podem ser dropados (as operações que os geraram foram validadas)?
9. **Data real de "aplicação" das migrations em prod** — sem registro; não sei quando cada uma entrou, só que o objeto existe hoje.

---

_Zona cega: **8 itens em aberto** em "INCERTO — VERIFICAR" (o item 4 — dashboard — foi resolvido nesta rodada; o item 3 — Meta — foi reduzido: envs confirmados, resta só `redirect_uri`/Página conectada)._

> **Resolvidos nesta rodada** (2026-07-01, verificação read-only do ambiente):
> **(a) Envs do Meta** setados no container `adr-lead-manager` (§4, item 6.3).
> **(b) Dashboard** varrido e documentado em `adr-whatsapp-scheduler/dashboard/docs/ESTADO.md` (item 6.4).
