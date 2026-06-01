# ADR-003 — Estratégia de classificação, triagem e convivência do AI Lead Manager

- **Status:** Aprovado
- **Data:** 2026-06-01
- **Autor:** ATLAS (arquitetura)
- **Relacionados:** ADR-001 (isolamento Lead Manager × Scheduler), ADR-002 (multi-tenant + RLS), E6-02 (webhook Z-API), E7-01 (config por tenant)
- **Decisores:** Plataforma / Produto / Engenharia

---

## 1. Contexto

O WhatsApp da Academia do Rock é **canal único, indiferenciado, para todos**:
gestores e franqueadores, equipe interna (recepção), alunos matriculados,
leads novos, leads frios, fornecedores/parceiros e spam — tudo entra pelo
mesmo número.

O AI Lead Manager **não pode interferir em nenhuma dessas conversas, exceto
quando identificar um lead qualificável**. Um falso positivo (responder a um
gestor ou aluno como se fosse lead) é um incidente de imagem **real e caro** —
o constrangimento é com a pessoa errada, no canal mais sensível do negócio.

Já existe um **Scheduler** em produção que processa parte dessas mensagens.
O Lead Manager é um sistema **separado** (container, schema `lead_manager`,
RLS — ver ADR-001/002) e precisa coexistir sem duplicar respostas nem
"roubar" conversas que não são dele.

Premissa de volume: por ser canal único, a maior parte do tráfego **não é
lead novo**. Qualquer arquitetura que rode IA cara em 100% das mensagens é
desperdício de custo e de latência, além de aumentar a superfície de erro.

> **Tese central deste ADR:** as decisões 1–4 não são escolhas isoladas entre
> A/B/C — elas se compõem em um **funil de triagem em cascata**, do filtro
> mais barato e determinístico ao mais caro e probabilístico. "Não é lead" é
> o caminho default e silencioso; "é lead" precisa atravessar todos os
> portões. Cada portão reduz custo, latência e risco de falso positivo do
> portão seguinte.

### Pipeline de decisão (visão integrada)

```
              mensagem recebida (webhook E6-02, contato desconhecido ou não)
                                   │
            ┌──────────────────────▼───────────────────────┐
   Portão 0 │ known_contacts lookup (determinístico, ~0ms)  │  Decisão 2
            │  conhecido? (equipe/gestor/aluno/fornecedor)  │
            └──────────┬───────────────────────┬────────────┘
                  conhecido                desconhecido
                       │                        │
                IGNORA (silêncio)               ▼
              domínio do Scheduler   ┌────────────────────────┐
                                     │ Portão 1: classificador │  Decisão 1
                                     │ leve (Gemini Flash,     │
                                     │ prompt de triagem curto)│
                                     └──────┬──────────┬───────┘
                                       não-lead      lead potencial
                                      (spam/etc.)        │
                                          │              ▼
                                   IGNORA / humano  ┌──────────────────────┐
                                                    │ Portão 2: mitigação   │  Decisão 4
                                                    │ de falso positivo     │
                                                    │ (proveniência +       │
                                                    │  histórico + threshold)│
                                                    └───┬───────────────┬────┘
                                              fonte rastreável     orgânico/ambíguo
                                              + alta confiança          │
                                                    │                   ▼
                                                    ▼            FILA DE APROVAÇÃO
                                            FLUXO COMPLETO        (recepcionista)
                                            (resposta automática)  Decisão 4-A
                                                    │
                                          [lock de ownership da conversa] Decisão 3
```

---

## 2. Decisão 1 — Estratégia de classificação

**Pergunta:** como o Gemini decide o que é lead vs. todo o resto?

### Opções
- **(A) Classificador leve primeiro** (modelo menor / prompt curto) → só "lead
  potencial" segue para o fluxo completo.
- **(B) Consulta à base de contatos conhecidos antes do Gemini** → números
  conhecidos são ignorados sem chamar IA.
- **(C) Gemini analisa tudo com um prompt de triagem** e decide a ação.

### Trade-offs

| Critério | (A) Classificador leve | (B) Lookup de contatos | (C) Gemini em tudo |
|---|---|---|---|
| Custo de API | Baixo (Flash) por msg, mas roda em todas | **Zero** (DB local) | Alto — paga IA em 100% do tráfego |
| Latência | ~Baixa (1 hop IA) | **~0ms** (índice local) | Média/alta + variabilidade |
| Falso positivo | Reduzido vs. C | Elimina a maior classe (conhecidos) | **Maior risco** |
| Falso negativo | Depende do prompt/threshold | Não classifica leads (não é seu papel) | Depende do prompt |
| Cobertura | Não conhece "quem é" o número | Não entende **conteúdo** | Entende conteúdo |

O ponto cego de cada opção é exatamente a força da outra: (B) sabe *quem* é o
número mas não *o que* a mensagem diz; (A)/(C) entendem o conteúdo mas não a
identidade. Tratá-las como excludentes é um falso dilema.

### ✅ Decisão
**Cascata B → A.** Lookup determinístico de `known_contacts` **primeiro**
(Portão 0); apenas contatos desconhecidos chegam ao **classificador leve**
(Portão 1) com Gemini **Flash/Flash-Lite** e prompt de triagem curto que
retorna saída estruturada:

```json
{ "label": "lead | not_lead | uncertain", "confidence": 0.0-1.0, "reason": "..." }
```

Somente `label = lead` (acima do threshold) avança ao **fluxo completo**
(prompt rico, ferramentas, geração de resposta). **Rejeitamos (C) puro** como
arquitetura primária: rodar o prompt completo em todo o tráfego é caro,
mais lento e maximiza a chance de falso positivo.

### Riscos residuais
- Classificador leve pode errar em mensagens ambíguas → mitigado pelo Portão 2
  (Decisão 4) e pelo label `uncertain` cair em revisão humana.
- Threshold mal calibrado → instrumentar com métricas de precisão/recall desde
  o dia 1 e iniciar conservador (threshold alto).

---

## 3. Decisão 2 — Lista de contatos conhecidos

**Pergunta:** como manter a lista de números que **nunca** devem ser tratados
como lead (equipe, gestores, fornecedores, alunos matriculados)?

### Opções
- **(A)** Tabela local `known_contacts` com sync periódico da extranet +
  cadastro manual da equipe interna.
- **(B)** Confiar 100% no classificador, sem lista de exclusão.
- **(C)** Whitelist/blacklist configurável por tenant no painel admin.

### Trade-offs
- **(B) é a raiz do risco crítico** deste ADR. Sem lista determinística, a
  única defesa contra responder a um gestor/aluno é um modelo probabilístico —
  inaceitável para o custo de um falso positivo aqui. **Rejeitada.**
- **(A)** dá a fonte de verdade (alunos via sync; equipe via cadastro), mas
  precisa de processo de manutenção.
- **(C)** é a *interface* de manutenção, não uma alternativa: é como humanos
  corrigem/complementam (A).

### ✅ Decisão
**(A) + (C) combinadas.** Tabela `lead_manager.known_contacts` (por tenant,
sob RLS) é o **mecanismo**; as **fontes** são três:
1. **Sync periódico** da extranet/CRM → alunos matriculados (job agendado).
2. **Cadastro manual** → equipe interna, gestores, franqueadores, fornecedores
   (conjunto pequeno e estável).
3. **Painel admin (C)** → CRUD e correções, reaproveitando o padrão de E7-01.

Esboço de schema (a detalhar na implementação):

```
known_contacts(
  tenant_id  uuid  -- RLS
  phone      text  -- E.164, índice único (tenant_id, phone)
  kind       text  -- staff | manager | franchisee | student | supplier | partner | blocked
  source     text  -- sync | manual | admin
  label      text
  created_at, updated_at
)
```

O Portão 0 faz `lookup(tenant_id, phone)`; qualquer match ≠ lead →
Lead Manager ignora. `kind = blocked` cobre spam recorrente conhecido.

### Riscos residuais
- **Janela de staleness:** aluno que acabou de matricular e ainda não entrou no
  sync pode ser visto como lead. Aceitável e mitigável: (i) sync frequente;
  (ii) Portão 2 + histórico capturam a maioria; (iii) o pior caso é uma
  saudação de lead a um aluno novo — incômodo baixo, não com gestor.
- **Número compartilhado / troca de número:** match por telefone é imperfeito;
  manutenção via painel resolve casos pontuais.

---

## 4. Decisão 3 — Convivência com o Scheduler

**Pergunta:** quando o Lead Manager recebe a mensagem e decide que **não** é
lead, o que acontece?

### Opções
- **(A)** Ignora silenciosamente; o Scheduler continua tratando normalmente.
- **(B)** Publica evento em fila para o Scheduler processar.
- **(C)** Ambos recebem o webhook e cada um decide independentemente.

### Trade-offs

| Critério | (A) Ignora | (B) Fila p/ Scheduler | (C) Ambos recebem |
|---|---|---|---|
| Isolamento | Alto | **Acopla** os sistemas | Alto |
| Risco de msg dupla | Baixo (domínios disjuntos) | Baixo | **Médio** (dois respondedores) |
| Complexidade | Baixa | Média (contrato de fila) | Baixa de orquestração |
| Quem entrega o webhook? | precisa fan-out | LM na frente | provider → 2 endpoints |

Observação-chave: **(A) e (C) não competem** — (C) descreve a *ingestão*
(quem recebe o webhook) e (A) descreve a *ação* do Lead Manager quando não é
lead. A pergunta real é dupla: (i) como ambos recebem a mensagem; (ii) como
garantir **um único respondedor** por conversa.

Por construção, os domínios são **disjuntos**: o Portão 0 garante que o Lead
Manager só age sobre **desconhecidos qualificados** (aquisição de leads novos),
enquanto o Scheduler trata os **conhecidos** (agendamentos de alunos, fluxos
internos). Eles, em regime normal, não disputam a mesma conversa.

### ✅ Decisão
**Ingestão independente (C) + ação default = ignorar em silêncio (A) +
um lock de ownership para garantia formal de respondedor único.**
**Rejeitamos (B)** como mecanismo primário: encadear LM → fila → Scheduler
acopla os dois sistemas e viola o isolamento do ADR-001.

Concretamente:
1. **Entrega:** o provider (Z-API/Evolution) entrega a cada sistema por seu
   próprio endpoint. Se o provider não suportar múltiplos webhooks, um
   **fan-out fino** (dispatcher stateless) replica o evento para ambos. O LM
   **não** repassa para o Scheduler.
2. **Default:** se o LM não "reivindica" a conversa (não-lead, ou conhecido,
   ou aguardando aprovação humana), ele **não emite nada** — silêncio total.
   O Scheduler segue intocado.
3. **Garantia de respondedor único:** ao reivindicar um lead qualificado, o LM
   grava um registro idempotente de **ownership** da conversa
   (`conversation_owner`: `lead_manager` | `scheduler`). Regra de precedência:
   conversa de **desconhecido qualificado** pertence ao LM; demais ao Scheduler.
   Isso é a rede de segurança caso a disjunção de domínios falhe numa borda.

### Riscos residuais
- **Resposta dupla numa zona cinzenta** (ex.: ex-aluno que volta como "lead"):
  mitigado pelo lock de ownership + histórico (Decisão 4-B).
- **Acoplamento via provider config** (dois webhooks ou fan-out): operacional,
  documentado no runbook de deploy.
- O Scheduler **não** conhece o conceito de ownership hoje → na borda crítica,
  a precedência é aplicada do lado do LM (ele se cala); fechar o ciclo no
  Scheduler fica como evolução (ver **ADR-005**).

---

## 5. Decisão 4 — Falso positivo (risco crítico)

**Pergunta:** se o Gemini classificar erroneamente um gestor/aluno como lead e
responder automaticamente, há constrangimento real. Qual a mitigação?

### Opções
- **(A)** Período de observação: LM monitora sem responder; recepcionista
  aprova antes da primeira resposta automática.
- **(B)** Confiança por histórico: só responde se o número **nunca** teve
  conversa anterior no sistema.
- **(C)** Opt-in explícito: só responde se o lead veio de **canal rastreável**
  (landing page, anuncio); WhatsApp orgânico sempre passa pela recepcionista.

### Trade-offs
- **(B) sozinha é insuficiente:** um fornecedor ou gestor escrevendo de um
  número novo **não tem histórico** e seria liberado — exatamente o caso que
  queremos evitar. É um bom sinal **de apoio**, não a defesa principal.
- **(C) é o sinal de maior confiança:** proveniência rastreável (deep link
  `wa.me` com parâmetro de campanha, clique de anúncio, origem em landing) é
  evidência forte de intenção de lead. Mas não cobre o lead orgânico legítimo.
- **(A) é a rede de segurança definitiva:** humano no loop elimina o risco na
  largada, ao custo de latência de resposta e carga na recepção.

Estas três são **camadas de confiança**, não alternativas.

### ✅ Decisão
**Estratégia em camadas, com rollout faseado:**

- **Camada 0 (sempre):** Portão 0 (known_contacts) já remove gestor/aluno/
  fornecedor conhecido **antes** de qualquer chance de resposta. É a defesa
  primária — um gestor cadastrado nunca chega ao classificador.
- **Camada 1 — proveniência (C):** desconhecido + **fonte rastreável** + alta
  confiança do classificador → **resposta automática** liberada (caminho
  "feliz" de menor fricção).
- **Camada 2 — orgânico/ambíguo → humano (A):** desconhecido **sem
  proveniência** (WhatsApp orgânico) classificado como lead → o LM **gera uma
  resposta sugerida** e a coloca em **fila de aprovação da recepcionista**;
  só envia após aprovação. Nunca responde sozinho nesse caminho.
- **Camada 3 — histórico (B) como gate de apoio:** número com conversa anterior
  relevante reforça a rota humana, nunca a automática.

**Rollout faseado (de-risk):** no **go-live, TODO lead entra em modo
observação (A)** — o LM apenas sugere, a recepção aprova 100%. Medimos
**precisão** por algumas semanas; só então **graduamos** o segmento de maior
confiança (fonte rastreável) para resposta automática (C). Isso transforma o
risco crítico num parâmetro operacional ajustável, não numa aposta no dia 1.

### Riscos residuais
- **Link rastreável compartilhado com um gestor** que clica e escreve →
  mitigado porque o Portão 0 (número conhecido) tem precedência sobre a
  proveniência: conhecido nunca vira lead, mesmo com link.
- **Carga na recepção** no modo observação → temporário; some conforme os
  segmentos confiáveis são graduados.
- **Atribuição de proveniência depende de instrumentação** (deep links/UTM no
  wa.me) que precisa existir nas campanhas — dependência de Marketing.

---

## 6. Decisão 5 — Canais futuros (Facebook, Instagram, Google)

**Pergunta:** a arquitetura precisa ser agnóstica de canal desde já, ou
WhatsApp-only no MVP com abstração depois?

### Opções
- **(A)** Agnóstico de canal desde já (infra multi-canal completa).
- **(B)** WhatsApp-only, sem nenhuma abstração (acoplado ao provider).

### Trade-offs
- **(A)** evita reescrita futura, mas constrói conectores e identidade
  cross-canal que **ninguém usa no MVP** — over-engineering clássico (YAGNI),
  custo e atraso sem retorno imediato.
- **(B)** entrega rápido, mas crava premissas de WhatsApp no domínio e cobra
  caro depois (reescrita do core de ingestão/resposta).

### ✅ Decisão
**Meio-termo pragmático: WhatsApp-only no MVP, com abstração fina nas
costuras.** Implementamos **um** canal, mas o domínio **não** assume WhatsApp:

- **Já temos a semente:** `conversations.channel` (default `'whatsapp'`) em
  E6-02 e o `normalizeMessage()` que abstrai payloads Z-API/Evolution. Elevamos
  isso a um contrato `ChannelAdapter` com `parseInbound()` e `sendOutbound()`.
- **Identidade** do contato = `(tenant_id, channel, external_id)` — já modelado
  assim; um futuro conceito de `contact` unificado (mesma pessoa em WhatsApp e
  Instagram) fica **explicitamente adiado**.
- **Nada** de conectores FB/IG/Google agora; apenas garantimos que adicioná-los
  seja "implementar um adapter", não "reescrever o core".

Custo da abstração é baixo **porque já existe**; o benefício é evitar dívida
arquitetural quando os canais chegarem.

### Riscos residuais
- Abstração prematura mal desenhada pode atrapalhar → mantemos mínima (2
  métodos), validada por um único provider real, sem generalizar além do que
  vemos hoje.
- Identidade cross-canal (deduplicação de pessoa) **não** resolvida — risco
  conhecido e adiado para quando o 2º canal existir.

---

## 7. Consequências

**Positivas**
- Custo de IA proporcional ao tráfego **relevante** (cascata B→A), não ao
  volume total.
- Risco crítico de falso positivo atacado em **profundidade** (4 camadas +
  rollout humano-no-loop), não numa única salvaguarda.
- Isolamento do Scheduler preservado (ADR-001): zero acoplamento por fila;
  domínios disjuntos + lock de ownership.
- Caminho de evolução multi-canal aberto a baixo custo.

**Negativas / custos assumidos**
- Nova tabela `known_contacts` + **job de sync** com a extranet (manutenção).
- **Fila de aprovação** e UI mínima de recepção (esforço de E-story dedicada).
- Dependência de **instrumentação de proveniência** (deep links/UTM) no
  Marketing para habilitar o caminho automático.
- Necessidade de **fan-out de webhook** ou config de múltiplos webhooks no
  provider.

**Itens que viram backlog / próximos ADRs**
- **ADR-005**: contrato de **ownership de conversa** entre LM e Scheduler (fechar
  o ciclo do lado do Scheduler).
- **ADR-006**: **identidade unificada de contato** cross-canal.
- E-story: tabela + sync de `known_contacts`.
- E-story: fila de aprovação + console da recepcionista.
- E-story: classificador leve (Gemini Flash) + métricas de precisão/recall.

---

## 8. Resumo das decisões

| # | Tema | Decisão | Rejeitado |
|---|------|---------|-----------|
| 1 | Classificação | **Cascata B→A**: lookup determinístico → classificador leve (Flash) → fluxo completo | C puro (IA em tudo) |
| 2 | Contatos conhecidos | **A+C**: tabela `known_contacts` (sync + manual + admin) | B (confiar só no modelo) |
| 3 | Convivência c/ Scheduler | **Ingestão independente (C) + ignorar em silêncio (A) + lock de ownership** | B (fila acoplando) |
| 4 | Falso positivo | **Camadas (0:known → C:proveniência → A:humano → B:histórico) + rollout faseado em observação** | qualquer salvaguarda única |
| 5 | Canais futuros | **WhatsApp-only com abstração fina (`ChannelAdapter`)** | multi-canal completo agora; acoplamento total |
