# ADR-025 — Gestão de recursos reserváveis multi-tenant + disponibilidade + agendamento assistido por IA

- **Status:** 🧭 **VISÃO / DECISÃO DE DESENHO** — não implementado. Registra o desenho
  completo; a implementação será **fatiada** em ADRs/épicos posteriores.
- **Data:** 2026-06-25
- **Autor:** sessão Claude Code (desenho a partir de decisões de produto do Leo)
- **Relacionados:**
  - ADR-024 (funil configurável — reservado; numeração)
  - ADR-003 (classificação/triagem; a camada de IA aqui reusa o padrão "IA como
    interface, dado como fonte de verdade")
  - ADR-007 (multicanal; mesmo princípio de **adapter plugável por tenant**)
  - [[no-auto-send-until-receptionists-onboarded]] (guardrail human-in-the-loop —
    governa a Fase de ação autônoma da camada de IA)
  - Extranet (Valinhos) — fonte de dados do **Momento 0** (scraping read-only)

> ⚠️ Este documento **registra a decisão de desenho**, não comportamento
> implementado. Nenhuma tabela, endpoint ou adapter descrito aqui existe ainda.
> Não usar como referência de comportamento atual. As **pendências** (§8) marcam
> o que ainda **não** está decidido.

> **Nota de numeração:** ADR-024 está **reservado** para "funil configurável".
> Este é o **ADR-025**, próximo número livre confirmado nesta sessão.

---

## 1. Contexto / motivação

A recepção precisa responder **na hora** a perguntas do tipo:

> "Dá pra encaixar uma experimental de **bateria** na **quinta às 15h**?"

Responder isso exige cruzar **três coisas no mesmo slot de horário**:

1. um **professor** que leciona o instrumento, **livre** naquele horário;
2. uma **sala compatível** com o instrumento (ex.: bateria só em estúdio),
   **livre** naquele horário;
3. a **disponibilidade** de ambos naquela data específica (descontando
   ocupações e exceções).

A **Extranet** da franquia (usada por Valinhos) fornece esses pedaços, mas em
**telas separadas**: a disponibilidade de salas numa tela, a de professores em
outra. A recepcionista hoje faz o cruzamento **de cabeça**, abrindo várias
abas. **O valor do Regente é juntar esses pedaços** num único motor de consulta
e numa resposta imediata.

Tudo deve ser **multi-tenant e configurável**: nada de "escola de música" ou
"bateria/estúdio" cravado no código. **Valinhos é a primeira configuração
(seed)**, não o modelo embutido. (Mesmo princípio já adotado no classificador —
[[classificador-multitenant]].)

---

## 2. Decisão 1 — Modelo canônico "recurso reservável"

Adotar um modelo **universal e configurável por tenant** de **recurso
reservável**.

### 2.1 Recurso e tipo
- **Recurso** tem um **tipo** (`sala`, `professor`, …) — conjunto **extensível**
  por tenant, não enumeração fechada.
- **Atributos por tipo** vivem numa **estrutura flexível** (não colunas rígidas),
  porque variam por tipo e por tenant:
  - **sala:** vocação / instrumentos compatíveis;
  - **professor:** instrumentos que leciona.

### 2.2 Tudo é dado, nada é cravado
Todos os itens abaixo são **configuração por tenant**, semeados para Valinhos:
- catálogo de **salas** + suas **vocações**;
- catálogo de **instrumentos**;
- catálogo de **professores**;
- **granularidade / representação de slot** (Valinhos = grade discreta de **1 hora** —
  ver §2.3);
- **dias de funcionamento** (Valinhos = **seg–sáb**);
- **regra de compatibilidade sala↔instrumento** (ex.: "bateria só em estúdio").

> **Valinhos = seed**, não default embutido. Outro tenant pode ter granularidade
> de 30 min, funcionar dom–dom, e ter tipos de recurso diferentes.

### 2.3 Granularidade de slot é por-tenant — NUNCA 1h cravado

**Decisão explícita** (levantada ao pensar em outras franquias e outras empresas):
o **1 hora discreto é uma propriedade do tenant Valinhos e da fonte Extranet**, não
do modelo canônico. Assumir 1h no schema/motor seria um erro arquitetural que
travaria a multi-tenancy.

- O modelo canônico trata a **duração/granularidade do slot como configuração do
  tenant**, não constante. Outras unidades franqueadas podem usar 30 min, 45 min, 50
  min; **outras empresas** (fora de academia de música) podem ter durações próprias.
- Não assumir sequer que o slot é uma **grade fixa alinhada**. O modelo deve
  comportar, no mínimo:
  - **grade discreta** com passo configurável (Valinhos: passo 1h) — caso atual; **e**
  - **intervalos contínuos** `[início, fim)` de **duração variável** por reserva
    (alguns negócios marcam "das 14:10 às 15:40"), sem encaixar numa grade.
- Consequência prática: representar disponibilidade/ocupação como **intervalos
  temporais** (`início`/`fim`/`duração`) é o canônico; a **grade de 1h da Extranet é
  só uma projeção** que o **adapter de scraping** produz a partir da fonte. O motor
  de interseção (§3) opera sobre **sobreposição de intervalos**, não sobre "células
  de 1h".
- A **granularidade de apresentação** (de quanto em quanto a recepção vê/oferece
  horários) também é config de tenant, e pode diferir da granularidade real da
  reserva.

> Regra de ouro: **nenhuma constante de duração de slot no código**. Tudo deriva da
> config do tenant; Valinhos apenas a preenche com 1h.

### 2.4 Três vínculos (os cruzamentos)
O poder do modelo está em três relações de cruzamento:
1. **professor ↔ instrumento** (quem leciona o quê);
2. **sala ↔ instrumento** (onde cada instrumento pode ser tocado);
3. **recurso ↔ disponibilidade** (quando cada recurso está livre).

### 2.5 Distinção temporal crítica
A disponibilidade **não é um único conceito**. Há três camadas, e a confusão
entre elas é a principal fonte de erro:

| Camada | O que é | Exemplo |
|---|---|---|
| **Disponibilidade RECORRENTE** | padrão **semanal** (grade) | "professor X dá aula ter/qui 14h–18h" |
| **OCUPAÇÃO pontual** | reserva numa **data** específica | "sala 3 reservada 2026-07-09 15h" |
| **EXCEÇÃO** | feriado / férias / bloqueio | "2026-07-09 é feriado; tenant fechado" |

> **Consulta de uma data futura =**
> **padrão recorrente** **−** **ocupações daquela data** **−** **exceções daquela data**.

Essa fórmula é o coração do modelo: a grade recorrente diz o que *normalmente*
está livre; ocupações e exceções **subtraem** disso para uma data concreta.

---

## 3. Decisão 2 — Motor de interseção

Um **motor de interseção** que, dado **(instrumento + dia + horário)**, retorna:

```
professores que lecionam o instrumento E livres no slot
        ∩
salas compatíveis com o instrumento E livres no mesmo slot
```

Ou seja: o conjunto de **(professor, sala)** viáveis para aquele instrumento
naquele slot. **É exatamente a consulta que responde a pergunta da recepção.**

- Entrada: instrumento, dia/data, faixa de horário.
- Saída: pares viáveis (ou vazio, com o motivo — sem professor / sem sala).
- Usa a fórmula temporal de §2.5 para resolver "livre" numa data concreta.

---

## 4. Decisão 3 — Regra de validação de agendamento

**Decisão de produto do Leo.** Ao agendar uma **experimental** que pode virar
**contrato longo** (matrícula recorrente), **NÃO** se tenta **provar
disponibilidade no futuro inteiro**:

- Provar o futuro inteiro é **impraticável** — sempre há um feriado isolado, uma
  semana de férias, um bloqueio pontual lá na frente. Exigir um slot 100% limpo
  por meses recusaria matrículas válidas.

**Regra adotada:**
> Se o slot **recorrente** está **estável pelas próximas ~3 semanas**, infere-se
> (≈100% dos casos) que **serve para o contrato todo**.

- Um **feriado pontual no futuro NÃO é impeditivo**: **remarca-se a aula
  isolada**, não se **recusa a matrícula**.
- A janela de ~3 semanas é **parâmetro** (provável configuração por tenant — ver
  §8), não constante mágica.

---

## 5. Decisão 4 — Adapters plugáveis por tenant (evolução de fonte em 3 tempos)

A **fonte** dos dados de disponibilidade evolui em três tempos. **Todos
produzem o mesmo evento / formato canônico** (§2), de modo que o motor de
interseção e os dashboards **não mudam** quando a fonte muda — só se troca o
adapter.

### Momento 0 — hoje: adapter de SCRAPING da Extranet (SÓ LEITURA)
- Lê a Extranet da franquia. URLs conhecidas:
  - `disponibilidade_salas_lista.php?id_sala=X`
  - `mod_professores/buscar_lista.php?curso=X…`
- **Formato de origem:** tabela **recurso × dia × slots de 1h**.
- **Sem escrita automática** — risco alto de corromper a grade da franquia.
  Read-only é inegociável neste momento.

### Momento 1 — em breve: adapter de API da franquia (BIDIRECIONAL)
- A franquia abrirá uma **API** (acordo já fechado). Adapter **leitura +
  escrita**, habilitando **agendamento autônomo seguro**.
- **Spec da API a definir com a franquia** (projeto à parte). **Deixar o adapter
  previsto** na arquitetura; **plugar quando a spec chegar**.

### Momento 2 — futuro: motor de agendamento NATIVO do Regente
- Para tenants **sem** Extranet/API: o Regente é a **fonte de verdade**,
  guardando grade/ocupação/exceção no próprio modelo canônico.

> O modelo canônico (§2) é justamente o que permite os três momentos coexistirem:
> o adapter **traduz a fonte** para o canônico; o resto do sistema só conhece o
> canônico.

---

## 6. Decisão 5 — Dois dashboards (mesmo modelo, públicos diferentes)

Ambos leem o **mesmo modelo canônico**; diferem no público e na pergunta.

### 6.1 Recepção / Operação
- Consulta **pontual**: "dá pra encaixar X?" → **resposta imediata**.
- Orientado a **agendar** (a próxima ação é marcar a experimental).

### 6.2 Gestão
- **Ocupação agregada** dos recursos: taxa de uso, **saturação**, **ociosidade**.
- Serve à **decisão de investir**: contratar professor, abrir sala.
- **Conecta com o tier de consultoria** (insight de gestão como produto).

---

## 7. Decisão 6 — Camada de pergunta em linguagem natural (faseada por segurança)

A recepção pergunta em **linguagem natural** ("dá pra encaixar bateria quinta à
tarde?"). A IA:
1. **traduz** a pergunta para a **consulta de interseção** (§3) — **não inventa
   disponibilidade**; o **dado é a fonte de verdade**;
2. **responde** em linguagem natural.

> **IA é interface, não motor.** Mesma postura do ADR-003: a IA estrutura/traduz;
> a verdade vem do dado.

### Fases (por segurança, alinhadas aos Momentos de §5)
- **(a) CONSULTA** — só lê e responde. **Seguro já no Momento 0** (scraping).
- **(b) AÇÃO-COM-CONFIRMAÇÃO** — "encontrei o slot, **confirma que marco?**".
  Enquanto a fonte for **scraping**, a IA **nunca escreve sozinha** — a confirmação
  humana e a escrita manual permanecem.
- **(c) AÇÃO AUTÔNOMA** — a IA **marca a experimental sozinha** + **notifica a
  recepção**. **Só seguro no Momento 1** (API bidirecional). Governada pelo
  guardrail [[no-auto-send-until-receptionists-onboarded]].

### Notificação pós-agendamento — CONFIGURÁVEL por tenant
- **autônomo + aviso** (marca e avisa) **vs.** **propõe-e-confirma** (pede OK antes).
- É **configuração de tenant**, não comportamento fixo.

---

## 8. Pendências (abertas — NÃO decididas aqui)

> **Nota:** a modelagem de tabelas e a proveniência do catálogo (antes itens 1 e 2
> desta lista) foram **resolvidas pela Emenda** ao final deste ADR. As pendências
> abaixo são as que **permanecem abertas**.

Marcadas explicitamente como **abertas**; serão resolvidas nas fatias de
implementação:

1. **Spec da API da franquia** (Momento 1) — formato, autenticação, semântica de
   escrita; projeto à parte, conduzido com a franquia. O adapter está **previsto**,
   não detalhado.
2. **Conteúdo real de `api-salas-grade.php`** (grade preenchida) — **detalhe de
   implementação do adapter scraper**, não bloqueia o modelo. Confirmado que a
   Extranet expõe ocupação datada + exceção (ver [[extranet-agenda-datada-confirmada]]);
   falta só capturar o HTML preenchido quando for construir o scraper.
3. **Janela de validação** (~3 semanas, §4) — confirmar se é parâmetro por tenant
   e seu default.
4. **Unificação física de `resource_source_binding` com o painel de Conexões** —
   **deferida** para quando o painel de Conexões/Integrações for construído; o
   **conceito** já está travado (ver Emenda, DP-D). Hoje vive como tabela própria
   no domínio de recursos.
5. **Ordem de construção das fatias** — `recorrente → ocupação → exceção → engine`
   de interseção, com o adapter de scraping read-only e o dashboard de recepção em
   modo CONSULTA antes de qualquer escrita.

---

## 9. Consequências

- **Positivas:** uma pergunta da recepção que hoje exige cruzar telas manualmente
  vira **uma consulta**. O modelo canônico isola o sistema da evolução da fonte
  (scraping → API → nativo). A camada de IA entra **sem risco** já no Momento 0
  (só consulta). Gestão ganha visão de ociosidade/saturação para decisão de
  investimento (tier de consultoria).
- **Custos / riscos:** scraping é **frágil** (depende do HTML da Extranet) e
  **read-only obrigatório**; a distinção temporal (§2.5) é sutil e fácil de errar;
  escrita autônoma só é segura no Momento 1. A flexibilidade do modelo (atributos
  por tipo, vínculos) tem custo de modelagem — agora **endereçado na Emenda**
  (modelo de tabelas + proveniência do catálogo).

---

## Emenda — modelagem de tabelas e proveniência do catálogo (resolve §8)

- **Status:** 🧭 **DECISÃO DE DESENHO — NÃO IMPLEMENTADO.** Nenhuma tabela,
  migration ou código de aplicação existe. Encoda o schema e a proveniência em
  prosa; a implementação será fatiada depois.
- **Data:** 2026-06-26
- **Autor:** sessão Claude Code (decisões de produto/arquitetura do Leo)
- **Relacionados:** ADR-007 (Provider/Asset; reconciliação no M2), ADR-008
  (`ServiceBooking` / motor de agendamento nativo — fronteira de não-duplicação),
  [[extranet-agenda-datada-confirmada]] (a Extranet expõe ocupação datada + exceção),
  [[adr-025-gestao-recursos]].

> ⚠️ Esta emenda **resolve** o que antes era pendência §8.1 (modelagem de tabelas)
> e a parte estrutural da proveniência do catálogo. **Continua sendo desenho**, não
> comportamento implementado.

### E.1 Decisões resolvidas

- **DP-A — Junção com a fonte.** `resource` é chaveado por **`external_ref`** (a
  junção com a fonte). Campos **`provider_id` / `asset_id` NULLABLE** ficam
  **reservados** para reconciliar com `regente_core` (Provider/Asset do **ADR-007**)
  no **Momento 2**.
- **DP-B — Nenhuma granularidade no core.** Toda disponibilidade, ocupação e
  exceção é **intervalo meio-aberto `[início, fim)`**. "Slot de 1h" é propriedade do
  **adapter da fonte** (Valinhos emite 1h) e da **config de oferta** (passo de
  varredura), **jamais do schema**. Outro tenant com 45/50/90 min **não exige
  migração**. (Consolida §2.3.)
- **DP-C — Mapa de status é config.** O mapa `status_bruto → (status_canônico,
  ocupa?)` é **configuração por adapter/tenant**. A engine de disponibilidade lê
  **só o booleano `ocupa?`**. Fontes futuras têm códigos próprios — multi-tenant,
  nada cravado. (Os códigos 200/210/220/300/310/320 da Extranet são **um** mapa,
  não **o** mapa.)
- **DP-E — Isolamento.** Schema **`resources`**, com **RLS por `tenant_id` em todas
  as tabelas** (alinha [[lead-manager-rls-tenant-context]]).
- **DP-F — `capability` é genérico.** `capability` = **instrumento** para Valinhos;
  **modalidade / especialidade** para outros nichos. Valinhos **semeia** as
  capabilities a partir dos **cursos da Extranet**.
- **DP-G — Duração é da capability; passo ≠ duração.** **Duração** é propriedade da
  **capability**: **default no tenant** (`tenant_resource_config`), **override por
  capability** (nullable, herda do tenant se vazio). O **passo de varredura ≠
  duração da reserva**. Prova concreta: Valinhos tem **projeto de BANDA = 1,5h**
  (reserva professor + sala) ao lado da **aula individual de 1h**.
- **DP-D — O catálogo INTEIRO é sourced (estrutural).** Não só a ocupação: o
  catálogo inteiro tem **proveniência por linha**. **Dois escritores desde o
  design:**
  1. **adapter de scraping** (unidades ADR, **M0**): catálogo é **espelho
     read-only** — a **Extranet é dona da verdade**;
  2. **configurador nativo do Regente** (outras empresas): catálogo é a **fonte da
     verdade**, **editável na UI**.

  O catálogo é o **CONTRATO** entre o configurador e o futuro **motor de
  agendamento**: o motor (**ADR-008**) **LÊ** este catálogo e **ESCREVE** ocupação.

  **Proveniência é uma propriedade POR INFORMAÇÃO, controlada por um TOGGLE — não
  "interno OU externo cravado por tabela isolada".** Cada informação do catálogo
  carrega o toggle **"esta informação vem de fonte externa?"**:
  - **LIGADO:** os campos de **configuração da fonte externa** (qual conexão, quais
    credenciais, quais parâmetros) ficam **ativos** para preenchimento e ativação; a
    informação passa a ser **espelho** da fonte.
  - **DESLIGADO:** a informação é **interna do Regente** (fonte da verdade nativa,
    editável na UI).

  Esse toggle é a **forma granular do painel de Conexões/Integrações canônico**
  (Meta/WhatsApp/Conta Azul/banco): o **binding externo só se materializa quando o
  toggle está ligado**. Isto **substitui a noção anterior** de
  `resource_source_binding` como **tabela-ilha** / tela separada: o binding
  **continua existindo como dado** (consequência do toggle), mas **não** é uma
  configuração à parte — é a projeção, no domínio de recursos, do painel de Conexões.
  A **unificação física** com uma `tenant_connection` única segue **DEFERIDA** para
  quando o painel de Conexões for construído (§8.4); o **conceito está travado agora**.

### E.2 Modelo de tabelas (schema `resources` — prosa, não DDL)

1. **`resource`** — `tenant_id`, `type` (enum **extensível** `ROOM`/`TEACHER`/…),
   `external_ref`, `name`, `attributes` **JSONB** (vocação etc.), `provider_id` /
   `asset_id` **nullable** (reserva M2 — DP-A), `source_binding_id`, `active`.
2. **`capability`** — `tenant_id`, `external_ref` (curso), `name`,
   `source_binding_id`. Genérica (DP-F).
3. **`resource_capability`** — `resource_id`, `capability_id`. **UMA tabela resolve
   dois cruzamentos**: **competência** (professor↔capability) **e vocação**
   (sala↔capability).
4. **`resource_availability`** — `resource_id`, `weekday` (1–6, seg–sáb),
   `start_time`, `end_time`, `source_binding_id`. Termo **RECORRENTE**. **Intervalos,
   sem slot** (DP-B).
5. **`occupation_snapshot`** — `tenant_id`, `resource_id`, `occupied_on`,
   `starts_at`, `ends_at`, `external_ref` (id da aula), `raw_status`,
   `canonical_status`, `occupies` (bool **derivado do mapa de config** — DP-C), `raw`
   **JSONB**, `scraped_at`, `source_binding_id`. Termo **OCUPAÇÃO no M0** —
   **projeção read-only, NÃO é sistema de registro**. No **M2** a ocupação é
   `service_booking` (**ADR-008**), via o contrato `OccupationSource` (**interface no
   código, NÃO tabela nova**).
6. **`resource_exception`** — `resource_id` **NULLABLE** (null = **tenant-wide**, p/
   feriado), `starts_at`, `ends_at`, `type`
   (`HOLIDAY`/`VACATION`/`MAINTENANCE`/`CLOSURE`), `reason`, `source_binding_id`.
   Termo **EXCEÇÃO**. **Distinto de booking cancelado:** cancelado **libera** o slot;
   exceção **BLOQUEIA**.
7. **`tenant_resource_config`** — `tenant_id`, default `slot_step_minutes`,
   `default_duration_minutes`, `working_days`, `working_hours`, `week_start`. **Borda
   de oferta.** Override por capability (campos nullable que herdam se vazios — DP-G).
8. **`resource_source_binding`** — `tenant_id`, `kind`
   (`SCRAPE_EXTRANET`/`NATIVE`/`API`), `config` (**credenciais cifradas — MESMO
   modelo do token Meta existente**), `status`. **Projeção do painel de Conexões** no
   domínio de recursos (DP-D).

### E.3 Fronteira com o ADR-008 (ponto de não-duplicação)

- O **`ServiceBooking` do ADR-008 É** o termo ocupação no mundo nativo (**M2**).
  **NÃO duplicar.** `occupation_snapshot` é a **projeção M0**; a engine consome o
  contrato **`OccupationSource`**, **agnóstico de fonte** (snapshot no M0,
  `ServiceBooking` no M2).
- **ADR-008 = VALIDADOR write-time** de um booking concreto (tríplice colisão,
  `SELECT FOR UPDATE`). Só vale ao **ESCREVER** (M1/M2). No **M0 não há escrita**.
- **Engine de interseção do ADR-025 = DESCOBERTA read-time**: `(capability, dia,
  slot) → professores compatíveis livres ∩ salas compatíveis livres`. O ADR-008
  **não faz isso** (valida **UM** par, não **varre** o espaço).
- `resource` **reconcilia** com **Provider/Asset (ADR-007)** por `external_ref` no
  **M2**.

> ⚠️ **Aviso de nomenclatura — `OccupationSource` NÃO é tabela.**
> `OccupationSource` é um **contrato de código** (abstração interna de **como a
> aplicação lê ocupação**, agnóstica de fonte), **não** uma tabela nem uma entidade
> de banco. **NÃO criar tabela `occupation_source` na migration.** A ocupação **é
> persistida** em `occupation_snapshot` (M0 — alimentada por scraping/API/fonte
> interna) e, no **M2**, em `service_booking` (ADR-008). O **dashboard** e as
> **consultas leem dessas TABELAS**. `OccupationSource` é só a **regra interna** que
> faz o código **não se importar de qual das duas** a resposta veio.

### E.4 Fórmula de disponibilidade

```
livre(recurso, data, slot) ⇔
      ∃ availability cobrindo weekday(data) + slot
  ∧ ¬∃ occupation com occupies = true em data + slot
  ∧ ¬∃ exception cobrindo data + slot
```

(É a fórmula RECORRENTE − OCUPAÇÃO − EXCEÇÃO de §2.5, agora ancorada nas tabelas 4,
5 e 6.)
