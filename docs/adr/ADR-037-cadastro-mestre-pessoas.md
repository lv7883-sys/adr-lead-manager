# ADR-037 — Cadastro-mestre de pessoas (multi-tenant)
**Status:** Proposta · fundação de dados compartilhada; 1ª fatia (037.1) = o antigo E1.3a | **Data:** 2026-07-07
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
