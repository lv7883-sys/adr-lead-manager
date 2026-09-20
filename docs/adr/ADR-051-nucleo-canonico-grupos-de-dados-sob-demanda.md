# ADR-051 — Núcleo canônico com grupos de dados sob demanda (e migração de Valinhos sem perda)

- **Status:** Proposto — aguardando aprovação do Leo
- **Data:** 16/09/2026
- **Escopo:** plataforma inteira (adr-lead-manager + adr-whatsapp-scheduler/dashboard, banco `adr_scheduler`)
- **Relacionados:** ADR-001/002/004 (LM: tenant, subscription, trial), ADR-036/037 (LM: política de lead, cadastro mestre), ADR-038 (SCH: papéis e módulos), ADR-050 (boas-vindas do aluno, em worktree), especificação **ESP-API-EXT-001 v0.4** (Regente na rede Academia do Rock), capítulo financeiro `ARQ-FINANCEIRO-CANONICO-rascunho.md` (sessão Compasso/BI, a incorporar)
- **Numeração reservada por este ADR:** migrations do LM **127–139**; ADR-050 pertence à sessão de boas-vindas (migrations 120–126 dela)

---

## 1. Contexto

### 1.1 O que mudou no negócio
As aplicações do Regente passam a ser **vendidas individualmente por unidade**, com contratação online e comissão para a franqueadora (ESP-API-EXT-001). Ao mesmo tempo, os dados **precisam continuar canônicos**: um só aluno, contrato, aula e lead, compartilhados por todas as aplicações. Valinhos, que hoje usa tudo, tem de migrar para o novo modelo **sem perder absolutamente nada**.

### 1.2 O que o código tem hoje (levantamento de 16/09/2026)
- **Seis mecanismos de habilitação que não conversam:**
  - E1 `app.tenant_modules` (dashboard, chave `franquia_id`; `requireModulo` só protege QUALIDADE, ROCK_HOUR e COMPASSO, e libera se a lista não carregar);
  - E2 `lead_manager.tenant_subscriptions` (CHECK só aceita `SCHEDULER` e `LEAD_MANAGER`; só o motor de entrada consulta);
  - E3 `lead_manager.tenants.lead_manager_active` (chave-mestra de todos os jobs do LM via `tenants_active()`);
  - E4 flags de modo em `tenant_lead_config`;
  - E5 `automacao_config` (ex.: `renovacao_habilitada`);
  - E6 `resources.resource_source_binding` (ligar a sincronização da Extranet).
- **Três chaves de unidade:**
  - `app.franquia.id` (int, Valinhos = 1);
  - `lead_manager.tenants.id` (uuid `ed731a58-…`), também usado por `resources`, `qualidade` e `rock_hour`;
  - BI cuid (`cmo7t25gz0000rkd8y1reic0c`), usado por `bi_raw` e `compasso`.

  Só `app.franquia` (`lead_tenant_id`, `bi_tenant_id`) liga as três. Como `app.current_tenant` guarda um valor por transação, telas que cruzam os lados fazem duas transações e juntam em JS.
- **Jobs sem portão de assinatura:**
  - a maioria dos jobs do LM checa só E3;
  - o ETL da Extranet para o BI, o ETL da Conta Azul e o tick do Compasso não checam nada;
  - os scripts de host do dashboard (`scrape-*`, `acumular-presenca`, `backfill-sa-enriquecimento`) são **single-tenant** (`QUALIDADE_FRANQUIA_ID || '1'` + `LEAD_MANAGER_TENANT_ID`);
  - só Rock Hour, diário, faltas, NPS e impressões checam E1.
- **Pontos que já apagam ou sobrescrevem dados hoje** (§7): anonimização mensal de leads, refresh total sem guarda de `qualidade.cancelamento_motivo`, refresh total de `qualidade.aluno_status`, exclusão física de capacidades e disponibilidades de recursos, UPDATE incondicional em `service_account`, exclusão de franquia em cascata pelo `/admin`.
- **Backup:** existe `pg_dump` diário descrito em `ANALISE.md` (`/root/backups/backup.sh`), mas não há script versionado, teste de restauração, cópia fora da VPS nem cobertura comprovada de `./uploads` (mídia do LM).
- **Crontab do host do dashboard não está versionado.** As agendas conhecidas vêm de anotações.

---

## 2. Decisão

### D1 — Vende-se a aplicação, não o dado
A assinatura controla **telas, regras e rotinas automáticas** de uma aplicação. **Nunca** controla onde o dado mora nem como ele se relaciona. Não haverá banco por aplicação nem RLS por módulo. O isolamento continua sendo **por unidade**.

### D2 — Estrutura sempre pronta, dados sob demanda por grupo
Todas as tabelas existem para todas as unidades. Os dados canônicos são organizados em **grupos de dados**. Cada aplicação declara num **manifesto** os grupos que **lê** e os que **escreve**, com janela de histórico e frequência. Um grupo só é coletado para uma unidade se ao menos uma aplicação ativa dela o declara. A unidade de ativação é o **grupo inteiro com histórico**, nunca o registro na hora da leitura.

### D2a — Canônico é TUDO, qualquer que seja a origem (decisão do Leo, 16/09/2026)
O núcleo canônico **não é "o que vem da Extranet"**. Todo dado da plataforma é canônico e pertence a **exatamente um grupo**, venha de onde vier:
- sistemas externos: Extranet, WhatsApp/Evolution, Instagram/Facebook (Meta), Conta Azul, bancos (OFX/API), ADN/SEFAZ, adquirentes, BACEN;
- digitação humana: recepção, gestor, professor, aluno por link;
- produção das próprias aplicações: diário, NPS, renovação, Rock Hour, títulos, lançamentos;
- inteligência artificial: classificações, sugestões, impressões, estado da conversa;
- arquivos: mídias, anexos, documentos, certificados, fotos.

**A origem é atributo do dado**, registrado na cobertura e na proveniência, **não critério para estar ou não no núcleo**. Consequências:
- dado produzido por uma aplicação (ex.: diário de bordo) é tão canônico quanto o que vem da Extranet: outras aplicações o leem pelas mesmas regras (ex.: a Folha lê o diário), e cancelar a aplicação que o produz **preserva** o grupo, nunca o apaga;
- toda regra deste ADR vale para todos os grupos, sem exceção: identidade da unidade, cobertura, dono de escrita, portão, preservação, piso legal, backup e contagem de referência;
- **nenhuma tabela e nenhum diretório de arquivos pode existir sem grupo** (D11).

### D3 — Grupos de dados iniciais

Catálogo inicial. A classificação **completa**, tabela por tabela e diretório por diretório, é entregável da Fase 2 (D11). As origens listadas não são exaustivas.

| Grupo | Depende de | Origens | Dono de escrita | Principais tabelas / arquivos hoje | Piso legal |
|---|---|---|---|---|---|
| `unidade` (identidade e configuração) | — | admin, gestor | plataforma | `plataforma.unidade*`, `app.franquia`, `app.franquia_config`, `lead_manager.tenants`, `tenant_lead_config`, `automacao_config` (incl. perfil da assistente), `compasso.config`, `qualidade.nps_config`, horários, mensagens padrão, atalhos, templates | — |
| `acessos` (usuários, papéis, aceites, auditoria) | unidade | admin, login, aceite online | plataforma | `app.usuario`, `app.sessao`, `lead_manager.users`, `tenant_members`, `TermsAcceptance`, `audit_log` | a confirmar (trilha de aceite) |
| `pessoas` | — | Extranet, WhatsApp, Meta, Conta Azul, ADN, digitação | núcleo (cadastro) | `lead_manager.person`, `contact_point`, `external_ref`, `field_provenance/divergence`, `contact_role(_member)`, `internal_contacts`, `compasso.fornecedor` (F2, a unificar), `qualidade.inbox_contato_nome` | — |
| `contratos` | pessoas | Extranet, digitação | núcleo (sync) | `service_account`, `account_member`, `bi_raw.contracts/students`, `qualidade.aluno_status`, `cancelamento_motivo`, `contract_match_pending` | — |
| `recursos` (professores, salas, cursos) | — | Extranet, digitação | núcleo (sync) | `resources.*`, `app.professor_notificacao`, `compasso.aula_valor` | — |
| `agenda` (aulas, presença, overrides) | contratos, recursos | Extranet, recepção | núcleo (sync) + recepção (override) | `app.agenda_snapshot`, `cache_identidade_aula`, `identidade_shadow_*`, `aula_override`, `aluno_professor_visto`, `qualidade.presenca_aula`, `aula_diaria`, `aulas_mensal`, `funil_experimental` | — |
| `leads` | pessoas | Extranet, WhatsApp, Meta Ads, digitação, IA | atendimento + núcleo (sync Extranet) | `leads`, `lead_eventos`, `lead_qualifications`, `extranet_lead`, `pending_approvals`, `reabordagem_tentativas`, `meta_ad_referral`, `stage_autoapply_log`, `classification_feedback` | — |
| `conversas` (WhatsApp, Instagram, Facebook) | pessoas | Evolution, Meta, recepção, IA | atendimento | `conversations`, `messages`, `message_favorites`, `staff_outbound_samples`, `wa_sync_state`, `wa_lid`, `wa_linha_arquivada`, `janis_estrategia_chat`, **mídias em `./uploads`**, **fotos em `/data/fotos`**, **banco do Evolution** (separado) | — |
| `comunicacoes` (avisos, campanhas, disparos) | pessoas, agenda | plataforma, recepção | aplicação emissora | `app.envio_pendente`, `envio_log`, `campanha`, `campanha_alvo`, `lead_mensagem_padrao`, `lead_arquivo_rapido`, `nps_agendamento_log`, `diario_lembrete_log`, `falta_alerta_log` | — |
| `relacionamento` (renovação, boas-vindas, reconquista, casos) | contratos, conversas | aplicações, IA, recepção | retenção / boas-vindas | `renovacao_touchpoint/dismiss/sugestao`, `qualidade.renovacao_desfecho`, `caso_acao`, `boas_vindas_*` (ADR-050) | — |
| `pedagogico` (diário, avaliações, NPS, pesquisas) | agenda, pessoas | professor, aluno por link, IA | retenção | `qualidade.evolution_log`, `avaliacao_mensal`, `objetivo/etapa`, `nps_*`, `pesquisa_saida`, `pesquisa_experimental`, `impressao`, `idr_snapshot`, `registro_versao` | — |
| `eventos` (Rock Hour) | pessoas, contratos | coordenação, aluno por link | rock_hour | `rock_hour.*` | — |
| `recebiveis_alunos` (Extranet) | contratos | Extranet | núcleo (sync) | `bi_raw.faturamento_previsto`; cobranças via API (futuro) | a confirmar |
| `financeiro_f1`…`f7` | ver capítulo financeiro | Conta Azul, bancos, ADN, adquirentes, digitação | ver capítulo financeiro | `compasso.*`, `bi_raw.transactions`, `conta_bancaria`, `extrato_importacao`, `category_mappings`, … **anexos em bytea** | F4: 5 anos; F1/F3 fiscais: 5 anos (a confirmar) |
| `financeiro_contas_pagar` | financeiro_f1, f2, f5 (f3 para conciliação) | gestor, Conta Azul (transição), IA | compasso | `compasso.titulo`, `recorrencia`, `baixa`, `tributo`, `documento` (anexos bytea), `alerta_envio` | a confirmar (suporte fiscal) |
| `folha_professores` | agenda, recursos, financeiro_contas_pagar | gestor, diário (leitura) | compasso (folha) | `compasso.aula_valor`, `folha_extra`, `folha_servico` | a confirmar (trabalhista) |
| `gestao` (DRE, metas, investimentos, lançamentos interpretados) | financeiro | BI, gestor, BACEN | indicadores | `bi_raw.description_mappings`, `regra_transferencia`, `sugestao_conciliacao`, `dre_linha`, `dre_tipo`, `dim_*`, `fact_*`, `investments*`, `metas`, `okrs`, `key_results` | a confirmar |
| `operacao` (trilha das sincronizações e dos portões) | unidade | rotinas da plataforma | plataforma | `bi_raw.etl_logs`, `lead_manager.cadastro_sync_log`, `resources.resource_sync_log`, `plataforma.portao_log`, `plataforma.contagem_referencia` | reter ≥ 13 meses: é a prova das lacunas de cobertura no passado |
| `legado_bi` (só preservação) | — | ADR-BI (Railway, migrado em 08/08/2026) | ninguém (somente leitura) | `bi_raw."Account"`, `"Session"`, `"User"`, `"VerificationToken"`, `"Tenant"`, `_prisma_migrations`, `contracts_backup_20260809` | preservar |

O que **não** é dado canônico: estado técnico efêmero e reconstruível (filas com TTL, caches do Redis com prefixo `lm:`, locks, `wa_ack_pendente`). Mesmo esses entram no catálogo com a marca `efemero`, para que a ausência deles seja uma decisão explícita e não um esquecimento.

### D4 — Mínimo de identidade sempre ligado
`pessoas` + `contratos` (ativos) são sincronizados para **qualquer** unidade com **qualquer** aplicação. Motivos: reconhecer quem escreve, respeitar descadastro (LGPD) e deduplicar.

### D5 — Registro de cobertura
Uma linha por unidade × grupo (e, onde fizer sentido, por fonte ou conta) com `desde`, `janela`, `estado` (`importando`, `completo`, `pausado`, `preservado`), `ultima_sync_ok`, `fonte` e `fidelidade` (`integral`, `reconstruido`). Telas, relatórios e jobs consultam a cobertura antes de concluir. **"Não coletado" nunca é exibido como zero.**

### D6 — Um único dono de escrita por dado
Cada grupo tem **um dono de escrita** declarado no catálogo (D3): a sincronização da fonte, uma função do núcleo (ex.: gravação de contato confirmado) ou a aplicação que produz o dado (ex.: Retenção escreve `pedagogico`). Quem não é dono **lê**, nunca grava direto; quando precisa registrar algo num grupo alheio, chama a função do dono. Leitura de uma aplicação no dado de outra é **enriquecimento**: se falta a aplicação produtora, a consumidora funciona com menos detalhe, e o grupo produzido continua preservado.

### D11 — Catálogo completo e verificado automaticamente
- Tabela `plataforma.catalogo_objeto(schema, objeto, tipo: tabela|diretorio|banco_externo, grupo, dono, efemero, observacao)` cobre **todas** as tabelas de todos os schemas (`app`, `lead_manager`, `resources`, `qualidade`, `rock_hour`, `bi_raw`, `compasso`, `plataforma`), os diretórios de arquivos (`./uploads`, `/data/fotos`, anexos) e o banco do Evolution.
- **Tabelas mistas:** o catálogo aceita `classificacao` = `unica` | `por_linha` | `por_coluna`, com a regra registrada. Casos conhecidos:
  - `bi_raw.transactions` é **por linha**, pela origem: `contaazul` → f7; `extrato:%` e `manual:%` → gestao; `regente` → gestao (espelho de contas a pagar); `Stone_Drive` → f6.
  - `compasso.config` é **por coluna**: `cnpj` → f1; `alerta_*`, `conta_padrao_id`, `categoria_juros/desconto` → financeiro_contas_pagar; `folha_*` → folha_professores.
  - `compasso.nota_recebida` é **por coluna, com dois donos de escrita**: o fato é F4 (chave, XML, emitente, valores, cancelamento); a decisão é financeiro_contas_pagar (situacao, titulo_id, motivo, decidido_*). Fica registrada como mista agora. Quando houver código, a decisão migra de forma aditiva para uma tabela do grupo de contas a pagar que referencia a nota.
  - Tabela mista é **dívida registrada**, não padrão: tabela nova não pode nascer mista.
- **Teste automatizado nos dois repositórios:** compara `information_schema` com o catálogo e **falha** se existir tabela sem grupo, ou tabela mista sem regra. Toda migration que cria tabela precisa, no mesmo PR, da linha de catálogo.
- A contagem de referência (Fase 0) e o backup usam o catálogo como lista mestra, de modo que nenhum dado fica fora da proteção por esquecimento.

### D7 — Portão de assinatura em todo job
Todo job automático (sincronização, aviso, régua, NPS, alerta) pergunta `pode_rodar(unidade, job)` antes de agir por unidade. Jobs single-tenant viram loops por unidade. Nenhum valor de franquia ou tenant fica fixo em código de produção.

### D8 — Uma identidade de unidade
Criar `plataforma.unidade` como identidade canônica e `plataforma.unidade_chave`, que liga as chaves existentes (`franquia`, `lead_tenant`, `bi_tenant`, `extranet_unidade`). **Nenhuma coluna existente é alterada.** Tabelas novas nascem com `unidade_id`.

**Contexto de RLS (corrigido na revisão de 16/09/2026).** Hoje os dois lados usam **a mesma variável** `app.current_tenant`: `withTenant` grava o uuid do LM, `withTenantBi` grava o cuid do BI. As policies do lado LM fazem `::uuid` sobre ela, então um cuid ali gera **erro de cast**, e não apenas zero linhas. Por isso não dá para "definir as duas" na mesma transação. Solução aditiva:
- nova variável `app.unidade`, com o uuid de `plataforma.unidade`;
- **uma segunda policy PERMISSIVA** por tabela com RLS. As policies atuais ficam intocadas, porque policies permissivas se combinam por OR:
  - lado LM/qualidade/rock_hour: `tenant_id = (SELECT valor::uuid FROM plataforma.unidade_chave WHERE unidade_id = NULLIF(current_setting('app.unidade', true), '')::uuid AND tipo = 'lead_tenant')`;
  - lado bi_raw/compasso: `"tenantId" = (SELECT valor FROM plataforma.unidade_chave WHERE unidade_id = … AND tipo = 'bi_tenant')`;
- o helper novo (`withUnidade`) define `app.unidade` e deixa `app.current_tenant` **vazio**. `NULLIF` vira NULL, então não há erro de cast. O subselect vira initplan, avaliado uma vez por query;
- `GRANT SELECT ON plataforma.unidade_chave` para os papéis com FORCE RLS (`lead_manager_user` e o papel RLS do dashboard);
- **armadilha do OR:** se `app.current_tenant` e `app.unidade` estiverem preenchidos com unidades diferentes, as linhas das duas ficam visíveis. O helper novo zera `app.current_tenant`, os helpers antigos não tocam `app.unidade`, e um teste automatizado garante as duas coisas.

### D9 — Fonte única de assinatura
Criar `plataforma.aplicacao` (catálogo) e `plataforma.assinatura` (unidade × aplicação × estado). Na transição, E1 e E2 continuam existindo e são **mantidos em sincronia a partir da assinatura** (compatibilidade). Nenhum código novo lê E1 ou E2 diretamente.

### D10 — Desativar não apaga
Um grupo sem aplicação ativa vai para `preservado`: para de sincronizar e fica oculto. A exclusão só acontece depois do prazo D11 da especificação (proposta: 90 dias) **e** do piso de retenção legal do grupo, em ordem de dependência, com backup verificado de menos de 24 h, relatório de simulação e aprovação humana registrada. O código de exclusão nasce **desligado**.

**Exceção: credenciais.** Chave privada de certificado digital, tokens OAuth (Conta Azul), credenciais da Extranet e, no futuro, de API bancária **não são preservadas**. Guardar segredo de quem cancelou é passivo, não proteção. Quando a unidade cancela a aplicação (ou tudo) que as usa, a credencial é **revogada e apagada na hora**, com trilha de auditoria; fica só o metadado. O dado obtido com ela (XML, movimentos) segue o piso legal. **A exportação no cancelamento inclui os XMLs de F4**, que a unidade tem obrigação de guardar.

---

## 3. Modelo (esboço de DDL — migrations aditivas LM 127+)

```sql
CREATE SCHEMA IF NOT EXISTS plataforma;

CREATE TABLE plataforma.unidade (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_publico text NOT NULL,            -- marca para clientes (editável; usada em mensagens e boletins). Decisão do Leo, 17/09/2026
                                         -- razão social NÃO fica aqui: é dado fiscal (grupo financeiro_f1), só leitura na tela "Dados da empresa"
  slug        text UNIQUE NOT NULL,
  criada_em   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plataforma.unidade_chave (
  unidade_id  uuid NOT NULL REFERENCES plataforma.unidade(id) ON DELETE RESTRICT,
  tipo        text NOT NULL CHECK (tipo IN ('franquia','lead_tenant','bi_tenant','extranet_unidade')),
  valor       text NOT NULL,
  PRIMARY KEY (tipo, valor),
  UNIQUE (unidade_id, tipo)
);

CREATE TABLE plataforma.aplicacao (
  codigo       text PRIMARY KEY,         -- atendimento, agenda, recursos, retencao, rock_hour, indicadores, compasso, cadastro, boas_vindas
  nome         text NOT NULL,
  modulo_legado text,                    -- chave em app.tenant_modules (E1)
  feature_legada text                    -- chave em tenant_subscriptions (E2)
);

CREATE TABLE plataforma.assinatura (
  unidade_id  uuid NOT NULL REFERENCES plataforma.unidade(id) ON DELETE RESTRICT,
  aplicacao   text NOT NULL REFERENCES plataforma.aplicacao(codigo),
  estado      text NOT NULL CHECK (estado IN ('teste','ativa','em_atraso','suspensa','cancelada')),
  desde       timestamptz NOT NULL DEFAULT now(),
  ate         timestamptz,
  origem      text NOT NULL CHECK (origem IN ('legado','loja','admin')),
  PRIMARY KEY (unidade_id, aplicacao)
);

CREATE TABLE plataforma.grupo_dado (
  codigo           text PRIMARY KEY,     -- pessoas, contratos, recursos, agenda, leads, recebiveis_alunos, financeiro_f1..f7
  depende_de       text[] NOT NULL DEFAULT '{}',
  retencao_legal   interval              -- NULL = sem piso legal
);

CREATE TABLE plataforma.cobertura (
  unidade_id     uuid NOT NULL REFERENCES plataforma.unidade(id) ON DELETE RESTRICT,
  grupo          text NOT NULL REFERENCES plataforma.grupo_dado(codigo),
  escopo         text NOT NULL DEFAULT '*',   -- conta bancária, fonte etc.
  estado         text NOT NULL CHECK (estado IN ('importando','completo','pausado','preservado')),
  desde          date,
  janela         interval,
  fonte          text,
  fidelidade     text NOT NULL DEFAULT 'integral' CHECK (fidelidade IN ('integral','reconstruido')),
  ultima_sync_ok timestamptz,
  preservado_em  timestamptz,
  PRIMARY KEY (unidade_id, grupo, escopo)
);

CREATE TABLE plataforma.portao_log (      -- modo sombra e auditoria dos portões
  em          timestamptz NOT NULL DEFAULT now(),
  job         text NOT NULL,
  unidade_id  uuid NOT NULL,
  decisao     text NOT NULL CHECK (decisao IN ('rodaria','pularia','rodou','pulou')),
  motivo      text
);

CREATE TABLE plataforma.contagem_referencia (   -- rede de segurança contra perda
  capturada_em timestamptz NOT NULL DEFAULT now(),
  unidade_id   uuid NOT NULL,
  tabela       text NOT NULL,
  linhas       bigint NOT NULL,
  min_data     timestamptz,
  max_data     timestamptz,
  PRIMARY KEY (capturada_em, unidade_id, tabela)
);
```

**Manifesto** (código, versionado com a aplicação; exemplo):

```js
// plataforma/manifestos/retencao.js
module.exports = {
  aplicacao: 'retencao',
  grupos: [
    { grupo: 'pessoas' },
    { grupo: 'contratos', historico: 'P36M' },
    { grupo: 'recursos' },
    { grupo: 'agenda', historico: 'P60D', frequencia: 'PT1H' },
    { grupo: 'recebiveis_alunos', historico: 'P24M', opcional: true },
  ],
  jobs: ['renovacao-sweep', 'renovacao-auto-envio', 'nps-cadencia', 'faltas-alerta',
         'diario-lembrete', 'impressoes-ia', 'scrape-status-alunos', 'scrape-cancelamentos',
         'scrape-aulas-diario', 'acumular-presenca', 'backfill-sa-enriquecimento'],
};
```

**Função de decisão** (única, usada por todos os jobs):

```js
// pode_rodar(unidadeId, job) → { rodar: boolean, motivo }
// 1. job pertence a alguma aplicação com assinatura em estado teste|ativa|em_atraso?
// 2. se o job é de sincronização de grupo: o grupo está no fecho de dependências de alguma aplicação ativa (ou no mínimo de identidade)?
// 3. em modo sombra: grava portao_log('rodaria'|'pularia') e retorna rodar=true sempre.
```

---

## 4. Regras invariantes
1. Migrations **só aditivas**. Nenhum `DROP`, `RENAME`, `ALTER … TYPE`, `DELETE` ou `TRUNCATE` em dado existente dentro deste ADR.
2. Nenhuma tabela existente é movida de schema. O nome `compasso.*` guardando dado de núcleo é aceito e resolvido por declaração no manifesto, não por realocação.
3. Todo comportamento novo entra em **modo sombra** antes de valer e tem **flag por job** com volta imediata.
4. Nenhum job novo apaga dado. Exclusão só pelo fluxo D10, desligado por padrão.
5. "Não coletado ≠ zero" em toda tela nova ou alterada.
6. Nenhum valor fixo de unidade ou tenant em código de produção.
7. **Todo dado é canônico, qualquer que seja a origem** (D2a). Nenhuma tabela, diretório de arquivos ou banco externo fica fora do catálogo (D11).

---

## 5. Portão por job (inventário de 16/09/2026)

| Job | Onde roda | Grupo / aplicação | Portão hoje | Portão alvo |
|---|---|---|---|---|
| `resources/daily-sync` | host LM 03:00 | recursos | E3+E6 | grupo `recursos` |
| `cadastro/daily-sync-cadastro` | host LM 04:00 | pessoas, contratos | E3+E6 | mínimo de identidade (sempre, se há assinatura) |
| `cadastro/daily-sync-leads` | host LM 08–20h/3h | leads | E3+E4+E6 | grupo `leads` |
| `runDetectarSilenciosos`, `runReprocessarPendentes`, `syncReconnections` | node-cron LM | atendimento | E3 | aplicação `atendimento` |
| `runRenovacaoSweep`, `runRenovacaoAutoEnvio` | node-cron LM | retencao | E3+E5 | aplicação `retencao` (+E5 como configuração) |
| `runDataRetention` | node-cron LM, dia 1 às 03:00 | atendimento (LGPD) | nenhum | ver §7 |
| `runTrialExpiry` | node-cron LM | plataforma | — | passa a operar sobre `plataforma.assinatura` |
| `executarFranquia` (agenda) | orquestrador dashboard | agenda | `ativo` | grupo `agenda` + aplicação `agenda` para os envios |
| `rockhour-auto`, `rockhour-feedback-auto` | orquestrador | rock_hour | E1 | aplicação `rock_hour` |
| `qualidade-diario-auto`, `faltas-alerta`, `nps-cadencia`, `impressoes-ia`, `diario-lembrete` | orquestrador / host | retencao | E1 | aplicação `retencao` |
| `bi-etl-extranet.sincronizarBI` (+ faturamento previsto) | orquestrador | contratos (espelho BI), recebiveis_alunos | nenhum | grupos correspondentes |
| `bi-etl-contaazul` (+ casamentos Compasso) | orquestrador | financeiro F7 / compasso | nenhum | grupo F7 + aplicações indicadores/compasso |
| `compasso-alertas.tick` (recorrências, ADN, alertas) | orquestrador | compasso + F4 | linha em `compasso.config` | ADN = grupo F4 (núcleo); resto = aplicação `compasso` |
| `bi-invest.atualizarRendimentos` | orquestrador | indicadores | nenhum | aplicação `indicadores` |
| `campanha.processarCampanhas` | dashboard 60 s | comunicação (NPS, boas-vindas) | nenhum | aplicação dona da campanha |
| `scrape-experimentais`, `scrape-aulas-diario`, `scrape-status-alunos`, `scrape-cancelamentos`, `acumular-presenca`, `backfill-sa-enriquecimento`, `scrape-faturamento-previsto`, `scrape-aulas-historico` | host dashboard (crontab não versionado) | agenda, contratos, retencao | nenhum, **single-tenant FR=1** | loop por unidade + grupo/aplicação |

---

## 6. Plano de migração de Valinhos

**Ideia central:** para Valinhos a nova arquitetura **não move nem transforma dado**. Ela acrescenta uma camada de controle (identidade, assinatura, manifesto, cobertura, portões) sobre as tabelas que já existem. Como Valinhos usa todas as aplicações, o resultado esperado de cada fase é **nenhuma mudança de comportamento**. O risco real de perda hoje está nos jobs que já apagam (§7), por isso a Fase 0 vem antes de tudo.

Cada fase só começa quando a anterior cumpriu o critério de pronto. Toda fase com migration começa com backup verificado.

### Fase 0 — Proteção (antes de qualquer mudança de arquitetura)
1. **Inventário real, só leitura, versionado no repo:** `crontab -l` do host, conteúdo de `/root/backups/backup.sh` e sua retenção, valores reais de Valinhos em `app.tenant_modules`, `tenant_subscriptions`, `tenant_lead_config`, `automacao_config` e `resource_source_binding`.
2. **Backup verificado:**
   - confirmar que o dump diário inclui `adr_scheduler` completo, os volumes do Evolution e `./uploads` do LM;
   - criar cópia fora da VPS;
   - **restaurar** num banco descartável (`adr_scheduler_restore_teste`) e comparar contagem de linhas de todas as tabelas com produção;
   - **segredos de ambiente fazem parte do backup, com guarda separada do dump** (nunca no mesmo arquivo): `APP_ENCRYPTION_KEY` (cifra a chave privada do e-CNPJ), `LM_ENCRYPTION_KEY` (credenciais da Extranet), `CONTAAZUL_CLIENT_ID/SECRET`, `GEMINI_API_KEY`, tokens do Evolution. Restaurar só o dump deixa o certificado ilegível e a busca de notas para;
   - no teste de restauração, validar que o certificado decifra (`certificado.paraUso()`) e que a credencial da Extranet decifra;
   - documentar o runbook de restauração.
3. **Contagem de referência diária:** script só de leitura grava `plataforma.contagem_referencia` (ou arquivo, antes da Fase 1) por unidade × tabela, com linhas e datas mínima/máxima. Alerta no WhatsApp do operador se alguma tabela de núcleo perder linhas de um dia para o outro sem explicação.
   - **Tabelas do financeiro incluídas:** `compasso.titulo`, `baixa`, `nota_recebida`, `documento`, `fornecedor`, `certificado` (ativo = 1) e `bi_raw.transactions` **por origem**.
   - **Classes que não disparam alarme** (a contagem cruza com a trilha de auditoria):
     - (a) exclusão manual por humano com confirmação: `bi-extrato` desfazer lote e excluir lançamento; Compasso excluir fornecedor, documento, tarifa, serviço, extra e regime;
     - (b) mudança automática de estado sem apagar e reversível: `sincronizarPagosContaAzul` (aberta → paga), `substituirGemeasContaAzul` (`substituido_por`);
     - cancelar título **não** apaga (status + espelho).
4. **Conter os pontos destrutivos existentes (§7)** antes de mexer em qualquer job.
5. **Congelar exclusões manuais arriscadas:** esconder o botão "excluir franquia" do `/admin` para franquias com dados; `dedup-person merge --apply` só com backup do dia.

**Pronto quando:** restauração testada e comparada; contagem diária rodando há 7 dias sem queda inexplicada; §7 contido.
**Volta:** não há mudança de dado nesta fase.

### Fase 1 — Identidade de unidade (migration 127)
1. Criar `plataforma.unidade` e `plataforma.unidade_chave`.
2. Popular a partir de `app.franquia`. Valinhos: franquia `1`, lead_tenant `ed731a58-…`, bi_tenant `cmo7t25gz0000rkd8y1reic0c`, extranet_unidade `13`. Fazer o mesmo para as demais franquias cadastradas.
3. Criar a função de resolução, o helper `withUnidade` e a **segunda policy permissiva** em todas as tabelas com RLS dos dois lados (D8). Testar com a Folha dos professores em paralelo: mesmo resultado nas duas implementações.

**Pronto quando:**
- toda franquia ativa tem as chaves;
- a função devolve as mesmas chaves que `app.franquia`;
- a comparação da Folha é idêntica;
- **o teste de isolamento entre unidades retorna 0 linhas vazadas nas duas policies**, com uma unidade fictícia em homologação;
- o teste da armadilha do OR passa (`withUnidade` zera `app.current_tenant`; os helpers antigos não enxergam `app.unidade`).

**Volta:** `DROP POLICY` só das policies novas (reversão do próprio passo, sem tocar dado); nenhuma tela usa `withUnidade` antes do critério.

### Fase 2 — Catálogo, assinaturas e manifestos (migrations 128–129)
1. Criar `aplicacao`, `assinatura` e `grupo_dado` (com dependências e piso legal).
2. **Assinaturas de Valinhos com `origem='legado'`**, lidas do que está efetivamente em uso: E1, E2, E3 e jobs rodando. **O Leo confirma a lista aplicação por aplicação antes de gravar.** Atenção: RECURSOS não está em E1, mas a sincronização roda; QUALIDADE não aparece em migration.
3. Manifestos em código para as 9 aplicações, com grupos lidos e escritos.
3a. **Catálogo completo (D11):** gerar a lista de todas as tabelas a partir do `information_schema` de produção (só leitura), mais diretórios de arquivos e o banco do Evolution. Classificar cada objeto em grupo e dono, com revisão do Leo nos casos duvidosos, e ligar o teste que falha com tabela sem grupo.
4. Reconciliação diária só de leitura: E1/E2 × `assinatura`. Qualquer divergência vira alerta, não correção automática.

**Pronto quando:** 7 dias sem divergência; o fecho de grupos de Valinhos contém **todos** os grupos que hoje sincronizam.
**Volta:** nada lê a assinatura para decidir ainda.

### Fase 3 — Cobertura (migration 130)
1. Criar `plataforma.cobertura`.
2. **Popular Valinhos pelo que já existe no banco**: `desde` = menor data real de cada grupo; `fidelidade` = `integral` ou `reconstruido`, conforme a origem. Levantamento do financeiro em 16/09/2026:
   - `financeiro_f7` (Conta Azul): desde 2024-02-02, 3.269 linhas, integral. **Janela real do ETL = mês atual + anterior**; o que está agendado além disso é "não coletado" (caso das 154 contas de out–dez que pareciam zero).
   - `financeiro_f4` (escopo `adn_nfse`): desde 2024-02-15, 520 notas, integral (cursor NSU 625).
   - `financeiro_f6`: Stone_Drive 2024-03-15..2026-03-15 (parado desde março) e Pagar.me 2025-03-06..2026-04-07 (parado desde abril). Os dois ficam `pausado`; **confirmar se é esperado**.
   - `financeiro_f3`: escopo Inter = fonte Conta Azul, sem movimento bruto; Stone = 0 (a única importação foi desfeita); caixa = manual. Nenhum escopo `completo` ainda.
   - `financeiro_f1`: certificado ativo desde 16/09/2026 14:38.
3. Cada job de sincronização passa a gravar `ultima_sync_ok` ao terminar com sucesso. É a única mudança de código: uma linha no fim, sem efeito sobre o dado.

**Pronto quando:** a cobertura de Valinhos está preenchida para todos os grupos e atualizada pelos jobs por 7 dias.
**Volta:** remover a chamada; a tabela fica sem uso.

### Fase 4 — Portões em modo sombra (migration 131)
1. Implementar `pode_rodar` e chamar em **todos** os jobs do §5, gravando `portao_log` com `rodaria`/`pularia`. **O job continua rodando sempre.**
2. Converter os scripts single-tenant em loop por unidade **atrás de flag**. Para Valinhos, comparar a saída antiga e a nova (linhas gravadas por execução) por pelo menos 7 execuções antes de trocar.
3. Remover valores fixos de unidade/tenant do código de produção (`engine.js` `franquia_id = 1`, `orchestrator.js` `!== 13`, `bi-financas.js` mapa de fallback, `campanha.js` env fallback, defaults `FR=1`), um por PR, cada um com teste.

**Pronto quando:** 14 dias de `portao_log` para Valinhos com **100% `rodaria`**; qualquer `pularia` foi explicado e corrigido no manifesto ou na assinatura.
**Volta:** flag por job.

### Fase 5 — Portões valendo, um job por vez
1. Ligar a flag de portão **um job por vez**, começando pelos de menor impacto (leitura/alerta) e terminando pelas sincronizações.
2. Após cada troca: 48 h de observação da contagem de referência e do `portao_log` (`rodou`).
3. `requireModulo` passa a consultar a assinatura e deixa de liberar quando a lista não carrega. Os módulos hoje só escondidos no menu passam a ser protegidos nas rotas.

**Pronto quando:** todos os jobs com portão ativo; Valinhos sem nenhuma mudança observável de comportamento nem de contagem.
**Volta:** flag do job.

### Fase 6 — Assinatura vira a fonte única
1. E1 (`app.tenant_modules`) e E2 (`tenant_subscriptions`) passam a ser **derivados** da `assinatura` por rotina de sincronização. As tabelas antigas continuam existindo e preenchidas para compatibilidade.
2. Telas passam a exibir cobertura: "dados coletados desde …".

**Pronto quando:** nenhum código lê E1/E2 para decidir; reconciliação sem divergência por 14 dias.

### Fase 7 — Ciclo de desativação (código pronto, desligado)
1. Implementar `preservado` → exclusão conforme D10: simulação primeiro, relatório de simulação, aprovação humana, backup de menos de 24 h, ordem de dependência, piso legal.
2. Testar apenas em homologação, com uma unidade fictícia.
3. **Não se aplica a Valinhos** enquanto houver aplicações ativas. A flag global de exclusão permanece desligada em produção até aprovação explícita do Leo.

### Fase 8 — Troca de fonte (independente, depende da API da Extranet)
Grupo por grupo, o adaptador de scraping é substituído pelo adaptador de API, rodando em paralelo e comparando por no mínimo 2 semanas (ESP-API-EXT-001 §24). As tabelas e a cobertura não mudam; muda o campo `fonte`.

---

## 7. Pontos que já apagam ou sobrescrevem dados — ação na Fase 0

| # | Onde | O que faz hoje | Risco | Ação proposta |
|---|---|---|---|---|
| R1 | `LM src/jobs/dataRetention.js` (node-cron, dia 1 às 03:00; **próxima execução 01/10/2026**) | Anonimiza irreversivelmente leads COLD/LOST/OPTED_OUT com última mensagem há mais de `retention_days` (padrão 730), em **todas** as unidades, sem portão | Perda irreversível de histórico de conversa (inclusive do histórico importado do WhatsApp) | **Decisão do Leo.** Proposta: até o ADR fechar, rodar em modo simulação (só relatório: quantos e quais leads seriam anonimizados). Confirmar se está implantado em produção. Depois, portão por unidade + relatório prévio |
| R2 | `DB lib/cancelamentos.js:92-95` | `DELETE FROM qualidade.cancelamento_motivo` + reinserção, **sem guarda** para resultado vazio ou queda | Scrape vazio ou falho apaga a tabela | Guarda de queda (mesma régua de 34%) e troca para upsert com `fonte_ausente_em` |

**R2 — posição da sessão do Diapasão (20/09/2026):** a guarda pode falhar fechada sem prejuízo.
`qualidade.cancelamento_motivo` tem 64 linhas e nenhuma com motivo preenchido no export; o motivo de
saída real passou a viver em `qualidade.saida` (recepção ou pesquisa respondida pelo aluno). Os
consumidores (tela Reconquista e a dica "Na Extranet: ..." da ficha de saída) toleram dado velho, e
manter o que existe é preferível a apagar por um export truncado. Decisão em aberto para o Leo:
aposentar o scraper e deixar `qualidade.saida` como fonte única do motivo.
| R3 | `DB lib/qualidade-db.js:791-804` (`aluno_status`) | Apaga tudo e reinsere; só protege contra resultado vazio; janela padrão a partir de 01/01/2026 | Saídas antigas somem a cada refresh; scrape parcial apaga linhas | Guarda de queda + upsert com `fonte_ausente_em`; verificar se a janela filtra saídas |
| R4 | `LM src/resources/sync.js:148-190` | Apaga fisicamente `resource_capability` e `resource_availability` ausentes; a guarda de 34% conta só recursos | Snapshot parcial apaga disponibilidade | Estender a guarda para capacidades e disponibilidades; marcar inativo em vez de apagar |
| R5 | `SCH scripts/backfill-sa-enriquecimento.js:263-285` (host 05:45) | UPDATE incondicional em `service_account` (grava NULL quando o Excel vem vazio); junta com `bi_raw.contracts` sem filtrar `"tenantId"` | Apaga professor e motivo de saída já preenchidos; cruza unidades quando houver mais de uma | `COALESCE` (nunca sobrescrever com NULL) + filtro de unidade |
| R6 | `DB routes/admin.js:540` → `db.excluirFranquia` | Exclusão em cascata de ~17 tabelas `app.*` + instância do Evolution | Um clique apaga a unidade | Bloquear para franquia com dados; exigir dupla confirmação e backup |
| R7 | `LM scripts/dedup-person.js merge --apply` | Apaga `person` e reaponta tabelas do LM, mas **não** `rock_hour.*` nem `app.campanha_alvo` | Referências órfãs | Incluir as referências soltas antes do próximo uso |
| R8 | `qualidade.aluno_professor` (`qualidade-db.js:765`) | Apaga tudo sem guarda; sem chamador encontrado | Baixo (aparentemente sem uso) | Confirmar que está morto |

Exclusões operacionais de baixo risco que ficam como estão: documentos órfãos do Compasso com mais de 24 h, certificado pendente com mais de 1 h, `wa_ack_pendente` com mais de 3 dias, sessões expiradas e rollback do motor quando a IA falha.

---

## 8. Garantias de não-perda
1. **Nada é movido, renomeado ou removido.** Toda migration deste ADR é aditiva.
2. **Nenhuma exclusão nova roda.** O fluxo D10 nasce desligado e não se aplica a Valinhos.
3. **Restauração testada**, não só backup existente, antes da Fase 1, e backup do dia antes de cada migration.
4. **Contagem de referência diária** com alerta de queda durante toda a migração.
5. **Modo sombra ≥ 14 dias** e **flag por job** para toda mudança de comportamento.
6. **Os riscos que já existem (§7) são contidos primeiro.** Hoje é aí que dá para perder dado, com ou sem a nova arquitetura.
7. **Critério de pronto e volta** explícitos em cada fase; a fase seguinte não começa sem o critério da anterior.

---

## 9. Coordenação
- **Migrations LM 127–139:** este ADR. **LM 120–126:** ADR-050 (boas-vindas). A 126 (`boas_vindas_alerta` + `automacao_config.boas_vindas_ativado_em`) entrou na E17-05; os grants de `app.*` do boas-vindas estão em `db/grants/boas_vindas_agenda_read.sql`. Publicação do boas-vindas: 16/09/2026 às 23h, com o módulo desligado por padrão.
- **Capítulo financeiro** (grupos F1–F8, cadastro único de partes, movimento bancário bruto): sessão Compasso/BI. Entra como anexo deste ADR após revisão. Nenhuma tabela de núcleo financeiro é criada antes da Fase 1.
- **ADR-050:** a aplicação `boas_vindas` usa `pode_rodar(unidade, 'boas_vindas')` (até lá, `gating.js` parametrizado, sem alterar a CHECK de `tenant_subscriptions`). Manifesto: `pessoas`; `contratos` com histórico P90D; `agenda` com histórico **P60D incluindo presença**. O teto da régua é D+60, portanto **a janela de agenda de nenhuma aplicação pode reduzir a cobertura de agenda abaixo de 60 dias** enquanto `boas_vindas` estiver ativa. Não usa `recursos` nem `recebiveis_alunos`; o horário de atendimento é configuração da unidade (`tenants.horario_comercial`), não grupo. As leituras de agenda passam pelo adaptador único (ADR-050 §13.3, regras 10–12).
- **Numeração de ADR:** sequência global entre os repositórios, porque os ADRs se citam entre si. Há colisões históricas (036, 037, 040, 041 existem nos dois repositórios com temas diferentes); citar sempre com o repositório.

## 10. Questões abertas (Leo)
0. **ADR-051 aprovado pelo Leo em 16/09/2026**, começando pela Fase 0.
1. ~~R1 — anonimização mensal~~ **Decidido:** checar primeiro, só leitura, e passar para simulação só se atingir alguém. **Checagem feita em 16/09/2026:** a rotina está agendada na imagem de produção, mas **nenhum lead tem status COLD/LOST/OPTED_OUT** (statuses existentes: NOT_LEAD, QUALIFIED, QUALIFYING, EXPERIMENTAL_AGENDADA, CONVERTED, REVIEW_QUEUE, NEW), e o lead mais antigo é de 13/06/2026. **Em 01/10/2026 ela atinge zero leads**, e não pode atingir ninguém antes de 06/2028. Nenhuma mudança é necessária agora. Entra no portão na Fase 4. **Defeito latente registrado:** a regra casa a conversa por `external_id = phone` e, se o formato do telefone divergir, usa `leads.updated_at`, o que pode anonimizar lead com conversa recente. Corrigir (casar por `br_phone_key`) antes de qualquer lead chegar perto do prazo.
2. ~~Lista de assinaturas "legado" de Valinhos (Fase 2.2)~~ **Respondida pelo Leo em 16/09/2026:** Valinhos usa **todas** as aplicações e vai continuar usando. Todas entram como `ativa`, e `boas_vindas` entra quando for lançada. As divergências nos controles antigos (RECURSOS fora de `app.tenant_modules`, QUALIDADE sem registro em migration) são corrigidas **só na camada nova**; nada muda no comportamento atual.
   **Restrição do Leo (16/09/2026):** nenhuma mudança pode atrapalhar o que funciona hoje. Regra operacional para a Fase 0: toda proteção só age no "dia ruim" (scrape vazio, queda anormal, valor em branco). No dia normal, o resultado tem de ser **idêntico** ao atual, e isso é comprovado comparando antes e depois.
3. ~~D11 da especificação~~ **Decidido:** 90 dias de preservação após cancelar uma aplicação.
4. ~~Pisos de retenção legal~~ **Decidido:** 5 anos como piso provisório para os grupos com suporte fiscal. A exclusão continua desligada.
5. ~~Cadastro único de partes~~ **Aprovado pelo Leo em 16/09/2026** ("siga as recomendações"): fornecedor entra no cadastro único de pessoas (natureza pf/pj), com as salvaguardas do capítulo financeiro. CPF de aluno nunca é importado, e o vínculo titular_mei sugerido nunca é confirmado sozinho. **Também aprovado:** a ordem do financeiro, com movimentos bancários (F3) logo após a Fase 1.
6. ~~Boas-vindas~~ **Decidido:** incluída no **Atendimento e Leads**; não é vendida à parte. `pode_rodar(unidade, 'boas_vindas')` resolve pela assinatura de `atendimento`.
6a. **Publicação do arquivo original dos extratos (migração 114 do Scheduler):** autorizada. Aplicar a migração antes do código, com rollback, comparação e fora do horário da unidade (§12).
7. ~~Recebíveis de adquirente parados~~ **Respondida pelo Leo em 16/09/2026:** Stone e Pagar.me estão **pausados, com retomada prevista para o fim de setembro de 2026**, junto com as importações de extrato bancário. Na cobertura: `financeiro_f6` = `pausado`, com observação "retomada prevista 09/2026".

## 10a. Levantamento de 16/09/2026 (Fase 0, passo 1, só leitura)
- **Backup:**
  - `pg_dump` completo de `adr_scheduler`, diário às 03:00 UTC (00:00 em Brasília), ~73 MB gz, retenção de 14 dias;
  - **só na própria VPS, sem cópia externa, e a restauração nunca foi testada**;
  - `evolution-instances` ~450 KB/dia; `evolution-store` gera arquivo de 4 KB (verificar se o volume está vazio ou se é o volume errado);
  - **fora do backup:** `/apps/lead-manager/uploads` (**1,1 GB de mídias**), `/root/adr-whatsapp-scheduler/.extranet-session` (montado como `/data` no dashboard, 15 MB, inclui fotos e um JSON de backup de credenciais da Extranet de 06/2026) e os segredos do `.env`.
- **Crontab do host (agora conhecido):** resources-sync 03h, cadastro-sync 04h, plantão 21h, acumular-presenca de hora em hora 8:30–22:30, nps-cadencia 10h, diario-lembrete a cada 2 min 8–22, impressoes-ia 11h, scrape-status-alunos 02h, extranet-leads-sync 8–20h a cada 3 h, faltas-alerta a cada 30 min 8–22, scrape-experimentais 05h, backfill-sa-enriquecimento 05:45, scrape-aulas-diario 06:15. **Não agendados:** scrape-cancelamentos (R2 só roda manualmente) e scrape-faturamento-previsto.
- **R1:** ver §10, item 1 (atinge zero leads). A mensagem mais antiga é de 11/09/2024 e nenhuma conversa tem a última mensagem antes de 01/10/2024, então o cenário de falso positivo do QA (C6) também não ocorre em 01/10/2026.
- **⚠ O crontab do host roda em UTC.** O host está em `Etc/UTC` e o cron **ignora `CRON_TZ`** (confirmado no syslog: cadastro-sync às 04:00 UTC, status-alunos às 02:00 UTC). Os horários reais em Brasília, que são o que funciona hoje, são:
  - backup e resources-sync **juntos às 00:00**;
  - scrape-status-alunos 23:00; cadastro-sync 01:00;
  - scrape-experimentais 02:00; backfill-sa-enriquecimento 02:45; scrape-aulas-diario 03:15;
  - extranet-leads-sync 05, 08, 11, 14 e 17h;
  - acumular-presenca de hora em hora das 05:30 às 19:30;
  - diario-lembrete a cada 2 min e faltas-alerta a cada 30 min, das 05h às 19h59;
  - nps-cadencia 07:00; impressoes-ia 08:00; plantão "noturno" 18:00.

  **Não se corrige agora:** mudar o horário muda o comportamento atual (ex.: lembretes do diário de aulas depois das 19h). Fica registrado para decisão do Leo, e **as janelas de manutenção são planejadas por esses horários reais**.
- **R5 confirmado parado:** o log mostra `service_account enriquecido: 0 contratos` todos os dias (provável efeito da migr. 074, conforme o anexo A F0-4). Corrigir **retoma** uma escrita em massa, o que é mudança de comportamento e depende de decisão do Leo.
- **Anexo A:** `ADR-051-anexo-A-riscos-verify.md`, com o risk register do VERIFY/FORGE, a comparação antes × depois, o plano de testes, o fatiamento em janelas e as lacunas do ADR.

## 10b. Decisões do Leo sobre o relatório do QA (16/09/2026, "seguir com o plano")
- **P1 · Backup externo:** nuvem de armazenamento de objetos (Backblaze B2), cifrado. **Chaves de criptografia** (.env e senha do repositório de backup) no gerenciador de senhas do Leo; o agente nunca vê nem manipula os valores.
- **P2 · Janela:** domingo 13h–19h (Brasília), com o Leo de plantão pelo WhatsApp. Hard stop às 19h com reversão.
- **P3 · Pausa:** as outras sessões não publicam nada durante a janela.
- **P4 · R5:** religar o enriquecimento dos contratos com proteção (COALESCE, nunca sobrescrever com vazio, filtro de unidade), comparado numa cópia e publicado em janela própria, **depois** da J0-B.
- **P5 · Credenciais no cancelamento:** apagar na hora. Exceção assinada à regra de reversibilidade.
- **P6 · Crons em UTC:** manter como estão; corrigir depois, rotina por rotina, com decisão do Leo em cada uma.

**Achado adicional (16/09/2026, só leitura):** o backup atual copia só o banco `adr_scheduler`. **Ficam fora os bancos `evolution` (144 MB, armazenamento do WhatsApp/Evolution) e `financial_app` (10 MB, app financeiro pessoal)**, além dos roles (`pg_dumpall --globals-only`). `adr_bi_stage` (13 MB, staging da migração do BI) também fica fora, e é aceitável. O volume `evolution-store` está vazio de fato (4 KB); `evolution-instances` tem 12 MB. Não há `restic`/`rclone` instalados (Ubuntu 24.04).

## 10c. Preparação da J0-A (16/09/2026)
- Roteiro: `deploy/fase0/RUNBOOK-J0A.md` (domingo 20/09, 13h–19h). Scripts: `deploy/fase0/backup-v2.sh`, `restore-test.sh`, `contagem-referencia.sh`, `contagem.sql`, `impressoes.sql`, `verifica-cifra.js` (sintaxe verificada).
- `contagem.sql` e `impressoes.sql` foram testados em produção, só leitura: 310 tabelas em `adr_scheduler`. O banco `evolution` tem **151.122 mensagens (`public.Message`)** e hoje **não está em backup nenhum**. Baseline das impressões em 16/09: 0 mensagens removidas, 0 leads/conversas anonimizados, 45 contratos sem professor, 798 contratos sem tipo de saída.
- O restic roda por imagem Docker (`restic/restic:0.17.3`), sem instalar pacote no host. Senha do repositório gerada no servidor, com guarda do Leo.

## 10d. Identidade da empresa e implantação guiada (17/09/2026)
- **Dois nomes (decisão do Leo):** `plataforma.unidade.nome_publico` é a marca para clientes, editável e usada em mensagens e boletins. A **razão social** é dado fiscal (grupo `financeiro_f1`, vinda da API da Extranet ou do checkout) e aparece só para leitura em "Dados da empresa". Os nomes atuais (`app.franquia.nome`, `app.franquia.nome_publico`, `lead_manager.tenants.name`, `tenant_lead_config.school_name`) viram espelhos, com **um único caminho de escrita**.
- **Valinhos:** nome público = **"Academia do Rock de Valinhos"** (Leo, 17/09/2026).
- **ADR-052 (implantação guiada):** consome este ADR. Lê "contratado" pela assinatura (até lá `tenant_modules`, via função adaptadora). Os passos de implantação são declarados nos manifestos, e o roteiro é a união deduplicada. O passo "Fonte dos dados" tem as variantes `api_rede` | `credencial_legada` | `nenhuma`. O ADR-051 entrega `provisionar_unidade()`; o ADR-052 orquestra "criar empresa" e usa as migrations LM **140–149**.

## 12. Regras de implementação (Leo, 16/09/2026)
1. **Tudo reversível.** Cada passo tem rollback escrito e **testado antes** de ir ao ar. Migrations são aditivas, e o rollback é desligar a flag, reverter o código ou remover só o objeto novo; nunca mexe em dado existente.
2. **Só vai ao ar depois de testado e comparado com o que roda hoje**, com prova de que não há perda. A comparação antes × depois é definida por tipo de mudança no plano do QA.
3. **Não atrapalhar o trabalho da unidade.** Mudança em produção só fora do horário da recepção (8–22h em dias úteis, sábado de manhã) e fora da janela de crons de madrugada (02h–06:30), ou com os crons pausados de forma controlada.
4. **Trabalho grande vai para janela de fim de semana**, executado sem supervisão contínua. Por isso o escopo de cada janela é fechado previamente, com checklist de pré-voo, critérios de GO/NO-GO e **pontos de parada automáticos**: qualquer verificação que falhe aborta e volta ao estado anterior.
5. **Levantamento de riscos do QA (VERIFY/FORGE)** antes da primeira janela. O risk register e o plano de testes viram anexo deste ADR.

## 11. Consequências
- **+** Vender aplicação por unidade sem duplicar nem fragmentar dado; aplicação nova entra declarando manifesto.
- **+** Um portão único e auditável para todos os jobs; fim do single-tenant `FR=1`.
- **+** LGPD mais defensável: só se sincroniza o que alguma aplicação contratada usa.
- **+** Os riscos de perda que já existem são tratados como parte do plano.
- **−** Mais uma camada (`plataforma.*`) a manter; a transição convive com os mecanismos antigos (E1–E6) até a Fase 6.
- **−** Todo job precisa ser tocado (portão + loop por unidade); trabalho mecânico, mas extenso.
- **−** Telas precisam aprender cobertura ("não coletado ≠ zero").
