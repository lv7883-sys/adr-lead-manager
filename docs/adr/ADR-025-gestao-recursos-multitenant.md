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
- **granularidade de slot** (Valinhos = **1 hora**);
- **dias de funcionamento** (Valinhos = **seg–sáb**);
- **regra de compatibilidade sala↔instrumento** (ex.: "bateria só em estúdio").

> **Valinhos = seed**, não default embutido. Outro tenant pode ter granularidade
> de 30 min, funcionar dom–dom, e ter tipos de recurso diferentes.

### 2.3 Três vínculos (os cruzamentos)
O poder do modelo está em três relações de cruzamento:
1. **professor ↔ instrumento** (quem leciona o quê);
2. **sala ↔ instrumento** (onde cada instrumento pode ser tocado);
3. **recurso ↔ disponibilidade** (quando cada recurso está livre).

### 2.4 Distinção temporal crítica
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
- Usa a fórmula temporal de §2.4 para resolver "livre" numa data concreta.

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

Marcadas explicitamente como **abertas**; serão resolvidas nas fatias de
implementação:

1. **Modelagem exata das tabelas** — `recurso`, `slot`, `ocupação`, `exceção`,
   `vínculo` (professor↔instrumento, sala↔instrumento, recurso↔disponibilidade).
   Estrutura concreta, chaves, índices, RLS por tenant — tudo a definir.
2. **Scraping vs. grade recorrente × datas** — investigar como o adapter de
   scraping lida com **grade recorrente** vs. **datas concretas**. A Extranet tem
   uma visão **"Agenda por dia/mês"**: descobrir se ela dá **datas reais**
   (ocupações/exceções pontuais) **além do padrão recorrente**, ou só o padrão.
3. **Spec da API da franquia** (Momento 1) — formato, autenticação, semântica de
   escrita; projeto à parte, conduzido com a franquia.
4. **Janela de validação** (~3 semanas, §4) — confirmar se é parâmetro por tenant
   e seu default.
5. **Ordem de implementação das fatias** — qual fatia entrega valor primeiro
   (provável: modelo canônico + adapter scraping read-only + motor de interseção +
   dashboard de recepção em modo CONSULTA, antes de qualquer escrita).

---

## 9. Consequências

- **Positivas:** uma pergunta da recepção que hoje exige cruzar telas manualmente
  vira **uma consulta**. O modelo canônico isola o sistema da evolução da fonte
  (scraping → API → nativo). A camada de IA entra **sem risco** já no Momento 0
  (só consulta). Gestão ganha visão de ociosidade/saturação para decisão de
  investimento (tier de consultoria).
- **Custos / riscos:** scraping é **frágil** (depende do HTML da Extranet) e
  **read-only obrigatório**; a distinção temporal (§2.4) é sutil e fácil de errar;
  escrita autônoma só é segura no Momento 1. A flexibilidade do modelo (atributos
  por tipo, vínculos) tem custo de modelagem — daí estar em **pendência** (§8.1).
