# Demonstração do Lead Manager — MF8, 04/11/2026

O que este documento é: o roteiro de como a Caixa de Entrada e as Renovações da unidade de
demonstração ficam no ar, **o que não está feito**, e as duas decisões que não são minhas.

---

## Em linguagem simples, antes de qualquer sigla

O sistema do Leo é dividido em pedaços que moram em lugares diferentes. Um deles — o que mostra
as conversas de WhatsApp e os contratos vencendo — é um programa separado, o **Lead Manager**.
As telas são de um programa; os dados são de outro.

Para a clínica de demonstração aparecer nessas telas, três coisas têm de existir:

1. **Uma "conta" da clínica dentro do Lead Manager.** Ela não existia. Eu criei o jeito de
   criá-la (um comando), mas criar de verdade grava no banco de produção, e isso é decisão do Leo.
2. **Uma anotação, do lado das telas, dizendo qual é a conta da clínica no Lead Manager.** Esse
   campo é do outro programa, de outra sessão. Eu pedi; não mexi.
3. **Dados fictícios** — conversas, pacientes, contratos. Escritos à mão, um por um, neste
   repositório. Nenhum número foi sorteado e nenhum valor em dinheiro existe.

O que **não dá para desfazer**: nada do que eu escrevi até agora. Nenhuma linha foi gravada em
produção. A partir do momento em que o comando rodar, o que ele cria dá para apagar (há comando
para isso, e ele só apaga unidade marcada como de demonstração). O que **não** se desfaz com
comando é a coluna nova no banco (`is_demo`) — ela é aditiva, não muda dado nenhum, e sair dela
é uma linha de SQL. Nada disso toca a unidade de Valinhos.

---

## O bloqueio, medido

A unidade de demonstração **não tem** `lead_tenant_id`. Medido em produção em **02/11/2026** pela
sessão `Fase 0: diagnóstico demo MF8`:

```
id | slug            | bi_tenant_id                         | lead_tenant_id | id_unidade_extranet
 1 | valinhos        | cmo7t25gz0000rkd8y1reic0c            | ed731a58-…     |                  13
 7 | clinica-exemplo | fbecb933-522b-44ba-9a55-5caeff93180b | (VAZIO)        |                9001
```

**São três chaves de tenant neste sistema e elas não são intercambiáveis:**

| chave | de quem é | onde mora |
|---|---|---|
| `bi_tenant_id` | BI, Compasso, Regente Fiscal | `app.franquia` |
| `lead_tenant_id` | **Lead Manager** | `app.franquia` |
| `slug` | a URL (`/f/clinica-exemplo/…`) | `app.franquia` |

O modo de falha de chave errada neste projeto é **zero linhas, não erro**. Antes de concluir que
algo "não existe" no LM, confira com qual chave a consulta foi feita.

E a razão de o campo estar vazio **não foi esquecimento**: é decisão escrita, em
`dashboard/lib/demo-seed.js:84` do adr-whatsapp-scheduler — `lead_tenant_id: null, // sem Lead
Manager: as telas de Leads avisam e não chamam`, com `LEADS: false` e `QUALIDADE: false` em
`MODULOS_DA_DEMO`. A demonstração foi desenhada SEM o Lead Manager. O pedido do Leo de 02/11
reverte essa decisão, e a reversão é daquele repositório. *(verificado em código, 02/11/2026)*

---

## O que o Lead Manager serve, e o que o dashboard serve

| tela | HTML | dados |
|---|---|---|
| Caixa de Entrada (`/f/<slug>/inbox`) | dashboard, `routes/leads.js:909` | LM, `/tenant/:id/inbox/*` |
| Renovações (`/f/<slug>/qualidade/renovacoes`) | dashboard, `routes/renovacoes.js` | LM, por `withTenant` |

O dashboard autentica no LM com `SERVICE_TOKEN` e resolve o tenant por
`tenantIdDaFranquia(f)` → `f.lead_tenant_id`. Sem o campo: a tela de Renovações devolve
`ERRO_SEM_TENANT` em texto puro e o inbox mostra o banner "unidade sem tenant do Lead Manager".
*(verificado em código nos dois repositórios, 02/11/2026)*

---

## Como a contenção funciona aqui (e por que `lead_manager_active=false` é o equivalente de `ativo=false`)

Criar um tenant no LM o colocaria, por si só, em **todas** as rotinas de fundo. O que evita isso:

`lead_manager.tenants_active()` é literalmente `SELECT id FROM tenants WHERE lead_manager_active`
(migr 031), e **toda** rotina de fundo lê dela: `renovacao-sweep`, `renovacao-auto-envio`,
`boas-vindas-sweep`, `detectar-silenciosos`, `reprocessar-pendentes`, `waSync.syncReconnections`,
`plantao-noturno`, `dataRetention`. E `routes/webhook.js:179` recusa webhook de tenant inativo.

As rotas que as telas usam — `/tenant/:id/inbox/*` e as leituras da tela de Renovações — **não**
consultam essa coluna. Então: **as telas abrem e nada roda sozinho.**
*(verificado em código, 02/11/2026)*

Por cima disso, três gates a mais, nesta ordem de confiança:

1. `is_demo = true` (migr 187) — o **portão do seed**, e é SQL: cada INSERT resolve o tenant por
   `(SELECT id FROM tenants WHERE id = $1 AND is_demo)`. Em tenant real a subconsulta devolve
   NULL, a coluna é NOT NULL, e a transação cai. Errar grava **nada**.
2. `renovacao_auto_envio = false` e `boas_vindas_modo = 'desligado'` — os dois caminhos que
   mandam mensagem sem alguém clicar.
3. Nenhuma credencial (`evolution_token_enc` e `zapi_token` nulos). ⚠ Este é **gate de dado**:
   proteção que some no dia em que alguém preencher o campo "para a demo ficar mais completa", e
   sem erro nenhum. É o terceiro item, nunca o primeiro.

---

## As três camadas de conferência, e o que cada uma pega

| camada | onde | pega | NÃO pega |
|---|---|---|---|
| 1 — plano × restrições CHECK reais, sem banco | `src/demo/conformidade.js`, `test/demo-mf8-esquema.test.js` | valor fora do CHECK, coluna inexistente, coluna gerada escrita, NOT NULL faltando | esquema congelado desatualizado, tipo de verdade, FK |
| 2 — `PREPARE` de cada INSERT | `deploy/seed-demo-mf8.js` | nome de coluna, aridade, tipo, **contra a tabela real** | o que só o dado existente revela |
| 3 — uma transação só | idem | FK, índice único, gatilho | — |

**A lista de tabelas das três sai do próprio plano** (`tabelasDoPlano`). Não existe segunda lista
escrita à mão, e tabela que esteja no plano e fora do esquema congelado é **problema**, nunca
omissão silenciosa. Foi exatamente isso que matou a gravação do cenário do dashboard em
31/10/2026: a sexta de oito tabelas ficou sem conferência, com 22 testes verdes.

O mesmo furo apareceu **aqui**, um nível acima, e está consertado: a primeira versão deste script
gravava o cenário por plano e o provisionamento por quatro INSERTs escritos à mão — quatro tabelas
fora de qualquer conferência. Hoje o provisionamento também é plano
(`tenant-demo.planoProvisionamento`), e um teste conta as tabelas dos **dois**.

### Por que o esquema congelado vem de produção, e não das migrações

A 092 define `CHECK (marco IN ('D-10','D-2'))`; a 109 a substitui por seis valores. Quem conferir
pelo arquivo que criou a tabela acha que `'D-45'` é inválido.

E o inverso também vale: **replicar as migrações num banco vazio não dá o esquema de produção**,
porque a `RESERVAS.md` lista 131, 132–139, 140–169, 185 e 186 como não aplicadas. Só produção
produz o esquema de produção — por isso o dump diz de onde veio e quando.

---

## O cenário

12 conversas, 10 contratos, 3 toques de renovação, 118 linhas em 10 tabelas (+ 4 do
provisionamento). Declarado à mão em `src/demo/cenario-mf8.js`.

**Nada é sorteado.** A regra do projeto diz que o sorteio nunca toca em total de dinheiro
— valores fechados vêm de tabela declarada e o aleatório só distribui dentro dela, com semente
fixa. Aqui a regra está na versão forte: não há sorteio nenhum, e a única conta é deslocamento de
dias sobre uma data recebida. Semente fixa ainda exige confiar na semente, no gerador e na ordem
em que ele é consumido; tabela declarada é conferível por leitura.

**E não há dinheiro**, por duas razões que se somam: `lead_manager.service_account` não tem coluna
de valor (migr 060 cria a tabela; 072, 105 e 185 são os únicos ALTERs e nenhum adiciona valor), e
o texto dos rascunhos não pode afirmar valor — `src/temaProibido.js` barra "valores" na entrada e
na saída. Um preço no cenário seria, ao mesmo tempo, dado que o schema não guarda e frase que a
trava do produto recusaria. Um teste varre todo texto do plano procurando `R$`, "reais" e
`\d+[.,]\d{2}`.

### O que a demonstração mostra, em 10 minutos

Os números abaixo foram **medidos no banco depois da gravação**, em 02/11/2026 — não são o que o
plano pretendia, são o que está lá. (Dois deles eu havia escrito errado antes de medir: a aba
Leads tem 9 conversas e não 8, e a Outras tem 3 e não 4.)

1. Caixa de Entrada, aba **Todas**: **12** conversas, **3** com entrada não lida.
2. Aba **Leads**: **9** conversas, em 5 estágios — `NEW` 2, `QUALIFYING` 2, `QUALIFIED` 2,
   `CONVERTED` 2, `PERDIDO` 1.
3. Aba **Outras**: **3** — o fornecedor (marcado `NOT_LEAD`) e dois contatos que só têm contrato,
   sem nunca terem sido lead. O sistema **separa**, em vez de tratar todo número como oportunidade.
4. A assistente: **7** respostas já enviadas e **2 sugestões esperando aprovação** — é o modo
   `semi` (a IA escreve, a recepção decide).
5. Aba **Renovações** do inbox: **3** conversas elegíveis. A tela de Renovações enxerga **6**
   contratos na janela (de 38 dias vencido a 12 dias para vencer), porque três deles são de
   pessoas que têm contrato e nunca escreveram — é o caso real de quem foi atendido antes de a
   unidade usar o sistema.
6. O lembrete de um dos contratos vai para a **filha que paga** (Renata), não para o paciente
   (Sr. Otávio), porque a régua resolve o pagador antes do beneficiário. Conferido no banco: os
   **3** toques estão endereçados ao pagador do respectivo contrato.
7. A ponte conversa × cadastro casa **4** conversas (as que têm contrato) pela coluna `br_key`,
   que o banco calcula sozinho nas duas pontas.

Telefones no bloco `19 99000-00XX`, sequencial e visivelmente falso. ⚠ Isso **não** garante que o
número não pertença a alguém — no Brasil não há faixa reservada para ficção. O que garante que
nada sai é o tenant (sem credencial, fora dos laços). Nenhum texto menciona diagnóstico, exame,
medicamento ou prognóstico: dado de saúde fictício ainda ensinaria o público que o produto trata
dado de saúde — e não trata.

---

## Vocabulário: o que é de clínica e o que ainda é de escola de música

Pedido do Leo em 02/11: os exemplos pré-escritos nos campos têm de ser de clínica.

**Medido primeiro.** BASE: 128 arquivos `.js` em `src/`. PADRÃO `/placeholder/i`: **20 linhas, todas
rótulo de mídia** (`[áudio]`, `[imagem]`, `[documento: …]`). **Nenhuma é exemplo de campo** — o
Lead Manager não tem formulário nenhum: é API JSON, e as telas são do dashboard. Um teste trava
essa afirmação (`o Lead Manager não tem campo de formulário com exemplo pré-escrito`): placeholder
novo que não seja de mídia derruba a suíte.

**O que o LM pré-escreve e alcança a demonstração é um texto só: o prompt da assistente.** E ele
sai limpo — zero ocorrências de "escola de música", "instrumento", "aula experimental", "matrícul",
"aluno", "professor", "violão", "música" e "curso". O mecanismo:
`templates.renderDefaultPrompt` escolhe o `GENERIC_SYSTEM_PROMPT` quando
`perfilAssistente.generico()` é verdade, e ela é verdade porque o perfil da demo preenche
`ramo_atividade`. Sem ramo, o template padrão diria "uma escola de música".
*(verificado em código + teste, 02/11/2026)*

### O que continua de escola de música, e não consertei

**1. Quatro prompts de classificação, em `src/gemini.js`:**

| linha | prompt | o que diz |
|---|---|---|
| 67 | `TRIAGE_PROMPT` | "classificador de triagem … de **uma escola de música**" |
| 303 | `_INTERESSES_PROMPT` | "conversa entre **uma escola de música** e um contato" |
| 859 | `INTENT_PROMPT` | "intenção … do lead de **uma escola de música**" |
| 879 | `EXTRACT_PROMPT` | "dados do lead para **matrícula em escola de música**" |

Os quatro vão direto para `generateContent` (linhas 113, 328, 872, 896) **sem passar pelo
adaptador de ramo `_adaptar`** — que existe e é extenso (linha 406, ~35 trocas, inclusive
`['uma escola de música', descricaoEmpresa(p)]`). Então a voz da assistente adapta por ramo; a
triagem não. *(verificado em código, 02/11/2026)*

**Não rodam nesta demonstração** — o webhook é recusado por tenant inativo e os rascunhos são
pré-escritos. **E não os consertei**, por uma razão que não é preguiça: envolvê-los no `_adaptar`
mudaria o prompt do classificador **de Valinhos** se ela tiver `ramo_atividade` configurado, e eu
não sei se tem — isso é leitura de produção. A dois dias da apresentação, mexer num classificador
que roda de verdade, sem essa medição, é risco maior que o ganho. Fica como tarefa própria.

**2. Os rótulos do funil, em `src/stages.js`** — chegam à tela pelo `stageCatalog()` e o dashboard
desenha as colunas do Kanban de Leads:

| rótulo | dica | emoji |
|---|---|---|
| Experimental | "Aula experimental agendada" | 🎯 |
| Experimental realizada | — | 🎯 |
| Matriculado | — | 🎓 |

Não dependem de ramo. Mitigação já tomada no cenário: **não uso o estágio
`EXPERIMENTAL_AGENDADA`**, então essas colunas ficariam **visíveis e vazias** na clínica —
"Matriculado 🎓" teria 2 leads.

Rotular por ramo é **feature nova** em `stages.js`, que é a régua canônica lida pelos **dois**
repositórios (substituiu cinco cópias duplicadas) — mudá-la altera as telas de Valinhos. A
recomendação é não mostrar o Kanban de Leads nesta demonstração: o pedido era Caixa de Entrada e
Renovações, e essas duas não têm nenhum desses rótulos.

**3. Fora do caminho da demo, e registrado para não parecer ausência:**
`src/resources/adapters/valinhos.js` (28 literais: Guitarra, Violão…) só serve Valinhos;
`src/boasVindas/recepcao.js` ("Falta o professor", "Já era aluno") só aparece com o módulo de
boas-vindas ligado, e na demo ele está desligado.

Varredura completa: **202 literais de texto em 34 dos 128 arquivos** casam o padrão
`/instrumento|violão|guitarra|bateria|teclado|escola de música|matrícul|alunos?|professor|aula
experimental|turma|música/i`. A maioria esmagadora é nome de coluna, chave de enum
(`nao_matriculado_preco`, `matriculado`, `professor`) e SQL — não chega a tela nenhuma. *(medido em
02/11/2026)*

---

## Runbook

⚠ **A ORDEM IMPORTA, e por um motivo que o jargão esconde.** O `lead_tenant_id` do lado do
dashboard aponta para uma conta no LM. Se ele for gravado **antes** de a conta existir, as telas
param de mostrar o aviso "unidade sem tenant do Lead Manager" e passam a mostrar uma **lista
vazia** — porque o modo de falha de chave errada neste projeto é zero linhas, não erro. Numa
demonstração, tela que parece funcionando e está vazia é pior que aviso explícito. Então: **conta
no LM primeiro, ponte do dashboard depois.**

O uuid da conta é **derivado do slug** e pode ser calculado antes de qualquer gravação:

```bash
node -e "console.log(require('./src/demo/cenario-mf8').idDe('tenant','clinica-exemplo'))"
# 6c857c85-0803-5575-ac85-4862b36974d6
```

Dois cálculos dão o mesmo valor, e o provisionamento usa exatamente este — então a outra frente
pode preparar a ponte com o número em mão antes de o tenant existir, só não gravar antes.

```bash
# 0. aplicar a migração do portão (aditiva: 1 ADD COLUMN IF NOT EXISTS)
docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 \
  -f db/migrations/187_tenant_demo.sql

# 1. congelar o esquema real (READ-ONLY; grava test/fixtures/esquema-demo.json)
node deploy/dump-esquema-demo.js

# 2. a CAMADA 1 como teste, agora que o dump existe
node --test test/demo-mf8-esquema.test.js

# 3. provisionar o tenant (passa pelas 3 camadas; imprime o lead_tenant_id)
node deploy/seed-demo-mf8.js provisionar --slug=clinica-exemplo --ensaio   # confere sem gravar
node deploy/seed-demo-mf8.js provisionar --slug=clinica-exemplo

# 4. gravar o cenário, com a âncora de datas no dia da apresentação
node deploy/seed-demo-mf8.js cenario --tenant=<uuid> --hoje=2026-11-04 --ensaio
node deploy/seed-demo-mf8.js cenario --tenant=<uuid> --hoje=2026-11-04

# 5. (no OUTRO repositório) gravar o uuid em app.franquia.lead_tenant_id da unidade id=7
#    e ligar LEADS e QUALIDADE em MODULOS_DA_DEMO

# desfazer o cenário (só apaga tenant com is_demo=true)
node deploy/seed-demo-mf8.js apagar --tenant=<uuid>
```

`--ensaio` roda as três camadas e **desfaz a transação de propósito**: prova que a escrita
funciona sem deixar nada.

### A âncora de datas

Os contratos em D-10 e D-2 são relativos a `--hoje`. Rodar em 02/11 com a âncora em 02/11 põe os
vencimentos em 12/11 e 04/11 — e no dia 04 o contrato "D-2" estará **vencendo hoje**, não em 2
dias. Para a apresentação: rodar com `--hoje=2026-11-04`, ou rodar de novo no próprio dia (é
idempotente — os uuids são derivados das chaves declaradas, e o segundo passe atualiza).

---

## O estado em produção (02/11/2026, autorizado pelo Leo)

```
migração 187 .............. APLICADA (ALTER instantâneo, lock_timeout=5s, 0 locks na tabela)
tenant de demonstração .... CRIADO   6c857c85-0803-5575-ac85-4862b36974d6
   is_demo = true · lead_manager_active = false · sem token de Evolution · sem token de Z-API
cenário ................... GRAVADO  118 linhas, uma transação só
   person 11 · contact_point 11 · service_account 10 · account_member 20 · conversations 12
   leads 10 · messages 23 · staff_outbound 9 · pending_approvals 9 · renovacao_touchpoint 3
ADR Valinhos .............. is_demo = false, lead_manager_active = true (intacta)
tenants_active() .......... devolve SÓ "ADR Valinhos" — a clínica está fora de todo laço de fundo
```

⚠ Sobre "intacta": eu **não tomei contagem de referência das tabelas da Valinhos antes** de
gravar, então não posso dizer "220 antes e 220 depois". O que posso dizer, e é verificável: toda
linha gravada resolveu `tenant_id` pela subconsulta que exige `is_demo`, dentro de uma transação
só, com ids derivados do namespace da demonstração — uma linha da Valinhos só teria sido tocada
se o id dela colidisse com um uuid derivado desse namespace. As contagens da Valinhos hoje
(690 pessoas, 1.139 contratos, 61.944 mensagens, 81.388 saídas) são as dela.

## Conferência depois da ponte (02/11/2026, 13h40)

A outra sessão gravou `app.franquia.lead_tenant_id = 6c857c85-…` na unidade 7 e ligou os módulos
`LEADS` e `QUALIDADE` (medido). Então deu para conferir o caminho inteiro, até a borda da tela.

**O dashboard publicado resolve a clínica para o tenant certo.** Não é leitura de código: eu
chamei a função dele, `tenantDaFranquia`, dentro do container, com a linha real do banco.

```
tenantDaFranquia("clinica-exemplo")      -> tenant da DEMO
tenantDaFranquia("valinhos")             -> tenant da VALINHOS
tenantDaFranquia(sem lead_tenant_id)     -> null  (a tela AVISA; não cai na Valinhos)
```

Essa terceira linha importa: havia o risco de a unidade sem ponte cair no
`process.env.LEAD_MANAGER_TENANT_ID`, que **aponta para a Valinhos** neste container. A régua do
inbox não usa esse env — confirmado na linha 25 do arquivo publicado, e pelo retorno `null` acima.

**As rotas HTTP que as telas chamam** (chamadas com o próprio `SERVICE_TOKEN` do dashboard, do
jeito que o dashboard chama):

| rota | resposta |
|---|---|
| `GET /health` | `200 ok` |
| `GET /inbox/conversations?view=todas` | **12** conversas |
| `GET /inbox/conversations?view=leads` | **9** |
| `GET /inbox/conversations?view=nao_lead` | **3** |
| `GET /inbox/conversations?view=renovacoes` | **3** |
| `GET /inbox/nao-lidas` | `{"total":7,"conversas":3}` |
| `GET /inbox/conversations/<id>` (Rogério) | **5** itens, nos 3 lados: `lead`, `ia`, `recepcao`, na ordem |

**ISOLAMENTO — a conferência que mais importa:** os **12** telefones devolvidos pela API estão
todos no bloco fictício `5519990000XXX`, **nenhum fora**. Nenhum dado da Valinhos atravessa.

**Os nomes resolvem:** 0 de 12 conversas sem nome. E as etapas do funil que a lista devolve são
`novo`, `qualificando`, `qualificado`, `convertido`, `perdido` — **nenhuma `experimental`**, como
o cenário pretendia. O rótulo que a tela desenha para `convertido` é "Matriculado 🎓", e esse
continua sendo o único vocabulário de escola que aparece.

**A tarja de renovação funciona:** Beatriz vem com `{"venc":"2026-11-14","dias":12,"toque":"D-10"}`.

### Um achado no outro repositório, reportado e não consertado

`/app/lib/campanha.js:310` (código **publicado**) é o único caminho vivo que cai no env:

```js
(r.rows[0] && r.rows[0].lead_tenant_id) || process.env.LEAD_MANAGER_TENANT_ID || null
```

É o resolvedor de telefone da **fila de envio em massa**. Numa unidade sem `lead_tenant_id`, ele
resolveria o telefone **dentro do tenant da Valinhos**. Medido: BASE 125 arquivos `.js` em
`/app/lib` + rotas; PADRÃO `LEAD_MANAGER_TENANT_ID` → **3** ocorrências, das quais **2 são
comentários** (`tenant-franquia.js:11`, `routes/leads.js:355`) e **1 é código vivo** (esta).

**Risco hoje: nenhum, e medido.** `app.campanha` tem 179 linhas e `app.campanha_alvo` 1.071 (316
com `person_id`), **todas da franquia 1**. Zero para a clínica — nada na fila, nada a resolver. E
com a ponte gravada o env deixou de ser alcançável para ela.

⚠ Mas há um detalhe de cache que vale dizer: `_tenantPorFranquia` é um `Map` de módulo **sem
invalidação**. Se alguém criasse campanha para a clínica *antes* de a ponte existir, o tenant
errado ficaria em cache até o processo reiniciar. Isso é do adr-whatsapp-scheduler; reportei à
sessão dona e não toquei.

## O Kanban por ramo (decisão do Leo, 02/11/2026)

Pedido: *"o kanban precisa ser adaptado para uma clínica médica"*. Minha recomendação anterior era
não mostrar o Kanban; ele decidiu mostrar **adaptado**.

**Por que a tarefa é deste repositório.** `stageCatalog()` é servido em
`GET /tenant/:id/leads/kanban` no campo `catalog`, e o comentário da própria rota já dizia que o
dashboard deve **consumir** em vez de espelhar. `dashboard/views/stages.js` é espelho de
**contingência**, usado só quando esse payload falta. Conferido no meu código antes de aceitar.

**Dos seis rótulos, só dois são de escola** — lista inteira, para a conta ser refeita:
`Novo` · `Qualificando` · `Qualificado` · **`Experimental`** · **`Matriculado`** · `Perdido`.
Os motivos de perda (Preço, Horário, Concorrente, Desistiu, Não compareceu, Outro) são neutros, e
as chaves deles são enum no banco — não mudam.

| coluna | hoje | ramo de saúde |
|---|---|---|
| `experimental` | 🎯 Experimental — "Aula experimental agendada" | 🩺 **Avaliação** — "Consulta de avaliação agendada" |
| `convertido` | 🎓 Matriculado | 🩺 **Em tratamento** |

**O que NÃO muda:** a `key` e o `status`. `experimental`/`EXPERIMENTAL_AGENDADA` e
`convertido`/`CONVERTED` continuam sendo o que `mover-kanban` espera. Só o texto muda — trocar a
chave mexeria em `leads.status` já gravado, nas transições e no de-para do arraste, e nada disso
aparece na tela.

**O default é o de hoje, byte a byte, e isso é a direção da falha.** Ramo ausente → lista
inalterada. *Medido em produção em 02/11/2026: o `ramo_atividade` da ADR Valinhos está VAZIO*,
então ela cai no default. Falha ao ler o perfil na rota → `null` → catálogo de hoje: unidade real
perder o rótulo novo é incômodo; ganhar rótulo de outro ramo por erro de leitura seria defeito na
tela de quem trabalha.

### Dois achados testando o reconhecedor de ramo, nenhum imaginado

1. **`consultori` é prefixo de "consultorIA".** "consultoria tributária" casava como saúde — o
   ramo da própria empresa a quem a demonstração é feita. Virou `consultorio`.
2. **"consultoria tributária para empresas médicas" ainda casava**, por "médicas". Mas o ramo
   descreve o que a empresa **faz**, não quem ela atende: os clientes da MF8 são empresas, não
   pacientes. Virou um guarda-chuva de **outro ramo** (ensino + serviços profissionais) que vence
   a menção a saúde e devolve o default.

### ✅ PUBLICADO em 02/11/2026, 10:53 (America/Sao_Paulo), autorizado pelo Leo

```
suíte antes de publicar ... 115/115
merge ..................... PR #6 rebaseado na main (histórico linear), 6348e8e
pull + rebuild ............ /apps/lead-manager seguiu em main; compose project lead-manager
reinício .................. 10:52:54 → 10:53:04  (10 s, do início do build ao container Started)
saúde ..................... {"status":"ok"} · container healthy
backfill .................. 10:54 ciclo do cron (0 reconexões) + 10:56 RASO da Valinhos:
                            99 conversas conferidas contra o WhatsApp, 0 inseridos, 0 erros
```

**O CATÁLOGO SERVIDO AGORA, medido nos dois tenants pela rota real:**

| tenant | `ramo_rotulo` | a coluna da consulta | a coluna de quem fechou |
|---|---|---|---|
| Clínica (demo) | `"saude"` | 🩺 **Avaliação** — "Consulta de avaliação agendada" | 🩺 **Em tratamento** |
| ADR Valinhos | `null` | 🎯 Experimental — "Aula experimental agendada" | 🎓 Matriculado |

A segunda linha é a que importa: a unidade real **não mudou**, e isso está medido no serviço no ar,
não inferido de um teste.

**⭐ A CONTAGEM DE REFERÊNCIA QUE FALTOU NA PRIMEIRA GRAVAÇÃO, agora tomada.** Antes (10:51:46) e
depois (10:56:37) do reinício, por tenant:

| tabela | Valinhos antes | Valinhos depois | clínica antes | clínica depois |
|---|---|---|---|---|
| messages | 61.944 | **61.944** | 23 | 23 |
| staff_outbound_samples | 81.388 | **81.388** | 9 | 9 |
| conversations | 2.305 | **2.305** | 12 | 12 |
| leads | 964 | **964** | 10 | 10 |
| service_account | 1.139 | **1.139** | 10 | 10 |
| renovacao_touchpoint | 543 | **543** | 3 | 3 |

Idênticas. **Nada foi perdido na janela do reinício** — e isto é medição, não a inferência
estrutural que a primeira gravação teve de usar.

⚠ E a diferença entre as duas rodadas de backfill vale entender, porque uma delas quase bastou e
não bastava: a das 10:54 (`--all`, o ciclo do cron) devolveu `reconexoes: 0, inseridos: 0` — ela
NÃO puxou nada, apenas concluiu que não havia motivo para puxar. Um reinício de 10 s não muda o
estado da instância na Evolution, então nenhuma reconexão é detectada. "0 inseridos" ali significa
"não procurei", não "procurei e não havia". A das 10:56 (`backfillTenant(deep:false)`) é a que
PROCUROU: conferiu 99 conversas contra o histórico do WhatsApp.

### 🔴 INCIDENTE que eu causei em 02/11/2026, 11:00 — e o conserto

**O que aconteceu.** Para testar a trava de âncora nova, rodei na VPS
`cenario --hoje=2026-11-02` **sem `--ensaio`**, confiando que o `git fetch` anterior tinha
trazido o código com a trava. **O fetch falhou** — aquele clone foi feito com
`--branch X --depth 1`, então o refspec do remoto só cobre X e `origin/<outra-branch>` nunca
existe. O script não tinha `set -e`, o erro passou, e o comando rodou com o **código antigo** e a
**âncora errada**.

**O dano, medido:** as dez vigências foram sobrescritas 2 dias antes (primeiro vencimento
`2026-09-23` em vez de `2026-09-25`). **Nenhuma duplicação** — 10 contratos, 23 mensagens, 12
conversas, 3 toques, iguais antes e depois: os uuids derivados fizeram um UPDATE limpo, que é
exatamente o que eles existem para fazer.

**O conserto:** nova rodada com `--hoje=2026-11-04`. As dez datas conferidas uma a uma contra a
lista esperada: **iguais**. Toques de volta em D-10 (Beatriz, vence 14/11, toque 04/11) e D-2
(Renata, vence 06/11, toque 04/11).

**As três coisas que isto ensina, e as três são sobre como eu verifico:**

1. **Não conferi que a AÇÃO terminou antes de usar o que ela produziu.** O `git fetch` falhou em
   silêncio e eu segui. Código de saída não lido, `set -e` ausente.
2. **A trava que eu estava testando era a que teria me barrado** — e ela não estava publicada
   ainda. Testar uma proteção contra produção antes de a proteção existir ali é rodar o caso
   ruim sem a proteção.
3. **`--ensaio` foi o que separou um susto de um estrago** nas duas vezes que eu errei a âncora.
   Ele não é cerimônia.

### 🔴 E um erro de LEITURA, no mesmo minuto: `tail` cortou a resposta

Ao conferir as contagens, vi as saídas da Valinhos irem de 81.388 para **81.390** (+2) e fui
procurar a origem. Pedi "as 4 mais recentes" e a saída mostrou linhas de **10:00** e **08:25** —
anteriores à minha referência. Conclusão aparente: contradição entre o `count` e a listagem.

**Não havia contradição.** O corpo daquelas mensagens tem VÁRIAS LINHAS, e o meu `tail -12`
empurrou as duas linhas realmente mais recentes para fora da saída. As +2 são de **11:00:04 e
11:00:05** — um "Alerta de faltas" real, enviado pela recepção **7 minutos DEPOIS** da janela do
reinício (10:52:54–10:53:04).

Então, com a leitura certa:

- **entradas da Valinhos na janela do reinício: 0** (`messages` 61.944 nas duas pontas)
- **as +2 saídas são atividade legítima posterior**, e o LM as CAPTUROU — o que é prova positiva
  de que o recebimento voltou funcionando depois do reinício

A lição é a mesma de sempre, e aqui ela não foi sobre o sistema: **cortar a saída produziu um
fato falso.** Eu quase registrei "anomalia nas contagens da Valinhos" por causa de um `tail`.

### 🔴 Um defeito que a publicação revelou: `deploy/` não entra na imagem

O runbook deste repositório, e a prática registrada de que "todo deploy do LM pede backfill
depois", mandam rodar `node deploy/wa-sync-once.js`. **Não roda no container:** o `.dockerignore`
não o exclui, mas o `Dockerfile` tem exatamente quatro `COPY`: `package.json`, `src`, `db` e
`scripts`. `/app/deploy` não existe. Medido em 02/11/2026 nas duas pontas — `grep COPY Dockerfile`
e `ls /app` na imagem publicada.

(Observação achada no caminho, sem ação e fora do escopo de hoje: a linha 8 é
`npm install --omit=dev`, sem o `package-lock.json` no `COPY` — então a imagem não está presa às
versões travadas no lock. Não medi consequência nenhuma disso; só registro.)

E rodar no host também falha, por outro motivo: o `DATABASE_URL` e o endereço da Evolution usam
NOMES DE CONTAINER, que o host não resolve (`EAI_AGAIN`). O caminho que funcionou foi copiar o
script para dentro de `/app/` e rodar ali — mas isso é contorno, não procedimento.

**Consequência prática:** o passo de backfill do runbook é inexecutável como está escrito, e o
modo de falha é silencioso — quem seguir o runbook vê um erro de módulo e pode concluir que o
backfill "não era necessário". Conserto: incluir `deploy/` na imagem (uma linha no `Dockerfile`),
ou reescrever o passo do runbook com o caminho real. **Não consertei** — é mudança no `Dockerfile`,
que muda a imagem publicada, e a publicação de hoje já foi autorizada para outra coisa.

### Como exigir isto (o que exigiu publicar)

Medido em 02/11/2026: o LM no ar serve `🎯 Experimental` e `🎓 Matriculado`, e o campo
`ramo_rotulo` **não existe** no código publicado. Então, ao contrário do cenário (que era só
dado), o rótulo novo só aparece com **merge na main + `git pull` + rebuild da imagem** em
`/apps/lead-manager`.

Custo medido, para a decisão não ser no escuro:

- O reinício derruba o LM por alguns segundos. **O webhook dispatcher não tem fila nem retry**:
  mensagem de WhatsApp que chegar na janela é PERDIDA, e a rede de 3 minutos **não** cobre
  reinício — pede `deploy/wa-sync-once.js` depois.
- Volume da Valinhos nas últimas 24h: **11** mensagens de entrada (0,5/hora) e **3** saídas da
  recepção. Última mensagem 40 min antes desta medição. Então a chance de a janela coincidir com
  uma mensagem é pequena — e o backfill a recupera.
- O que sobe junto: tudo deste PR. É aditivo, e a mudança no `stages.js` é idêntica ao de hoje
  para a Valinhos — provado por teste, não por inspeção.

**Alternativa sem publicar:** não mostrar o Kanban. As telas pedidas (Caixa de Entrada e
Renovações) não têm nenhum desses dois rótulos e já funcionam com o que está no ar.

## O que NÃO está feito

- **O passo de backfill do runbook é inexecutável como está escrito** ( não entra na
  imagem) — ver a seção da publicação. Não consertei: mexe no Dockerfile.
- **A TELA RENDERIZADA não foi vista POR MIM.** O dashboard pede login e eu não digito senha. Abri o
  painel do navegador em `/f/clinica-exemplo/inbox` e ele redirecionou para `/login` — que é o
  comportamento certo, e é onde eu paro. Tudo até a borda da tela está conferido (a régua de
  tenant do dashboard publicado e as 6 rotas HTTP que a tela consome); o que falta é alguém
  logado olhando os pixels.
- **A âncora de datas é 04/11/2026**, o dia da apresentação. Consequência hoje (02/11): as três
  mensagens mais novas aparecem com data **futura**, 04/11. Na apresentação ficam certas. Rodar
  `cenario` de novo com outra âncora leva segundos e é idempotente (os uuids são derivados).
- **Não abri nenhuma tela.** Não há prova visual de que a Caixa de Entrada da clínica renderiza o
  cenário. Toda afirmação sobre as telas aqui é *verificado em código*, nunca *verificado na tela*.
- **O rótulo do módulo `QUALIDADE` é "Gestão de Retenção"** e os comentários do demo-seed do
  dashboard o descrevem como "de escola". Não conferi como ele aparece na navegação da clínica.
- **Fora do escopo por escolha:** módulo de boas-vindas (desligado), Kanban de leads (os dados
  existem; não conferi a tela), mídia nas conversas além de um áudio com transcrição, grupos de
  WhatsApp, e a aba de Reconquista da tela de Renovações.
- **Não usei o estágio `EXPERIMENTAL_AGENDADA`** no cenário: ele significa "aula experimental
  agendada", vocabulário de escola de música, e apareceria na tela de uma clínica.

---

## Afirmações e suas fontes

| afirmação | marca |
|---|---|
| `lead_tenant_id` da clínica está vazio | *verificado em produção, 02/11/2026* (sessão Fase 0) |
| `tenants_active()` é `WHERE lead_manager_active`, e 8 rotinas leem dela | *verificado em código* |
| as rotas do inbox e de renovações não consultam `lead_manager_active` | *verificado em código* |
| `service_account` não tem coluna de valor | *verificado em código* (060 + 072/105/185) |
| o CHECK de `marco` hoje aceita 6 valores, não 2 | *verificado em código* (092 → 109) |
| 131, 132–169, 185 e 186 não estão aplicadas em produção | *verificado em código* (RESERVAS.md) — e RESERVAS.md é documento, não medição: **inferido** sobre o estado atual do banco |
| a clínica tem 12 conversas, 10 contratos e 3 toques, todos endereçados ao pagador | *verificado em produção, 02/11/2026* |
| a aba Renovações do inbox lista 3 conversas e a tela enxerga 6 contratos na janela | *verificado em produção, 02/11/2026* |
| `tenants_active()` devolve só a Valinhos depois da criação da clínica | *verificado em produção, 02/11/2026* |
| a Caixa de Entrada da clínica **desenha** o cenário | **não conferido** — nenhuma tela foi aberta, e sem o `lead_tenant_id` não há como abrir |
| as contagens da Valinhos não mudaram | **não conferido** — não tomei contagem de referência antes de gravar |
| os telefones fictícios não pertencem a ninguém | **não conferido** — não há como conferir; a garantia é o tenant sem credencial |

---

## Resumo em uma linha, sem sigla

O cenário de mentira da clínica **está gravado** dentro do Lead Manager: 12 conversas de WhatsApp,
10 contratos e 3 lembretes de renovação, com nenhum número sorteado e nenhum valor em dinheiro. As
três conferências rodaram contra o banco de verdade e passaram. A Valinhos não foi tocada e a
clínica está fora de todas as rotinas que rodam sozinhas.

**O que falta para alguém VER isso numa tela:** o campo que liga a unidade a esta conta, que é do
outro repositório. Enquanto ele não for gravado, o dado está lá e as telas não sabem onde procurar.

**O que eu não conferi:** nenhuma tela foi aberta.
