# ADR-022 — Progressão automática de lead guiada pelo scraping da Extranet (Surface A)

- **Status:** PROPOSTA (escopo; build não iniciado)
- **Data:** 2026-06-23
- **Contexto de produto:** Valinhos (tenant `ed731a58-62e5-45ad-acba-a5502ff39e92`)
- **Relaciona-se com:** Mecanismo 2 de ground-truth de recall (`lead_eval_label`,
  `source='derived_funnel'`); ADR-003 (classificação/triagem); ADR-007 (multicanal);
  origem imutável first-touch + dedup BR (migration 043).

> ⚠️ Numeração: o usuário pediu "ADR-003", mas esse número já existe. Adotado o
> próximo número livre **ADR-022** (o código referencia ADRs até 021).

---

## 1. Decisão (resumo)

A progressão do card é movida por um **evento canônico AGNÓSTICO DE FONTE** que o
lead-manager consome para avançar o funil sem clique humano:

- `experimental_realizada` → casa com um lead e avança o card para a etapa
  `experimental`. Se não casar com nenhum lead → cria um **lead de rua** (walk-in)
  já na etapa `experimental`.
- `matricula_confirmada` → conclui o lead como **ganho** (`desfecho=matriculado`,
  etapa `convertido`) + alerta à recepção (ver §6.4).

Cada evento **emite um rótulo positivo** em `lead_eval_label`
(`source='derived_funnel'`) — alimentando o Mecanismo 2 do recall.

**O evento canônico não sabe de onde veio.** As FONTES são *adapters* que o emitem
(ver §8.1): o **scraper da Extranet** (caminho-legado específico de **Valinhos**),
uma **tabela sincronizada por um BI** (futuro), ou um **evento nativo do Regente**
(tenants sem Extranet). Para Valinhos hoje, o adapter é o scraper — em modo
**leitura**, mantendo o guard `_assertValinhos` e a allowlist/cooldown já existentes.
O lead-manager **não acessa a Extranet**; recebe o evento canônico já parseado.

> **Checagem M0 (2026-06-23, read-only):** verifiquei se um BI já sincroniza
> contrato/matrícula para o Postgres local. **NÃO sincroniza** — só existe
> `app.aluno_professor_visto` (aluno visto na grade, sem evento de contrato). Logo a
> fonte de matrícula em Valinhos **continua sendo o scraping (M2)**. Se um dia o BI
> passar a sincronizar o contrato, basta um **novo adapter** emitindo
> `matricula_confirmada` — o consumidor não muda.

---

## 2. Onde vivem os dados hoje (ponto de junção)

### 2.1 Mesmo Postgres, dois schemas
Os dois apps compartilham o **mesmo database `adr_scheduler`**, em schemas distintos:

| Schema | Dono | Conteúdo relevante |
|---|---|---|
| `app` | scheduler (scraper) | `app.agenda_snapshot` (grade raspada, jsonb por franquia/semana), `app.franquia`, `app.usuario` |
| `lead_manager` | lead-manager (funil) | `leads`, `lead_eventos`, `tenant_lead_config`, `classification_feedback`, (proposto) `lead_eval_label` |

Hoje **o lead-manager NÃO lê `app.*`** (sem grant cross-schema). O scheduler já fala
com o LM **por HTTP** (`leads-api.leovecchi.com`, Bearer `SERVICE_TOKEN`) — é assim
que o painel da recepção mostra os leads do LM (`routes/leads.js`).

### 2.2 Onde a experimental raspada aterrissa
`app.agenda_snapshot(franquia_id, semana, snapshot jsonb, scraped_em, erro)`.
A grade é produzida por `dashboard/lib/agenda.js::buscarAgendaSemana` +
`dashboard/lib/parser.js::parseGrade`. Cada aula:
`{ aula_id, data, hora_inicio, hora_fim, sala, curso, aluno, status, experimental,
aulaStatus }`. `classificarStatus` emite hoje: `experimental | cancelada_aluno |
reposicao` (parser.js:154).

### 2.3 Dois canais possíveis de junção
- **(A) Push por API (RECOMENDADO):** o scheduler emite eventos → endpoint
  service-token no LM. Mantém a fronteira limpa, reusa o padrão scheduler→LM já
  existente, e deixa **toda a disciplina de read-only/budget/cooldown no único
  componente que toca a Extranet** (o scraper).
- **(B) Leitura cross-schema:** o LM lê `app.agenda_snapshot` direto. Evita um
  endpoint novo, mas acopla o LM ao formato jsonb do scheduler, exige grant em `app`,
  e espalha a responsabilidade de scraping. **Considerada e preterida.**

---

## 3. O que JÁ é raspado vs. o que falta

### 3.1 Experimental — ✅ já raspável
Flag `buscarDetalheExperimental` (agenda.js:123). Para aulas com `experimental=true`
e sem aluno na grade, busca `detalhar_aula.php?id=` e parseia
`parseDetalheAula → { aluno, responsavel }` (parser.js:205).

> ⚠️ **Gap de telefone:** o detalhe da experimental devolve **só NOME** (`aluno_exp`,
> `responsavel_exp`). **Não há telefone.** Logo a regra "telefone primeiro" **não é
> possível hoje** a partir do scrape — o casamento começa por **nome**. Investigar
> se `detalhar_aula.php` traz um campo de telefone não parseado (se sim, estender o
> parser destrava o match por telefone, bem mais confiável). Ver spec, tarefa S1.

### 3.2 Matrícula — ❌ NÃO raspável hoje → **decidido raspar (M2)**
A grade semanal só vê aula (experimental/cancelada/reposição). **Não há scraping de
matrícula/cadastro hoje.**

**Decisão (§6.2): M2 — nova view read-only.** Raspar a tela de cadastro/matrículas da
Extranet dá o **sinal direto e imediato** (sem o atraso de ~1 semana da inferência).
Custo: exige um alvo de scraping novo, dentro das mesmas regras read-only/budget/
cooldown. Pré-requisito: **investigar QUAL página/endpoint da Extranet expõe a
matrícula** e que campos casam com o lead (telefone/nome) — tarefa S7 no spec.
A inferência pela grade (ex-M1) fica como *fallback* opcional, não no caminho inicial.

---

## 4. Regra de casamento pessoa-da-Extranet ↔ lead

Ordem de tentativa (degrada para Revisar, nunca chuta):

1. **Telefone** (quando disponível — hoje só se a tarefa S1 destravar): match por
   telefone normalizado BR (reusa o dedup de migration 043 / `lib/telefone.js`).
   Único → **match forte**.
2. **Nome** (`aluno`; senão `responsavel`): normalizado (`normalizarNome`). Um único
   lead com nome compatível ⇒ **match médio**. Para crianças, o lead costuma estar no
   nome do **responsável** — tentar ambos.
3. **Ambíguo** (>1 candidato) ou **match fraco** (só primeiro nome, homônimo) ⇒
   **NÃO avança**: manda para a fila **Revisar** (`review_queue=true`) com o motivo e
   os candidatos, para a recepção confirmar.
4. **Sem match** ⇒ **lead de rua**: cria lead novo (origem `extranet`) já na etapa
   `experimental`.

Princípio: **falso match é pior que não-match**. Na dúvida, Revisar.

---

## 5. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| **Falso match** (avança o card errado / vaza dado entre leads) | Casamento conservador: só auto-avança em match único e forte; ambíguo → Revisar. Sem telefone, nome exige unicidade. Registrar candidatos no evento para auditoria. |
| **Idempotência** (avançar/concluir duas vezes; criar lead de rua duplicado) | Ledger de eventos por chave estável `(tenant, aula_id, tipo)` — evento já processado é no-op. Criação de lead de rua usa o `ON CONFLICT (tenant_id, phone)` existente; sem telefone, dedup por `(tenant, nome_normalizado, origem='extranet')`. Avanço de etapa só "para frente" (não regride). |
| **Multi-tenant** | Escopo travado em **Valinhos**: guard `_assertValinhos` no scraper já existe; o evento carrega `franquia_id` → mapeado para o `tenant_id` do LM (mapa explícito, ver spec S2). RLS do LM por `app.current_tenant` em toda escrita. |
| **READ-ONLY na Extranet** | Nenhuma escrita nova na Extranet. Só `GET` (`fetchAuthed`/`fetchDetalheAula`), respeitando budget de ciclo, cooldown e a allowlist de IP (187.127.253.63). M1 não toca a Extranet (lê snapshot já salvo). |
| **Conclusão automática sobre sinal raspado (M2)** | Conclui como ganho com `desfecho_source='extranet'` (≠ `recepcao`) + **alerta para a recepção** de que a mudança foi feita. **Se a recepção alterar o desfecho depois, vale a recepção** (humano tem prioridade absoluta; segue padrão da migration 042). Reversível. |
| **Nova superfície de scraping (M2)** | Mesmas regras read-only/budget/cooldown/allowlist do scraping atual; guard `_assertValinhos` mantido. Investigar a página de matrícula antes de codar (S7). |
| **Dedupe Meta↔Extranet sem âncora pelo caminho da experimental** | Checado (2026-06-23): a experimental raspada **só dá nome** (sem origem/campanha), e o marcador de origem **não é raspado hoje**. A âncora de origem vive no **canal de entrada** (`tenant_lead_source` / origem first-touch da migration 043), não na Extranet. Match Extranet↔lead se apoia em telefone (S1) / nome — **não** em origem. Mapear o módulo de captação da Extranet (se existir) é investigação read-only à parte (S8), com credenciais. |
| **Poluir o recall com positivos circulares** | `lead_eval_label` grava `ai_routed_to` (o que a IA decidira na entrada) ANTES da progressão — o sinal mede acerto/erro da IA, não a ação do scraper. |

---

## 6. Decisões (tomadas em 2026-06-23)

1. **Canal de junção:** ✅ **(A) push por API** — o scraper faz POST num endpoint
   service-token do LM. Cross-schema preterido.
2. **Matrícula:** ✅ **(M2) raspar tela nova** (read-only) — sinal direto, sem o
   atraso da inferência. Pré-requisito: investigação S7 (qual página expõe a
   matrícula). Inferência pela grade fica como fallback opcional.
3. **Telefone na experimental:** ✅ **investigar (S1)** — parsear `detalhar_aula.php`
   atrás de telefone; se existir, destrava o match forte por telefone.
4. **Conclusão automática:** ✅ **auto-concluir + alertar a recepção.** Ao detectar
   matrícula, marca ganho (`desfecho_source='extranet'`) **e emite um alerta** de que
   a mudança foi feita. **Se a recepção alterar depois, prevalece a recepção** (humano
   tem prioridade; divergência registrada — migration 042).

### Ainda a confirmar / investigar
5. **Mapa unidade↔tenant**: resolvido como **tabela `extranet_unit_map` sem
   fallback** (§8.2) — seed Valinhos. Tarefa S2.
6. **Marcador de origem na Extranet**: catalogar tela+seletor+formato do módulo de
   captação (se existir), com credenciais — tarefa S8. Não bloqueia a progressão
   (match é por telefone/nome); só destrava dedupe Meta↔Extranet pelo lado da Extranet.

---

## 7. Consequências

- **Positivas:** o funil avança sozinho nos dois marcos mais confiáveis (experimental
  e matrícula), captura leads de rua que hoje passam batido, e gera ground-truth
  positivo de graça para finalmente medir o recall (erro caro).
- **Custo/atenção:** novo ledger de eventos + endpoint service-token; **nova
  superfície de scraping read-only** para a matrícula (M2), pendente da investigação
  S7; o match por nome (sem telefone) joga mais casos para Revisar até S1 destravar.

---

## 8. Hardening multi-tenant (encodado 2026-06-23)

### 8.1 Evento canônico agnóstico de fonte (+ adapters)
O coração da Surface A é o **consumidor** do evento canônico
(`experimental_realizada`, `matricula_confirmada`) no lead-manager — ele **não sabe**
nem se importa de onde o sinal veio. Cada fonte é um **adapter** que traduz seu mundo
para o evento canônico:

| Adapter | Tenant | Status |
|---|---|---|
| Scraper Extranet (este ADR) | Valinhos | caminho-legado, em build |
| Tabela sincronizada por BI | futuro | só se/quando o BI sincronizar contrato |
| Evento nativo do Regente | tenants sem Extranet | futuro |

Consequência de design: **o scraping é detalhe de uma fonte, não a lógica central.**
Trocar/somar fonte = somar adapter; o consumidor, o matcher, o ledger e o painel
ficam intactos. É isso que faz a Surface A **escalar para tenants sem Extranet** em
vez de virar dívida de Valinhos.

### 8.2 Mapa de unidade→tenant como TABELA, sem fallback
`lead_manager.extranet_unit_map (id_unidade_extranet/slug → tenant_id)`, com Valinhos
como **1ª linha (seed)**. Regras:
- **SEM fallback hardcoded.** Evento cuja unidade **não está no mapa** é **REJEITADO
  e LOGADO** (`evento órfão`), **nunca** atribuído a Valinhos por default.
- **2º tenant = um INSERT, zero código.**
- O mapa mora no **lado do lead-manager (consumidor)**. O adapter/scraper **carimba o
  evento com o id da unidade** e **permanece ignorante de tenant**.

### 8.3 Matcher escopado por tenant, sempre
Toda chave de match — nome do aluno, telefone, dedupe do lead de rua — casa
**DENTRO do `tenant_id`**, nunca cross-tenant. A RLS protege o banco, mas o matcher é
**lógica de aplicação**: ele respeita o escopo do tenant **explicitamente** (não
delega só à RLS).

---

## 9. Decisões de produto já travadas (devem viver nos docs, não só no histórico)

1. **Nome do aluno separado do contato.** A extração (E1-03) captura o nome do
   **filho/aluno** quando difere de quem conversa; o match da Extranet usa o nome do
   aluno, não o do contato. Campo dedicado no lead (não sobrescreve `name` do contato).
2. **Proveniência + ator no card.** Toda progressão registra **fonte** (sistema vs.
   `user_id`) e **qual adapter/evento** disparou — sustenta o selo "avançou via check
   Extranet" e a trava manual (item 3).
3. **Trava manual com exceção barulhenta.** Humano move o card → **congela a
   auto-progressão** daquele lead. Exceção: **`matricula_confirmada` fura a trava** e
   move de novo, **com alerta obrigatório** à recepção (a matrícula é fato; o resto
   respeita a decisão humana).
4. **Idempotência do push.** Dedupe por **(id do registro na fonte + situação)**;
   reexecução do mesmo evento **não re-progride nem duplica**. (Ledger §S3.)
5. **Tag de origem distinta para lead de rua.** Walk-in ganha origem própria
   (`walk_in`), **separada** da origem de canal (Meta/WhatsApp/Google), para **não
   poluir o CAC por canal**.
