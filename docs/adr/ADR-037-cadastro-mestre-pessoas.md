# ADR-037 — Cadastro-mestre de pessoas (multi-tenant)
**Status:** Proposta · schema concreto consolidado (contrato=conta, read-only fechado) · pronto pra migration do 037.1 | **Data:** 2026-07-07
**Número:** ADR-037 (provisório — confirmar a próxima casa livre no índice do repo)
**Relação:** ADR-036 (política de lead por papel) passa a **consumir** este cadastro. Migram pra cá do 036: **E1.9** (unidade de contato), **E1.10** (provedor plugável), **E1.3a/b** (população). O 036 mantém só a lógica de decisão (papel→política, perguntas de resgate, supressão/criação).
**Não reescreve fontes:** `professor_notificacao`, `internal_contacts`, exports da Extranet e conversas do WhatsApp continuam existindo — viram **provedores**. Nada é arrancado.

---

## Gatilho

A população de papéis do E1.3 cresceu além da supressão: **comunicação com clientes** (reagendamento, renovação — módulo tipo Scheduler, mas pra alunos/clientes) e o **CRM** vindouro vão beber da mesma fonte. Decisão de Leo (2026-07-07): o cadastro nasce como **fonte estruturada para todas as features**, não enviesado pra descarte de lead.

## Tese

Um único **cadastro-mestre de pessoas** por tenant — pessoa + contatos + papéis + contas — **neutro** quanto à origem e ao consumidor. Provedores o alimentam; features o consomem; nenhum consumidor sabe de onde o dado veio. Multi-tenant com RLS; papéis e vocabulário **por vertical** (config-as-data).

## Modelo (padrão pessoa-e-papéis)

| Entidade | O que é | Notas |
|---|---|---|
| **Pessoa** | a entidade humana, por tenant | âncora de tudo |
| **Contato** | telefone/email de uma pessoa | 1 pessoa → N contatos; cada um com `source` e **confiança** (alegado/provado) |
| **Papel** | professor, aluno, responsável, equipe… | 1 pessoa → N papéis (aluno numa conta e responsável na do irmão); **definidos por vertical**; a política de lead (036) pendura no papel |
| **Conta** | a unidade de serviço/contrato | pessoas ligadas via `account_member` com `bond` (titular/responsável); expansão/indicação atribuem **à conta** |

### Estrutura real da fonte (read-only do contrato, 2026-07-07)

Confirmado abrindo um contrato real (`id_contrato=1096`):

- **Contrato = grão (aluno × curso × período).** Um contrato aponta **um** `id_aluno`, **um** `id_curso`, uma turma, um professor, vigência (`ini/fim`), plano e status. Aluno com N instrumentos ⇒ **N contratos**.
- **Não existe entidade "matrícula" com FK.** O próprio contrato **é** a inscrição persistida; `mod_matriculas_beta` é só o wizard (evento). ⇒ o cadastro **não** precisa de tabela `matricula` — some um nível.
- **Pagador ≠ beneficiário, e o pagador está um nível acima.** O contrato só aponta `id_aluno`; o pagador/responsável vem do vínculo `id_responsavel`+`tpresp` na **ficha do aluno**, não do contrato.
- **`status_renovacao`** (Prometeu Renovar / Em Negociação / Stand By…) já existe no contrato — **âncora pronta do futuro módulo de renovação/comunicação**.
- Refs úteis que vieram de brinde: `curso`→id_curso (casa com o de-para de disciplinas do adapter) e `turma`→id_turma.

⇒ A **conta = contrato**; aluno/pagador/professor entram como `account_member` (bond); ids da Extranet em `external_ref`. Ver Schema.

## As duas formas de popular (decisão-chave)

Não há fonte única entre tenants. Há **dois arquétipos de provedor**, ambos alimentando o mesmo cadastro neutro:

```
  TENANT "mirror" (Academia do Rock)        TENANT "native" (outros negócios)
  fonte de verdade = EXTERNA                fonte de verdade = o PRÓPRIO Regente
  Extranet (scraping hoje → API amanhã)     entrada de dados na UI/API do Regente
        │ ingere (read-only)                       │ CRUD nativo
        ▼                                          ▼
        └────────►  CADASTRO-MESTRE (neutro)  ◄─────────┘
                          │
              consumidores: supressão · comunicação · CRM
```

| # | Decisão |
|---|---|
| D1 | **Modo mirror (ADR):** o cadastro é **reflexão read-only** de uma fonte externa (Extranet). Regente **não é autoridade** e **nunca escreve de volta** na fonte. Hoje via scraping (throttle ≥25s, advisory lock, **adapter intocado**); amanhã via **API da Extranet** — mesmo modo, só troca o transporte. |
| D2 | **Modo native (outros negócios):** **não há Extranet**; o Regente **é** a fonte de verdade e precisa de uma **superfície de entrada de dados própria** (UI/API-in) onde o negócio cadastra suas pessoas/contas. CRUD completo, Regente autoritativo. **Previsto agora, construído depois** — o schema já nasce suportando os dois. |
| D3 | **O modo é config do tenant** (`registry_mode`: `mirror_extranet` \| `api_extranet` \| `native`). Os **consumidores leem o mesmo cadastro**, agnósticos ao modo — é o motivo de existir do contrato neutro. |
| D4 | **Autoridade e edição por registro, não por cadastro.** Cada registro carrega `source` + autoridade. Mirror = read-only no Regente (a fonte manda). Native = editável no Regente. **Enriquecimento é sempre aditivo** e vale nos dois modos (D5) — não é edição da fonte. |

## Alegado vs provado (contato)

| # | Decisão |
|---|---|
| D5 | Cada Contato tem **origem + confiança**. Número da Extranet = **alegado** (alguém digitou). Número visto numa conversa no WhatsApp = **provado** (conectou; a mensagem chegou). Ligados por `matchKeys`. O provado é **enriquecimento aditivo** — entra ao lado do alegado com `source='whatsapp'`, **nunca sobrescreve** o cadastro (nem no modo mirror). Batem → confiança máxima; alegado sem provado → cadastro suspeito; **provado sem alegado → a pessoa usa outro número** (o caso perigoso, agora visível). |
| D6 | **Cobertura vira subproduto.** A taxa de alegados que batem com provados **é** a medida que trava o descarte silencioso (036/E1.11). Deixa de ser tarefa futura. |

## Provedor plugável (migrado do 036/E1.10)

| # | Decisão |
|---|---|
| D7 | Cada fonte fica atrás de uma **interface de provedor** por tenant (não `SELECT` cravado). `source` ∈ `extranet` \| `api_extranet` \| `whatsapp` \| `native` \| `conversa`. Trocar de fonte = trocar o provedor, sem tocar consumidor nem schema. |

## Fatiamento

| Fatia | O que faz | Observação |
|---|---|---|
| **037.1** (antigo E1.3a) | Popular Pessoa/Contato/**Papel** por telefone das fontes existentes (professor, aluno-titular, responsável, equipe), modo mirror, Valinhos, via `matchKeys`. | **Barato**; **arma os relógios de shadow** do 036. A supressão só precisa de papel-por-telefone. **Próximo prompt.** |
| **037.2** (antigo E1.3b) | **Conta + membership** via varredura por-aluno (`tpresp`/`id_responsavel`/`familiares[]`, ~371 fetches, ~2–3h). | Caro; só a **criação** (036) e comunicação/CRM precisam do vínculo. Depois. |
| **037.3** | Cruzamento WhatsApp → contatos **provados** + medida de cobertura. | Destrava o descarte silencioso do 036. |
| **037.later** | Superfície de **entrada nativa** (UI/API) pra tenants não-ADR; provedor **API-Extranet**. | Dívida prevista; não construída agora. |

## Schema concreto (037.1) — greenfield

Cinco tabelas novas + um `ALTER` aditivo. Toda tabela: `tenant_id` + RLS `ENABLE` + policy padrão (`tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid`) + **`FORCE`** se posse do `lead_manager_user`.

```sql
-- 1) PESSOA — âncora. Dedup por telefone (matchKeys, tenant-scoped).
person(id, tenant_id, display_name, created_at, updated_at)

-- 2) CONTATO — telefone/email; alegado (Extranet) vs provado (WhatsApp), LINHAS SEPARADAS.
contact_point(id, tenant_id, person_id→person,
              kind 'phone'|'email', value_raw, source, confidence 'alegado'|'provado', proven_at, created_at)
--   guarda CRU; match por matchKeys no lookup. cobertura = match tenant-scoped alegado×provado.

-- 3) CONTA = CONTRATO (grão aluno×curso×período).
service_account(id, tenant_id,
                status,             -- ativo|inativo|cancelado (espelho)
                servico_label,      -- "Baixo","Bateria" (linha de serviço legível, espelho)
                plano_label,        -- "Mensal 1h/sem"... (espelho)
                periodicidade,      -- mensal|trimestral|semestral|anual|outro (de-para do adapter)
                ini_vigencia, fim_vigencia,
                status_renovacao,   -- âncora do módulo de renovação
                created_at, updated_at)

-- 4) ACCOUNT_MEMBER — pessoas ↔ conta com vínculo.
account_member(id, tenant_id, account_id→service_account, person_id→person,
               bond 'beneficiario'|'pagador'|'professor',
               UNIQUE(tenant_id, account_id, person_id, bond))

-- 5) EXTERNAL_REF — ids externos, genérico (anti-leakage).
external_ref(id, tenant_id, entity_kind 'person'|'account', entity_id,
             source, external_type 'contrato'|'aluno'|'professor'|'curso'|'turma', external_id,
             UNIQUE(tenant_id, source, external_type, external_id))

-- 6) CONTACT_ROLE_MEMBER (já existe; o gate lê) — aditivo:
ALTER TABLE contact_role_member ADD COLUMN person_id uuid REFERENCES person(id) ON DELETE SET NULL;
-- + criar papéis 'aluno' e 'responsavel' (eixo 'known') em contact_role.
```

**Ligações:** pessoa é o centro; telefone (via `contact_point`, matchKeys tenant-scoped) dedup a pessoa. Aluno=`account_member(beneficiario)`, responsável=`account_member(pagador)`, professor=`account_member(professor)` → "alunos do professor X" é query, sem coluna de Extranet no core. IDs da Extranet em `external_ref` tipado.

**População (custo):** pessoa/contato/contrato/vigência/plano/curso = **lote** (exports); vínculo **pagador** (aluno→responsável via `tpresp`) = **varredura por-aluno** (caro); contato **provado** = conversas do WhatsApp (interno). Constrói o schema já (037.1); popula depois num passo único (D14).

## Isolamento de tenant (invariante testado — não "usamos RLS")

Como o cadastro é compartilhado entre features e cresce pra multi-tenant, isolamento não é uma frase — é um invariante com condições verificáveis e um teste que prova.

| # | Condição |
|---|---|
| D8 | **RLS em toda tabela do cadastro** (pessoa, contato, papel, conta, `account_member`, `contact_role_member`): `ENABLE` + policy por `tenant_id`, no **padrão confirmado no read-only** — `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid`, `cmd ALL`, `qual`=`with_check`. **`FORCE ROW LEVEL SECURITY`** nas tabelas de **posse do `lead_manager_user`** (senão o próprio papel-dono lê sem filtro — lição de `audit_log`, que é da app e está sem RLS). Tabela nova sem policy = buraco silencioso — proibido. |
| D8.1 | **`internal_contacts` está HOJE sem RLS** (read-only: 6 linhas visíveis sem contexto nenhum). É mais um motivo pro cadastro **ingerir dela** pra uma tabela nova protegida, e **não lê-la direto**. A tabela velha segue servindo o gate antigo até o cutover; o cadastro novo já nasce fechado. |
| D9 | **Papel do banco em produção NÃO é superuser nem `BYPASSRLS`.** Os diagnósticos read-only rodaram como `postgres` (rolsuper), que ignora RLS de propósito — produção não pode. **A verificar antes do 037.1.** |
| D10 | **Todo acesso pelo contexto de tenant** (`withTenant`); nenhum `pool.query` cru sem escopo. |
| D11 | **Vetor novo do cadastro — casamento por telefone é tenant-scoped.** A mesma pessoa cliente de dois tenants (duas escolas) tem **duas pessoas separadas, nunca ligadas**. `matchKeys`/lookup de contato **sempre** filtra por `tenant_id`. O enriquecimento "provado" do WhatsApp idem: conversa do tenant A só prova contato do tenant A. |
| D12 | **Teste de isolamento no CI:** uma query cross-tenant sobre o cadastro retorna **ZERO**. Verificação automática, não manual. |

## Referências externas (ids de matrícula / contrato / aluno)

| # | Decisão |
|---|---|
| D13 | **IDs externos ficam numa tabela genérica, não em colunas da Extranet no core.** Outras aplicações precisam dos ids da Extranet (id_aluno, matrícula, contrato…). Guardar como `external_ref(tenant_id, entity_kind, entity_id, source, external_type, external_id)` — não como `id_aluno_extranet` cravado nas entidades. O core fica **neutro** (só sabe "esta conta/pessoa tem refs de tal `source`"); o significado de cada `external_type` vive no provedor. A outra app consulta por `external_type`; quando vier a API-Extranet ou outro tenant, é só outro `source` — modelo não muda. É o de-para de sempre. |
| D13.1 | **Capturar os três** (`aluno`, `matricula`, `contrato`) **+ `professor`**, todos como `external_ref` tipado — Leo confirmou que existem na Extranet e que a outra app chaveia pelos três. Falta entender a **estrutura** (como aluno/matrícula/contrato se relacionam, cardinalidade, onde cada ID vive — export vs ficha): **read-only de entendimento**, não de existência. |
| D14 | **037 constrói o schema greenfield COMPLETO primeiro** (pessoa/contato/conta/`account_member`/`external_ref`/`contact_role_member`); a **população vem depois, num único passo completo** — decisão de Leo: popular **uma vez, certo, com tudo** (papéis + contatos + os 3 IDs + vínculo pela varredura por-aluno), evitando estado parcial e re-scraping. Essa população única é o que **arma os relógios de shadow**. (Cancela o antigo "barato agora / caro depois".) |
| D15 | **Um só cadastro pra TODAS as pessoas — inclusive não-alunos** (professor, equipe). `external_ref` é **esparso e tipado**: professor carrega ref `professor` (tem id no `professor_notificacao`), não carrega matrícula/contrato/aluno; aluno carrega aluno/matrícula/contrato. Papel e refs são atributos **independentes** pendurados na Pessoa; a ausência de um tipo é normal, não buraco. **Nada de lista separada por tipo** — recriaria a fragmentação, quebraria o multi-papel (professor que também é responsável = 1 pessoa, 2 papéis), forçaria comunicação/CRM a consultar dois lugares e furaria a dedup por telefone. |

## Invariantes

- **Adapter intocado; mirror nunca escreve na fonte.** Regente reflete, não corrige a Extranet.
- **Enriquecimento aditivo** (provado ao lado de alegado), nunca sobrescrita.
- **Cutover por paridade:** o gate do 036 só troca de `internal_contacts`/`professor_notificacao` pro cadastro quando este provar que cobre tudo que a fonte antiga cobria (e mais). Até lá, lê a antiga.
- **Multi-tenant/vertical:** Pessoa/Contato/Conta universais no core; papéis e vocabulário por vertical (config). Novo negócio mapeia no mesmo esqueleto.
- **PII mínima:** o provedor lê só o necessário (telefone, vínculo); **nunca** persiste senha/CPF/endereço vistos nos exports da Extranet.
- **Ritos:** shadow, migrações aditivas, flag por tenant, backup antes de migrar.

## Não-objetivos / dívida registrada

- **Auditoria de RLS pré-multi-tenant (GATE do 2º tenant)** — ver doc `DEBT-RLS-multitenant-hardening`. O read-only achou **9 tabelas com `tenant_id` sem RLS** (buracos latentes). Não é escopo do 037 consertar, mas é **pré-requisito de onboarding do 2º tenant** — que vem em breve. Alta prioridade, trilha própria.
- UI/API de **entrada nativa**: prevista (D2), não construída agora.
- Provedor **API-Extranet**: quando a API existir (troca o transporte de D1, não o modelo).
- Tabela real de **template de vertical**: só quando chegar o 2º tenant da mesma vertical.

## Relação com ADR-036

036 vira **consumidor**. Migram pra cá: E1.9, E1.10, E1.3a/b. 036 mantém: papel→política, perguntas de resgate por papel, supressão/criação, e a medição autoarmada (E1.11 lê o `gate_shadow_log`, que é do 036/029, **alimentado pelos papéis deste cadastro**).

## Emenda 2026-07-21 — cadastro como fonte única extensível; dois telefones, titular por dependência financeira, periodicidade e pagante derivados

Fecha o modelo canônico e alinha a ingestão (`/cadastro/contratos`) à spec. Confirmado read-only antes de editar.

**(a) FONTE ÚNICA EXTENSÍVEL (N consumidores, schema neutro).** O cadastro é a fonte canônica de pessoas/contatos/papéis/contas, **projetada para N consumidores**, cada um lendo só o que precisa — **nenhum molda o schema ao seu jeito**. Hoje são **4** consumidores concretos:
- **LM (supressão/Gate 0)** — lê `contact_role` + `contact_role_member` (papel→política) para reconhecer lead vs conhecido.
- **Rock-Hour** — lê "tudo" (person, contact_point, account_member, service_account, external_ref) para a visão de pessoas/alunos.
- **WhatsApp-Scheduler (comunicação)** — lê **só alunos** (contrato ativo) para reagendamento/renovação; hoje via a mesma query do Rock-Hour, módulo próprio futuro.
- **ADR-BI** — lê métricas (contrato/pagante/status/vigência) — ver (e).
Invariante: **um novo consumidor entra sem mudar o cadastro** (D15: um só cadastro para TODAS as pessoas; `external_ref` esparso e tipado). O core permanece neutro; o significado por consumidor é query, não coluna.

**(b) DOIS TELEFONES COM PAPEL (cadastro vs WhatsApp).** `contact_point` distingue, **sem coluna nova**, pelo par **`source` + `confidence`**:
- **Telefone de CADASTRO** = `source='extranet'` (digitado na Extranet — registro formal, obrigatório na experimental), `confidence='alegado'`.
- **Telefone de WhatsApp** = `source∈{whatsapp,conversa}`, `confidence='provado'` — vem do lead/da conversa, salvo pela recepção; é o **número EFETIVO de contato**.
- Podem ser **números diferentes**, em **linhas separadas** da mesma pessoa (D5: provado é **aditivo** ao alegado, **nunca sobrescreve**). O **envio de mensagem usa o de WhatsApp** (hoje o LM manda para `lead.phone` = número da conversa). A ingestão de contrato grava **só o de cadastro** (`extranet/alegado`) e **não toca** um contact_point de WhatsApp preexistente (dedup por `(pessoa, dígitos, source)`, não só por dígitos). O "papel do telefone" (aluno vs responsável) é **da PESSOA dona** (via `contact_role_member`/`account_member`), não um campo do telefone.

**(c) TITULAR ≠ BENEFICIÁRIO por DEPENDÊNCIA FINANCEIRA (não por idade).** Um contrato tem, em `account_member`: **BENEFICIÁRIO** (`bond='beneficiario'` = quem estuda/consome) e **TITULAR** (`bond='pagador'` = quem tem a **responsabilidade financeira**, "contrato no nome de"). Podem ser a mesma pessoa ou diferentes — e a divergência **não é "menor"**: é **dependente financeiro** (menoridade OU arranjo financeiro, ex.: adulto com contrato no nome de outro). Casa com o **`tpresp`** da Extranet: `0`=próprio (titular=beneficiário=aluno), `1`=outro aluno, `2`=responsável (titular=responsável). `service_account` **não aponta pra ninguém** (sem `person_id`) — a titularidade é sempre via `account_member`. Um **titular pode ter vários contratos** (`UNIQUE (tenant, account, person, bond)` permite `pagador` de N contas — ex.: 2 filhos = 2 contratos, cada um beneficiário=criança + pagador=pai). Vocabulário fixado: **titular-do-contrato = `pagador`**; **quem estuda = `beneficiario`** (o "titular do serviço" da redação E1.9 do 036 = o beneficiário aqui).

**(d) PERIODICIDADE: descritivo → piso.** O período do contrato vem primeiro do **texto descritivo do plano** (`plano_label`, ex.: "Mensal Duplo" → mensal; "Flex Trimestral" → trimestral). Se vazio/ambíguo, deriva pela **vigência por PISO** — o maior nominal que **cabe** no intervalo: `≥12 meses → anual`, `≥6 → semestral`, `≥3 → trimestral`, `≥1 → mensal`. Se descritivo e piso **divergem**, usa o **descritivo** e **marca a divergência** (para revisão). `periodicidade` continua no domínio `{mensal,trimestral,semestral,anual,outro}`.

**(e) PAGANTE = CONTA, não campo.** Não há coluna "pagante". "**Contrato pagante neste mês**" é **derivado na leitura** do ADR-BI a partir de `ini_vigencia` + `periodicidade` (todo contrato **paga a partir do dia 1 da vigência**). Mantém o cadastro neutro (b/a): a regra de negócio de cobrança vive no consumidor, não no schema. `status_renovacao` já é a âncora do módulo de renovação.

**(f) GAPS DE INGESTÃO — DÍVIDA a pagar PÓS-BACKFILL (não nesta fatia).** A spec acima descreve o **alvo**; o **comportamento do endpoint só segue quando o DADO chegar** — ambos os gaps dependem da **ficha do aluno** (`tpresp`/`id_responsavel`), que **o backfill traz**. Enquanto o backfill não roda, corrigir o endpoint seria adivinhar sem base. Portanto:
- **Telefone com rótulo (dívida):** o alvo é `_upsertPhone` **deduplicar por fonte** (o telefone de cadastro coexiste com o de WhatsApp, sem sobrescrever — D5) e **marcar o `tipo`** de cada telefone. Depende do backfill trazer os números da ficha e do provedor de WhatsApp popular o `provado`. **Esta fatia só prepara o TERRENO:** migração aditiva com a coluna **`tipo`** em `contact_point` (valores `cadastro`/`whatsapp`/`outro`, nullable) — o endpoint **ainda NÃO a preenche**.
- **Titular por dependência financeira (dívida):** o alvo é o endpoint decidir o titular pelo **`tpresp`** (com responsável → `pagador`=responsável; sem → `pagador`=aluno), **não por idade**. Só é implementável quando o lote trouxer `tpresp`/`id_responsavel` (invariante do provedor/crawl: sempre trazer o responsável quando `id_responsavel≠0`). Fica para a fatia pós-backfill.

**Nota de unicidade:** `contact_point` **não tem UNIQUE** (só a PK e um índice **não-único** por dígitos) — o DB **já permite** 2+ telefones/pessoa com `tipo` distinto; a idempotência de hoje é só no app (`_upsertPhone`). Logo a coluna `tipo` entra **sem** mexer em unicidade. Um índice de idempotência por `(tenant, person, dígitos, tipo)` é hardening **opcional/futuro** (arriscado sobre dado existente com possíveis duplicados) — não entra nesta fatia.

**Escopo desta fatia:** (i) esta emenda (spec: a–e + a dívida de f) e (ii) **uma migração aditiva** — `067` adiciona a coluna `tipo` em `contact_point` (nullable, backfill dos existentes = `cadastro`, pois todos vêm da Extranet/alegado). **Nenhuma mudança de comportamento do endpoint** — os fixes de ingestão (f) são dívida pós-backfill. Vocabulário e derivações (d/e) são spec para os consumidores. Reversível: `git revert` do código; a migração é aditiva/não-destrutiva (DROP COLUMN no rollback). `source`/`confidence`/`bond` já existiam (051/060); só o `tipo` é novo.

## Emenda 2026-07-22 — Política de proveniência (humano vs scraping; proteção e divergência por campo)

Estabelece o eixo **quem editou por último** — ortogonal ao eixo **de onde veio** (D5: `source`/`confidence`). D5 responde *"o número veio da Extranet ou de uma conversa?"*; esta emenda responde *"um humano travou este campo?"*. Motivada pelo cadastro virar **fonte viva sincronizada** (cron de scraping diário, molde ADR-026): sem proteção, o próximo scraping sobrescreveria a correção manual da recepção.

**(a) TODO CAMPO EDITÁVEL TEM PROVENIÊNCIA POR CAMPO.** A granularidade é **o campo**, não o registro: numa mesma pessoa, `display_name` pode estar travado por humano enquanto `data_nascimento` segue livre pro scraping. Vale para **qualquer campo editável de qualquer tenant** — é mecanismo genérico (tabela + `field` como chave-texto), não regra de um campo.

**(b) HUMANO TRAVA; SCRAPING NÃO SOBRESCREVE TRAVADO.** Quando um humano edita um campo pela tela, o campo fica **PROTEGIDO**. O scraping (cron futuro) **consulta a proveniência antes de escrever** e **pula** todo campo travado por humano — nunca sobrescreve. (Espelha D5 "nunca sobrescreve", agora para o eixo humano.)

**(c) DIVERGÊNCIA VIRA ALERTA, NÃO SOBRESCRITA.** Se o scraping traz, para um campo travado, **valor diferente** do valor humano, ele **não escreve** e **registra um ALERTA DE DIVERGÊNCIA** (o campo protegido continua com o valor humano). O alerta guarda os dois valores (humano vs fonte) para a recepção decidir.

**(d) DISPENSÁVEL, MAS REINCIDENTE.** A recepção pode **DISPENSAR** o alerta (silencia **aquela ocorrência**). Se um **novo scraping** traz o **mesmo** valor divergente, segue dispensado; se traz **valor divergente diferente**, o alerta **RESSURGE** (a dispensa vale para o valor que foi dispensado, não para a divergência eterna). Enquanto a fonte divergir, o alerta é **reincidente**.

**(e) A FONTE CORRIGE → O ALERTA SOME SOZINHO.** Quando o scraping passa a trazer valor **igual** ao humano (a Extranet foi corrigida), a divergência deixa de existir e o alerta é **encerrado automaticamente** no próprio run — sem ação da recepção. Sem lixo acumulado.

**(f) DESTRAVAR É EXPLÍCITO.** Só um humano remove a trava (ex.: botão "voltar a seguir a fonte" na tela) — o scraping **nunca** destrava sozinho. Destravado, o campo volta a aceitar a fonte no próximo run.

**(g) FRONTEIRA — SÓ CAMPO EDITÁVEL.** Contrato (`service_account`/`account_member`) é **espelho puro** (060) — sem edição humana, sem proveniência; o sync de contratos ignora esta camada. A proveniência mora no sync de **pessoas/contatos** (`person`, `contact_point`), que é justamente o que a ingestão de contrato **já não toca** (contract-only).

**(h) MECANISMO MÍNIMO (duas tabelas laterais esparsas, `field` como chave-texto).** Migração `070`, aditiva:
- **`field_provenance`** (a trava) — PK `(tenant_id, entity_kind, entity_id, field)`; guarda `human_value`, `actor`, `locked_at`. **Linha existe ⇔ campo travado por humano.** Esparsa (só o tocado).
- **`field_divergence`** (o alerta) — PK `(tenant_id, entity_kind, entity_id, field)`; guarda `human_value`, `source_value`, `source`, `first_seen`, `last_seen`, `dismissed_value` (o valor cuja dispensa vale). **Linha existe ⇔ há divergência viva**; **ATIVO** = `dismissed_value IS DISTINCT FROM source_value`.
- `entity_kind` reusa o vocabulário do `external_ref` (`person`, `contact_point`, …); `field` é o nome da coluna. RLS `FORCE` idêntico ao 060; **zero coluna** nas tabelas de cadastro.

**Três funções** (genéricas, tenant do `current_setting`): `marcar_edicao_humana(...)` grava a trava e resolve divergência pendente; `aplicar_scraping(...) → {ESCREVE|IGUAL|DIVERGE}` decide e gere o alerta (**não escreve a base — o chamador escreve quando `ESCREVE`**, como o `sync.js`); `dispensar_alerta(...)` silencia o valor atual. Ressurgir/sumir são automáticos no `aplicar_scraping` (valor novo → ativo; convergiu → deleta).

**Como o scraping consulta:** 1 `SELECT` da trava no início da entidade (molde `sync.js` que carrega o estado num Map) + `aplicar_scraping` por campo; escreve a base só quando `ESCREVE`. Custo zero nos campos livres (o caso comum).

**Não-objetivo:** histórico/auditoria completo de edições (N versões, quem/quando) — isso é `audit_log` (012), trilha própria. Esta emenda guarda só o **estado atual** da trava e da divergência (o mínimo para proteger + alertar). **Fundação sem tela nem cron:** a tela de alertas e o cron que chama `aplicar_scraping` vêm depois. Reversível: `git revert` do código; migração aditiva (`DROP TABLE`/`DROP FUNCTION` no rollback).
