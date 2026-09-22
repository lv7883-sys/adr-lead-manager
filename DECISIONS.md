# DECISIONS.md — motor de marketing como MÓDULO DE PRODUTO

Registro das decisões tomadas sob a premissa corrigida (20/09/2026): o motor de marketing
não é satélite de uma escola, é **módulo vendido separadamente** a unidades da rede e, depois,
a empresas de outros segmentos. Multi-tenant em todas as camadas, desde o dia zero.

Cada item traz o que foi decidido, por quê, e como voltar atrás.

---

## 0. O que foi revertido da sessão anterior

**Resumo honesto: não havia o que reverter em código.** Antes de escrever qualquer linha,
procurei o que a premissa antiga teria deixado — e não existe neste repositório nem no resto
da máquina:

| Procurado (o que a correção manda desfazer) | Encontrado |
|---|---|
| `MARKETING_ENGINE_ENABLED` no `.env` | **não existe** — `grep -r MARKETING` em `/c/dev` não devolve nada |
| schema `marketing` com tabelas sem `tenant_id` | **não existe** — nenhuma tabela de conteúdo/mídia/publicação em `db/migrations` (a sessão anterior tinha instrução explícita de não criar: "outro repo") |
| fila FIFO global, worker, `media_path` | **não existem** |
| repositório do motor | `C:\dev\adr-marketing-digital` existe e está **vazio** (nem é repositório git) |

O que a sessão anterior (atribuição de origem de lead) deixou foi auditado item a item contra
a premissa nova:

| Artefato da sessão anterior | Veredito |
|---|---|
| `lead_manager.origem_lead` (migr. 171) | **mantido.** Já nasceu `tenant_id NOT NULL` + RLS `ENABLE`/`FORCE` + grants por coluna. |
| `lead_manager.mapa_campanha` (migr. 170) | **mantido.** A PK já é `(tenant_id, codigo_campanha)` — naquela sessão isso foi um desvio do enunciado, justamente para duas unidades poderem usar o mesmo código sem se atropelar. A premissa nova confirma o desvio. |
| `src/origemLead.js`, gancho no webhook | **mantidos.** Nenhuma flag de ambiente, nenhuma credencial lida de `process.env`, nenhum caminho de arquivo derivado de entrada do usuário. |
| Memória de projeto "atribuição de mídia paga" | **corrigida**: dizia "para a Academia do Rock Valinhos", agora diz módulo de produto multi-tenant. |

**Uma dívida real ficou daquela sessão** (R1, abaixo): a atribuição de origem é do
`LEAD_MANAGER`, não do `MARKETING_ENGINE`, e hoje roda sem verificação de licença — ela está
no caminho do webhook, e mexer ali estava fora do escopo desta sessão ("não altere o
comportamento do webhook").

---

## 1. Decisões desta sessão

### D1 — O núcleo nasce no `adr-lead-manager`, não no repositório vazio do marketing
As migrações do banco `adr_scheduler` são administradas aqui (`db/migrations/`, 143 arquivos),
e o núcleo de plataforma é do **ecossistema**, não do motor: Scheduler, Lead Manager, BI e
Fiscal leem as mesmas tabelas. Criar `plataforma.*` num repositório recém-criado e vazio
significaria duas séries de migração para o mesmo banco — a receita de migração aplicada fora
de ordem.
*Volta atrás:* mover `db/migrations/172`, `173`, `src/plataforma/` e `src/marketing/` para o
repositório do motor quando ele existir de verdade, mantendo a numeração.

### D2 — Schema `plataforma`, não `public` ⚠ desvio do enunciado
O pedido dizia "schema public". Duas razões para não obedecer ao pé da letra:
1. o **ADR-051** (já escrito neste repo, Fase 0 entregue no commit anterior) reserva o schema
   `plataforma` exatamente para o núcleo canônico, com `plataforma.aplicacao` e
   `plataforma.assinatura` — que respondem à mesma pergunta destas tabelas. Criar o mesmo
   registro canônico em `public` produziria os **dois registros canônicos** que a premissa
   nova existe para evitar. Os nomes reservados pelo ADR-051 **não** são usados aqui (D17);
2. `public` é o schema do `search_path` padrão, onde extensões e ferramentas criam objetos.
   Produto em `public` é colisão de nome esperando acontecer.

Os nomes do enunciado foram traduzidos (ver D16) e reduzidos a dois (ver D18):
`credencial_unidade` e `consumo_evento`. O desvio deste item é só de namespace.
*Volta atrás:* `ALTER TABLE plataforma.<t> SET SCHEMA public;` nas duas tabelas e na vista.

### D3 — `tenant_id` sem chave estrangeira
O núcleo da plataforma **não pode depender da tabela de um módulo**. Uma FK para
`lead_manager.tenants` inverteria a dependência (plataforma → módulo). Hoje o valor é o uuid
do tenant do Lead Manager, que é o mesmo que a RLS já carrega em `app.current_tenant`.
*Volta atrás:* quando `plataforma.unidade` existir (ADR-051 Fase 1), adicionar a FK para lá.

### D4 — Credencial cifrada **pela aplicação**, não por pgcrypto ⚠ desvio do enunciado
O enunciado pedia pgcrypto. Ficou **AES-256-GCM da aplicação** (`src/crypto.js`, chave
`LM_ENCRYPTION_KEY` do ambiente de infra), que é o padrão que este sistema já usa em
`tenants.evolution_token_enc`. A versão anterior deste arquivo usava pgcrypto e eu mesmo
registrei o risco aqui (era a dívida A2); a sessão do ADR-051 fechou o argumento:
- com pgcrypto a chave viaja como **parâmetro de cada consulta** e acaba em log de erro, em
  `pg_stat_statements` e **no dump**. O backup deixaria de proteger o segredo, porque chave e
  segredo passariam a morar no mesmo lugar;
- o teste de restauração que já existe (`deploy/fase0/restore-test.sh` + `verifica-cifra.js`)
  só sabe conferir a cifra da aplicação — com pgcrypto, a verificação de integridade do
  backup deixaria as credenciais de fora;
- a coluna virou `text` (base64 `iv|tag|cifra`), o mesmo formato do Scheduler, e a migração
  não precisa mais de extensão nenhuma.
`credenciais.js` **recusa** operar sem `LM_ENCRYPTION_KEY`: `src/crypto.js` tem um fallback
de desenvolvimento (`insecure-dev-key`) que não pode ser usado para segredo de cliente.
A tabela ganhou `metadados jsonb` (o que não é segredo: e-mail, perfil, id da unidade na
Extranet, validade) e `revogado_em`: **revogar apaga o segredo** (`valor_cifrado = NULL`) e
mantém a linha. ⚠ **Apagar aqui não encerra a exposição**: os backups já gravados continuam
com o segredo cifrado e a chave é a mesma. O que encerra é revogar NA ORIGEM (trocar a senha,
girar o token) — por isso `revogarCredencial()` registra `revogado_na_origem` em metadados e
`pendentesNaOrigem()` lista o que foi apagado daqui e ainda vale do outro lado. Correção
apontada pela sessão do ADR-051, que adotou este padrão como o do ecossistema na **D10 do
ADR-051 (commit 3a00626)** — a Fase 7 (exclusão) vai usá-lo em vez de inventar outro caminho.
Lá está escrita também a ressalva que vale repetir aqui: `revogado_na_origem` é **declaração
de quem revogou, não prova**. Provar exigiria tentar usar a credencial e receber 401 — o que
tem custo próprio, porque bater no provedor com credencial supostamente morta é exatamente o
tipo de requisição que dispara alarme de segurança do outro lado. Fica como possibilidade,
não como plano.
*Volta atrás:* `CREATE EXTENSION pgcrypto` + `pgp_sym_encrypt/decrypt` nas duas consultas de
`credenciais.js` e coluna `bytea`.

### D5 — Sem *fallback* para `process.env` no resolvedor
`lerCredencial()` não cai em variável de ambiente quando a unidade não tem credencial
cadastrada. Um *fallback* silencioso faria a unidade B gastar na conta da unidade A — que é
exatamente o que o resolvedor existe para impedir. Sem credencial, devolve `null` e quem
chamou decide como falhar.

### D6 — Rodízio pelo relógio da própria tarefa, sem tabela de controle
A ordem de atendimento sai de `marketing.unidades_com_fila()`, que devolve por unidade:
pendentes e `max(pega_em)`. Atende quem esperou mais (ou nunca foi atendida). Não há tabela
de rodízio para manter em sincronia — menos estado, menos jeito de o rodízio "desafinar".
A função é `SECURITY DEFINER` porque "quem está na fila?" é pergunta **da plataforma**: ela
devolve id da unidade, contagem e horário — **nunca conteúdo** (há teste provando).

### D7 — Cota: alcançar o limite já barra, e a tarefa diz por quê
`usado >= limite` (não `>`), para que `tarefas_mes: 100` signifique cem, não cento e um. Ao
estourar, **todas** as pendentes daquela unidade viram `situacao='cota_excedida'` com
`motivo_cota` preenchido (`"tarefas_mes: 100/100"`), e o trabalhador segue para a próxima fila.
Fila que para sem dizer por quê é a pior forma de falhar num produto pago.

### D8 — Rota sem licença responde **402**, não 403
403 é "você está autenticado e não pode"; 402 (*payment required*) é "existe, mas esta unidade
não contratou" — que é a informação que o front precisa para oferecer a contratação.
Falha ao **ler** a licença responde 503 e **não** libera o módulo.

### D9 — ~~Catálogo `plataforma.modulo`~~ **REVOGADA em 20/09 (ver D18)**
A versão anterior criava um catálogo de módulos. Saiu junto com a tabela de contratação: o
catálogo de aplicações é do ADR-051 (`plataforma.aplicacao`). O que sobrou desta decisão vale
para as tabelas que ficaram: o teste de isolamento confere `relrowsecurity` e
`relforcerowsecurity` em **todas** as tabelas dos dois schemas novos, e falha se faltar.

### D10 — `make test` não roda `node --test test/` inteiro
O anexo de riscos do ADR-051 (C7) registra que `npm test` pode varrer `test/` e pegar testes
que escrevem em banco real. `make test` lista os arquivos **puros**, que rodam offline;
`make itest` sobe Postgres descartável. `make ci` = os dois, e é o que deve travar o build.
`make migrate` recusa DSN que não seja `127.0.0.1`/`localhost`.

### D11 — Coolify: removido do `.env.example`, **mantido** no `docker-compose`
`COOLIFY_URL`/`COOLIFY_API_KEY` não eram lidos por nenhuma linha de código — saíram. Já a rede
externa `coolify` no `docker-compose.lead-manager.yml` é o **nome real da rede Docker** onde
o Postgres e o Traefik vivem hoje; renomear derrubaria o deploy. Não é preferência de
ferramenta, é endereço.
*Volta atrás:* quando a infra sair dessa rede, renomear lá e aqui no mesmo PR.

### D12 — `GEMINI_API_KEY` continua no `.env` do Lead Manager
`src/gemini.js` (classificação, rascunho, transcrição) lê a chave do ambiente, e mexer nisso
mudaria o comportamento da classificação — fora do escopo desta sessão. O **motor de
marketing** não lê nenhuma credencial de ambiente. Migrar o Lead Manager para
`lerCredencial(tenant, 'gemini', 'chave_api')` continua pronto, mas NÃO será usado agora —
a chave de IA fica compartilhada de propósito (D20).

### D13 — `path.posix` no caminho de mídia
Produção é Linux; a máquina de desenvolvimento é Windows. Com `path.join` nativo, o mesmo
código geraria `\` aqui e `/` lá, e o `CHECK` do banco (que compara texto) recusaria a linha
gravada no Windows. `path.posix` deixa o caminho idêntico em qualquer sistema.

### D14 — A trava de travessia de diretório está no banco também
Além da sanitização em `src/marketing/midia.js`, a tabela `marketing.arquivo` tem `CHECK`
exigindo que `media_path` comece em `/srv/adr-media/<tenant_id>/` e não contenha `..`. Um bug
de sanitização no app — ou um módulo novo que esqueça a regra — esbarra no banco antes de
escrever a linha.

### D15 — Entitlement aplicado onde há caminho de execução
O enunciado pede o middleware em "toda rota e job do módulo". **Ainda não existem rotas de
marketing** (esta sessão não criou API). O que existe é a fila, e ela está com os dois
portões: `enfileirar()` exige licença vigente, `reivindicar()` reconfere antes de cada
unidade — inclusive para pegar a suspensão que aconteceu depois de o job entrar na fila.
`exigirModulo()` está pronto e testado para a primeira rota que nascer.

### D16 — Tudo em português (instrução do Leo, 20/09/2026)
Nenhum nome novo em inglês: tabelas, colunas, valores de situação, funções e arquivos. O que
já existia no repositório em inglês (`tenant_lead_source`, `conversations`, `messages`…) fica
como está — renomear tabela em produção é outra frente.
**Duas exceções, ambas por consistência com as ~140 tabelas que já existem:**
`tenant_id` (a coluna de unidade em todo o banco e em toda política de RLS) e `external_id`
nas tabelas antigas. Nas tabelas novas, o telefone se chama `telefone`.
*Renomeado nesta rodada:* `lead_source`→`origem_lead`, `campanha_map`→`mapa_campanha`,
`module`→`modulo`, `tenant_module`→`modulo_contratado`, `tenant_credential`→`credencial_unidade`,
`usage_event`→`consumo_evento`, `marketing.job`→`marketing.tarefa`,
`marketing.media_asset`→`marketing.arquivo`, `requireModule`→`exigirModulo`,
`getCredential`→`lerCredencial`, `src/leadSource.js`→`src/origemLead.js`,
`entitlement.js`→`licenca.js`, `scripts/inspect-referral.js`→`scripts/inspecionar-origem.js`.

### D17 — Renumeração para 170–173 e um arquivo de reservas
A faixa **140–149 já era do ADR-052** (implantação guiada), combinada em 17/09 só por conversa
— eu ocupei 140–143 sem saber. Perguntei às duas outras sessões antes de decidir: a do
Diapasão não usa a série do LM; a da API confirmou a reserva do ADR-052 e reservou 131–139 e
150–169 para o ADR-051. Renumerei para **170–173**, que está livre, e criei
`db/migrations/RESERVAS.md` para a próxima frente não precisar perguntar.
Os nomes reservados pelo ADR-051 dentro do schema `plataforma` (`unidade`, `aplicacao`,
`assinatura`…) **não** são criados pela 172.

### D18 — Fonte única de contratação: `plataforma.assinatura` (decisão do Leo, 20/09/2026)
Havia **quatro** lugares para responder "esta unidade contratou este módulo?":
`app.tenant_modules` (produção, por `franquia_id`), `lead_manager.tenant_subscriptions`
(produção), `plataforma.assinatura` (ADR-051, ainda não existe) e a `modulo_contratado` que
esta sessão tinha criado. **A fonte única é a `assinatura`.** Consequências, já aplicadas:
- a 172 **não cria** `modulo` nem `modulo_contratado` — só `credencial_unidade` e `consumo_evento`;
- **nenhum arquivo lê tabela de contratação direto.** Existe UM ponto de leitura,
  `_lerContratacao()` em `src/plataforma/licenca.js`, que hoje responde a partir de
  `app.tenant_modules` (ligada à unidade por `app.franquia.lead_tenant_id`, migr. 063 do
  Scheduler) e normaliza o resultado no formato que a `assinatura` vai devolver. Na Fase 6 do
  ADR-051, muda **uma consulta**, não N chamadores;
- a virada só acontece depois de comparar linha a linha o que as duas tabelas de produção
  dizem hoje e o que a `assinatura` passará a dizer;
- os grants de leitura estão em `db/grants/plataforma_contratacao_read.sql` (SELECT em duas
  tabelas, nenhuma escrita), para serem **revogados** quando a assinatura assumir;
- a **cota** (limite de uso) não é contratação: foi para `marketing.config_unidade.cota`, no
  schema do próprio módulo. Quando a assinatura carregar o plano, a coluna some.

### D19 — RLS compara TEXTO, não `uuid` ⚠ (correção de um erro real)
As políticas das tabelas novas comparam
`tenant_id::text = NULLIF(current_setting('app.current_tenant', true), '')`.
Motivo: neste banco `app.current_tenant` tem **três formatos** — uuid (Lead Manager), cuid
(dashboard/BI via `withTenantBi`) e inteiro (caminhos por franquia). Com `::uuid`, uma leitura
vinda de contexto de BI **não devolve zero linhas: quebra a requisição inteira** com
"invalid input syntax for type uuid", e o erro parece aleatório. O `bi_raw` deste mesmo banco
já compara como texto pelo mesmo motivo. As consultas da aplicação continuam filtrando
`tenant_id = $1` (uuid), então os índices seguem sendo usados.
*Apontado pela sessão do ADR-051 e confirmado pelo Leo.* As tabelas antigas do `lead_manager`
continuam com `::uuid` — mudá-las é outra frente (só são lidas em contexto do LM).

### D20 — A chave de IA **continua compartilhada**; o que vira por-unidade é a MEDIÇÃO
Eu vinha pedindo autorização para migrar `GEMINI_API_KEY` para `credencial_unidade`. O Leo
perguntou por que não dá para usar a mesma chave, e a resposta honesta é: **dá**. O pedido
era maior que o problema.
- **O problema real é "quanto cada unidade consome"**, e isso se resolve com `registrarUso()`
  depois de cada chamada de IA — uma linha por ponto de chamada, sem tocar em credencial e
  sem risco de alguma unidade ficar sem IA. Hoje **nada** no Lead Manager mede consumo de IA
  (só a fila do marketing chama `registrarUso`); é aí que está o valor, não na chave.
- **Separar a chave só é necessário quando** (a) o cliente exige usar a conta dele no
  provedor, (b) há exigência contratual/LGPD de que os dados passem pela conta dele, ou
  (c) o consumo dele justifica pagar direto ao provedor. Nenhuma vale hoje.
- **O que já é por unidade continua sendo**, e por outro motivo: Evolution, Meta e Extranet
  (21 pontos no código) — ali a credencial **é a identidade do cliente**, não um custo
  rateado. `credencial_unidade` existe para esses, e serve à chave de IA no dia em que (a),
  (b) ou (c) acontecer.
- **Risco aceito, e ele NÃO está mitigado** (correção de uma afirmação minha errada): eu disse
  que a cota por unidade impedia uma unidade de queimar o limite comum. **Não impede.** A cota
  (D7) só existe na fila do motor de marketing; a triagem, a Janis e a transcrição chamam a IA
  **sem limite nenhum**. O teto do Google é por PROJETO e conta requisições por MINUTO, então o
  que morde é pico simultâneo, não volume mensal — e morde todas as unidades ao mesmo tempo,
  incluindo o painel, que usa a mesma chave. Que isso é real está no próprio código:
  `src/jobs/batch-classifyconversa.js:123` tem uma pausa de 700 ms comentada como
  "pacing anti-429", e há repetição com espera crescente em `engine.js`.
  **Ordem correta de mitigação:** (1) medir com `registrarUso()` — sem saber se estamos em 5%
  ou 80% do teto não dá para decidir nada, e é a mesma medida que sustenta o preço com EBIT
  que cubra a API; (2) uma fila única com pausa para chamadas de IA, no molde do throttle de
  envio do WhatsApp (E15-A); (3) projeto/chave separado só se a medição mostrar o teto perto.
*Volta atrás:* o caminho continua pronto — `lerCredencial(unidade, 'gemini', 'chave_api')`
com o env como rede, migrando uma unidade por vez.

| # | Dívida | Por que ficou |
|---|---|---|
| ~~A1~~ | **RESOLVIDA em 20/09 (D18): fonte única = `plataforma.assinatura`.** Resta a virada da Fase 6 do ADR-051, com comparação linha a linha | — |
| ~~A2~~ | **RESOLVIDA em 20/09 (D4): a chave de cifra não viaja mais para o banco** — a cifra passou a ser da aplicação | — |
| ~~A3~~ | **ARQUIVADA em 20/09 — a chave de IA continua compartilhada, de propósito** (ver D20) | pedido meu, recusado pelo Leo com razão |
| **A4** | `origem_lead`/atribuição sem verificação de licença do `LEAD_MANAGER` | está no caminho do webhook, que esta sessão não podia alterar |
| **A5** | Cobrança/fatura a partir de `consumo_evento` | esta sessão entrega a **medição**; preço e fatura são outra frente |
| **A6** | Rodar as migrações e a suíte de isolamento num Postgres de verdade | esta máquina não tem Docker nem Postgres (ver relatório) |
| **A7** | **Nenhuma chamada de IA do Lead Manager é medida nem limitada** — a cota (D7) só cobre a fila do marketing. Sem medição não dá para saber a distância do teto por minuto do Google (compartilhado com o painel), nem precificar com EBIT que cubra a API | descoberto ao responder "por que a chave estouraria?" (D20); com uma unidade é teórico, com 10–20 é o primeiro gargalo |

---

## 3. Sessão 3 — executar isolamento, fechar LGPD, travar custo órfão (20/09, noite)

### D21 — O ambiente de teste é um Postgres descartável, e é impossível confundi-lo com produção
`docker-compose.test.yml`: `postgres:16-alpine`, porta **5433** presa em `127.0.0.1`, dados em
**tmpfs** (morrem com o container), `fsync=off`. Três travas contra o acidente clássico de
rodar migração de teste no banco de verdade: porta diferente, sem persistência, e o alvo
`migrate` que recusa DSN fora de `127.0.0.1`/`localhost`.
Todo comando docker no Makefile leva `MSYS_NO_PATHCONV=1`: no Git Bash do Windows, argumento
começando com `/` (ex.: `/var/lib/postgresql/data`) é traduzido para caminho do Windows antes
de chegar ao docker, e o erro resultante é difícil de ler.
O bootstrap saiu dos scripts `.sh` e virou SQL versionado em `test/db/` — bootstrap duplicado
em dois scripts desanda sem ninguém perceber. Os dois `run-*-itest.sh` foram substituídos
pelos alvos do Makefile.

### D22 — Custo de IA ganha dono por CONTEXTO, não passando `tenantId` por 12 arquivos
Medir IA por unidade exige saber de quem é a chamada. O caminho óbvio — acrescentar `tenant`
nas ~18 funções de `src/gemini.js` e nos 12 arquivos que as chamam — tem um defeito fatal:
basta **um** caminho esquecido para nascer custo órfão, e ninguém descobre até a fatura.
Ficou `AsyncLocalStorage` (`src/plataforma/contexto.js`): `comUnidade()` marca a dona no
início do processamento e cobre tudo que rodar dentro, em qualquer profundidade. Duas linhas
em `src/routes/webhook.js` cobrem entrada e saída inteiras — mídia, transcrição, funil, Janis.
`src/plataforma/ia.js` é o único arquivo autorizado a importar o SDK, e `test/sdk-ia-sem-atalho.test.js`
falha se alguém importar em outro lugar. `src/gemini.js` não instancia mais SDK: as 16 chamadas
passam por `ia.modelo()` e a medição entrou em `withModelFallback`, o funil por onde todas passam.
*Detalhes que valem registro:* tentativa que falhou TAMBÉM é medida (o provedor cobra a
tentativa); erro ao gravar consumo nunca derruba a chamada; e a gravação se auto-desliga após a
primeira falha estrutural — enquanto a 172 não for aplicada, seriam duas linhas de erro por
mensagem recebida.
*Falta:* as rotinas em lote (`src/jobs/*`) ainda não abrem contexto. Não inventei um `tenantId`
para elas: elas vão aparecer sozinhas no log como `ia.custo_orfao`, que é justamente o
mecanismo para achá-las. Dívida A8.

### D23 — LGPD: nove campos sobrevivem à exclusão, e o teste varre a linha inteira
A exclusão apaga telefone (vira sentinela), `payload_bruto` (o webhook inteiro: telefone, nome
de perfil, texto da mensagem) **e também** `anuncio_url`, `anuncio_titulo` e `anuncio_texto` —
a URL costuma carregar parâmetros de rastreio, e título e corpo do anúncio são reconstituíveis
a partir de `anuncio_id`. Sobrevivem só: `anuncio_id`, `codigo_campanha`, `campanha_ref`,
`motor`, `objetivo`, `publico`, `criativo`, `metodo`, `capturado_em`.
O gatilho de imutabilidade da 171 foi ajustado para permitir exatamente essa forma de apagar —
e só ela: apagar junto com uma mudança de campanha continua levantando exceção. O `GRANT UPDATE`
por coluna acompanha.
**O teste varre `to_jsonb` da linha inteira**, não uma lista de colunas escrita à mão: coluna
nova com dado pessoal que alguém esqueça de limpar amanhã deixa o teste vermelho sozinho. Lista
à mão envelheceria em silêncio, que é como esse tipo de vazamento costuma nascer.

### D24 — A branch continua `feat/origem-lead-e-nucleo-plataforma`
O pedido citava `feat/marketing-modulo-multitenant` *caso o trabalho ainda não estivesse
commitado*. Estava: dois commits atômicos por tema, feitos no fim da sessão 2. Renomear a
branch só mudaria o rótulo e perderia a metade "origem do lead", que é metade do trabalho.

### Status das dívidas depois desta sessão
| # | Situação |
|---|---|
| A6 | **Aberta e agora é a única que bloqueia o merge.** A suíte de isolamento continua sem rodar: esta máquina não tem Docker (confirmado por ausência de binário, de serviço, de processo e de WSL) nem qualquer Postgres. |
| A7 | **Fechada para o caminho do webhook** (entrada e saída medidas). Segue aberta para as rotinas em lote → vira A8. |
| A8 | **Nova:** `src/jobs/*` chamam IA sem contexto de unidade. O log `ia.custo_orfao` é o rastro para encontrá-las. |

### D25 — O jid do WhatsApp não é telefone (bug real, achado por coordenação)
O Leo pediu para não mexer em nada perto de telefone sem combinar com quem já tinha
trabalhado nisso. A coordenação com a sessão de WhatsApp não só confirmou a régua — **ela
revelou um bug meu**. `registrarOrigem` calculava a chave do contato sobre `msg.externalId`,
que sai de `jid.split('@')[0]`. Três formas de jid produziam chave falsa:
- `5519999990001:12@s.whatsapp.net` — o `:12` (sufixo de aparelho) entrava como dígito, e a
  MESMA pessoa virava contato novo, com origem gravada duas vezes;
- `NNNNNNNN@lid` — id de privacidade, não telefone: os dígitos do lid viravam "telefone" e
  inventavam um contato;
- `@g.us` — grupo. Já era barrado no webhook, mas não no módulo.

A régua aplicada é a que **já existia** em `src/waChats.js`: tira o sufixo de aparelho,
recusa grupo, resolve `@lid` pelo mapa `wa_lid` (migr. 115) e exige PN de 10 a 15 dígitos.
Sem telefone confiável, **não grava**: chave errada é pior que origem ausente — ausente
aparece como `nenhum` e alguém investiga; errada atribui a campanha à pessoa errada e
ninguém desconfia.
**Nada de `br_phone_key`, `telefoneBR.js` ou das migrações 085/094/112/113 foi alterado** —
só o meu chamador passou a respeitar a régua. Quatro testes (18–21) cobrem os quatro casos.
*Duas coisas que aprendi e valem registro:* `matchKeys` (JS) só tira o 9º dígito quando o DDD
está na lista ANATEL, enquanto `br_phone_key` (SQL) tira sempre que o local tem 11 dígitos e
o 3º é `9` — convergem no caso brasileiro real, divergem com DDD inválido. E número
estrangeiro fica com os dígitos como vieram, sem `+`.

### Status final da sessão 3
| # | Situação |
|---|---|
| **A6** | **FECHADA.** As suítes rodaram num Postgres descartável na VPS (container próprio, porta 5433, tmpfs — produção intocada): **22/22** na origem do lead e **13/13** no isolamento entre unidades. As migrações 170–173 aplicadas duas vezes, limpas, e a trava de RLS aprovou todas as tabelas novas. |
| A8 | Aberta: `src/jobs/*` ainda chamam IA sem contexto de unidade (aparecerão no log como `ia.custo_orfao`). |
| **A9** | **Nova, medida em produção pela sessão de WhatsApp (21/09):** a porta de entrada não normaliza o jid — `src/routes/webhook.js:68` faz `jid.split('@')[0]`, preservando o `:12` de aparelho e entregando dígitos de `@lid` como telefone. É o MESMO defeito que corrigi no meu módulo, uma camada antes. **Hoje quase não dói:** em Valinhos, 2.063 conversas, **zero** com `@lid` e **zero** com sufixo de aparelho; 21 mensagens em 30 dias chegam com `@lid` no raw e são resolvidas depois pelo mapa da 115. **Combinado explícito:** ninguém mexe na porta de entrada agora — trocar a régua ali mexe em `upsertConversation` e pode criar conversa nova para contato existente, que foi a dor das migrações 094/113. Quando aquela sessão for normalizar, ela avisa antes do PR e eu ajusto `vincularLead` no mesmo lote, avaliando backfill das origens órfãs. |

**Quatro defeitos reais foram encontrados por rodar o teste contra banco de verdade**, e
nenhum deles apareceria em teste de unidade: a coluna `ref`/`referencia` (que quebrava TODA a
medição de consumo em silêncio), o `--remove-orphans` que removeria o container de produção,
o jid não normalizado, e o contrato de retorno inconsistente. É o argumento a favor de a
suíte existir, e de ela ser bloqueante.

### Sessão 4 — publicação (21/09/2026, 19h24 UTC)
**Publicado.** `2351cad` no ar; imagem anterior marcada como `adr-lead-manager:rollback-pre-170-174`
(volta em um comando). Container saudável em 12 s, **zero erros** no arranque e depois.

**Não-regressão, com tráfego real:** o webhook recebeu e processou mensagem de grupo, recibos de
entrega e arquivou rascunho por resposta humana nos minutos seguintes ao deploy; o dashboard
(agendador de disparos) seguiu intocado e sem erros. Os `ack.updated` provam que o envio
continua chegando ao destino.

**Caminho de escrita provado EM PRODUÇÃO, sem deixar dado:** transação com `SET LOCAL ROLE
lead_manager_user` (RLS valendo de verdade) — o INSERT gravou `metodo=codigo_campanha` com
`chave_contato=1999999999` (br_phone_key correta), a tentativa de reescrever `campanha_ref` foi
**recusada por falta de privilégio** (migração 174 valendo, barrando antes mesmo do gatilho), e o
`ROLLBACK` deixou a tabela com 0 linhas.

**externalAdReply: NÃO aparece.** 300 mensagens recentes inspecionadas, 18 com `contextInfo`
(citação, menção, encaminhada) e **nenhuma** com `externalAdReply`. É o esperado: nenhum anúncio
Click-to-WhatsApp está no ar, então ninguém clicou em nenhum. A leitura de `contextInfo` funciona —
o que falta é o clique existir.

**Fumaça com `[TST1]`: PENDENTE, e depende de ação física.** O teste exige uma mensagem de entrada
de um telefone real; não tenho aparelho, e fabricar um payload no webhook de produção criaria lead
falso no funil da recepção. Fica para o Leo enviar. Até lá, o que está provado é tudo menos o
último elo: a captura nunca rodou com mensagem de verdade.

---

## Sessão 5 — ingestão de mídia do grupo (22/09/2026)

**O que é.** Fase 1 do motor de conteúdo: foto e vídeo que o professor manda no grupo de
WhatsApp viram matéria-prima, sem nenhuma ação humana a mais. Nada de IA ainda — a linha
nasce `pendente_curadoria` e quem a move é a fase seguinte.

### D26 — o grupo-fonte é CONFIGURAÇÃO por unidade, não variável de ambiente
`marketing.grupo_fonte (tenant_id, jid)`, com CHECK `jid LIKE '%@g.us'`. Cada unidade tem o
seu grupo (às vezes mais de um), e quem configura é a recepção pela tela — não um deploy.
O CHECK de grupo existe porque um telefone 1:1 cadastrado ali faria a ingestão capturar
conversa de cliente, que é exatamente o que não pode acontecer.
**Reversão:** `DELETE FROM marketing.grupo_fonte WHERE tenant_id = …` desliga a unidade sem
mexer em código; `DROP TABLE marketing.raw_asset, marketing.grupo_fonte` apaga a frente toda.

### D27 — deduplicação por CONTEÚDO (sha256), não por id de mensagem
São dois problemas diferentes e cada um tem o seu índice:
`uq_raw_asset_conteudo (tenant_id, sha256)` resolve *o professor reenviou o mesmo vídeo no
dia seguinte*; `uq_raw_asset_mensagem (tenant_id, mensagem_id)` resolve *o webhook reentregou
o mesmo evento*. Um só não cobriria o outro caso.
**Efeito colateral aceito:** duas fotos idênticas mandadas de propósito (a mesma arte por dois
professores) contam como uma. É o lado certo de errar — uma linha a menos para curar.

### D28 — figurinha NÃO é foto, mesmo chegando como `kind: 'image'`
O normalizador do webhook entrega figurinha como imagem de propósito (renderiza no mesmo
`<img>` da Caixa de Entrada). A ingestão barra pelos dois lados: `stickerMessage` no cru e
`webp` no mime. Sem isso, todo "figurinha de joinha" no grupo viraria matéria-prima de post.
Foi encontrado lendo o normalizador, não testando — e é o tipo de erro que só apareceria na
curadoria, semanas depois.

### D29 — a recusa é uma LINHA, não um silêncio
Cota estourada grava `situacao='cota_excedida'` e download quebrado grava `'falhou'`, os dois
com `motivo` por escrito. "A foto que mandei sumiu" não pode ser a única informação
disponível. A cota é conferida **antes** de baixar: cota estourada não gasta banda nem disco.
Cota ausente = sem limite; cota `0` = desligado.

### D30 — os bytes vêm do download que a Caixa de Entrada já fez
`baixarMidiaInbound` passou a expor `msg.media.diskPath`, e a ingestão lê dali. Baixar de
novo seria pagar duas vezes pelo mesmo arquivo — e a Evolution **não guarda mídia antiga**
(400 no segundo pedido), então a segunda tentativa nem sempre existe. Só quando o caminho não
está lá é que a ingestão baixa sozinha, com prazo de 45 s e três tentativas.
*A cópia é separada de propósito:* a da Caixa de Entrada vive em `MEDIA_ROOT` (`/app/uploads`,
sujeito a retenção) e a matéria-prima em `/srv/adr-media/<tenant_id>/materia-prima/`, com o
nome derivado do sha256. São ciclos de vida diferentes.

### D31 — a ingestão NUNCA lança e NUNCA toca no funil
Roda no caminho do webhook: qualquer erro vira log estruturado e a entrega segue. E entra
depois de tudo o que a Caixa de Entrada precisa — se a ingestão falhar, a bolha do grupo já
está gravada. O ramo de grupo do webhook já retornava antes do funil; nada disso mudou.

### Dívidas abertas nesta sessão
| # | Dívida |
|---|---|
| **A10** | Não existe tela para cadastrar o grupo-fonte: hoje é INSERT à mão em `marketing.grupo_fonte`. Enquanto for assim, `make ingest-status` é o único jeito de saber se a unidade está ligada. |
| **A11** | O arquivo é escrito no disco **antes** do INSERT. Se o INSERT falhar, sobra arquivo órfão — inofensivo (o nome é o hash, então reescrever é idempotente), mas ninguém o recolhe. Falta uma faxina periódica de arquivos sem linha. |
| **A12** | A ingestão roda dentro do contexto de unidade aberto com `modulo: 'LEADS'` (o do webhook). Não chama IA, então não há custo atribuído errado hoje — mas quando a curadoria com IA entrar, ela precisa do seu próprio `comUnidade(..., { modulo: 'MARKETING' })`. |

### Correção da dívida A9 (22/09/2026) — medida no lugar certo, o buraco é maior
A A9 dizia "**zero** conversas com `@lid`". **Está errado, e o erro era de medição:** contava-se
`conversations.external_id LIKE '%@lid'`, mas `webhook.js:68` faz `jid.split('@')[0]` — o sufixo
já foi removido ANTES de gravar, então uma conversa nascida de `@lid` fica no banco parecendo
telefone, só dígitos. Medindo pelo `remoteJid` dentro do raw da mensagem, em Valinhos hoje:

- **39 conversas** com `remoteJid @lid`;
- **4 existem só sob `@lid`**, sem par com jid normal (`53751599612092`, `5511999210621`,
  `551128386760`, `5519981252167`) — as três últimas têm 12–13 dígitos e passam por telefone
  brasileiro sem levantar suspeita;
- **1 lead já nasceu com telefone falso**: `1165f752-7305-47d2-bd09-61171c9e1788`, phone
  `+53751599612092`, QUALIFYING, criado em 18/09, visível na lista ativa.

Medição da sessão de WhatsApp (auditoria de QA somente-leitura sobre 719 leads, 22/09).
**Confirma que a guarda do módulo de origem era necessária:** `_telefoneDoContato()` resolve
`@lid` pelo mapa `wa_lid` e não grava origem sem telefone confiável — se gravasse a chave a
partir do `externalId` cru, teria criado origem para um contato que não existe.
**O combinado não muda:** a normalização da porta de entrada é daquela sessão, com backfill
(o lead falso + as 4 conversas); ela avisa antes do PR e eu ajusto `vincularLead` no mesmo
lote, avaliando o backfill das origens órfãs.

### Publicação da ingestão (22/09/2026, 18h32 UTC)
**No ar.** Migração 175 aplicada em produção (duas vezes, idempotente), com backup verificado
antes: `/root/lm-backups/pre-175-20260922-1820.sql.gz` (74 MB, `gzip -t` ok, 281.579 linhas).
RLS `ENABLE+FORCE` e política conferidas nas duas tabelas novas; privilégios conferidos —
`raw_asset` **sem DELETE** e `grupo_fonte` com DELETE, como desenhado (a checagem existe por
causa da migração 174).

Suíte na VPS, Postgres descartável: 68 puros + 23 origem + 13 isolamento + 6 ingestão =
**110, zero falhas**.

**O código subiu no deploy da sessão de WhatsApp**, não no meu: o merge `3c4f592` já estava no
`main` quando ela publicou `c8e87ae` às 18h32. Container saudável, **zero erros** desde o
restart, webhooks e inbox seguindo normalmente. `make ingest-status` rodou em produção e
respondeu o esperado: *"grupos-fonte: NENHUM — a ingestão está desligada para esta unidade"*.

**A ingestão está LIGADA no código e DESLIGADA por configuração**: sem linha em
`marketing.grupo_fonte`, a captura devolve `grupo_nao_e_fonte` antes de qualquer trabalho.
Ligar uma unidade é um INSERT (não há tela — dívida A10).

⚠ **Correção sobre o rollback.** Marquei `adr-lead-manager:rollback-pre-175` antes de publicar,
mas como a imagem seguinte subiu com a ingestão **e** com as correções de identidade da
assistente, aquela tag deixou de ser "o estado imediatamente anterior ao meu código" — voltar
nela desfaria trabalho de outra frente junto. **O caminho limpo para reverter só a ingestão é
`git revert` do merge + rebuild**, não a imagem antiga. (Apontado pela sessão de WhatsApp.)

### A13 — `vincularLead` usava o `external_id` cru — **FECHADA em 22/09/2026** (`43325ee`)
`src/routes/webhook.js:746` chama `origemLead.vincularLead(tenant.id, msg.externalId, log)`, e
`msg.externalId` é o `jid.split('@')[0]` da linha 68 — **sem a régua de jid**. Dentro,
`src/origemLead.js:253` faz `br_phone_key($3)` em cima disso.

**A escrita está protegida, a leitura não.** `registrarOrigem` passa pelo
`_telefoneDoContato()` (tira `:NN`, recusa `@g.us`, resolve `@lid` pelo `wa_lid`, exige 10–15
dígitos), então nunca existe linha de origem com chave de `@lid` — e uma chave podre não casa
com nada. É isso, e só isso, que segura hoje.

**O risco é estreito mas real:** se os dígitos de um `@lid` produzirem a mesma `br_phone_key`
de um contato real, o `vincularLead` gruda a origem real no lead falso. O lead
`+53751599612092` (medido pela sessão de WhatsApp) é o candidato exato — o telefone dele É o
número do `@lid`. Em 22/09 a `origem_lead` tem 39 linhas, todas vinculadas: há material real
para colidir.

**Conserto (não feito, de propósito):** o `vincularLead` deve usar a mesma régua da escrita em
vez do `externalId` cru. É arquivo meu e régua minha — **não encosta em `br_phone_key` nem em
`telefoneBR.js`**, respeitando o combinado. Ficou fora agora para não virar mais uma correção
pontual antes do raio-X de causas que a sessão de WhatsApp está levando ao Leo.

### Correção — `review_by='SERVICE'` NÃO quer dizer "sem humano" (22/09/2026)
Afirmei, medindo `leads.review_by` em produção (214 `SERVICE`, 102 nulo, **0** pessoa), que
"nenhum humano jamais confirmou um NOT_LEAD nesta base", e daí que o sync cede a um veredito
que ninguém deu. **A leitura estava errada.** O cabeçalho da migração 128 já dizia o que eu
não fui ler: `SERVICE` é a **credencial do DASHBOARD** — "pode ter sido alguém da recepção
clicando" (caso Camila Santana, 17/09 17:29). Apontado pela sessão da Extranet.

A medição continua válida; a conclusão, não. **O que fica é melhor:** o sinal de autoria é
ambíguo POR CONSTRUÇÃO. O latch do sync (`sync-extranet-leads.js:138`) decide "isto foi gente?"
testando `review_by <> 'SERVICE'` — numa coluna que mistura serviço automático e recepção
clicando. Qualquer regra nova por cima dela herda a ambiguidade, e é por isso que já houve
quatro rodadas de correção pontual.

**Sinal melhor:** `lead_eventos.autor`, que traz nome de pessoa. Medido nos leads em NOT_LEAD:
`ia_auto` 30, `extranet_auto` 12, `migracao-127` 7, `SERVICE` 6, **`Rafaela` 3**,
`migracao-128` 1. Cobertura parcial (59 leads com evento, de 316), então não decide sozinho —
mas sugere tratar `SERVICE` como **desconhecido**, nunca como automático.

*Lição, e é a segunda vez no dia:* a migração 128 documentava isso no cabeçalho. Medir a
coluna sem ler quem a escreve produz um número certo com significado errado — igual ao que
aconteceu com a contagem de `@lid` na A9.

**Ressalva ao parágrafo acima (mesma data):** `lead_eventos.autor` é melhor, mas **não
resolve** — o valor `'SERVICE'` aparece lá também, e ali sofre do mesmo defeito: é a
credencial, não a pessoa (confirmado pela sessão de auditoria, que viu `SERVICE` em Luciana,
Vanessa e Camila). Somando as duas fontes, **"decidido por humano" só é afirmável quando
aparece nome próprio** (`Rafaela`). `SERVICE` é desconhecido nos dois lugares, e leads sem
evento nenhum não respondem nada. Ou seja: hoje o sistema **não tem** como dizer quem decidiu
na maioria dos casos — e é esse buraco, não uma regra mal calibrada, que o conserto definitivo
precisa fechar.

*Convergência independente:* a sessão de auditoria chegou ao mesmo erro sobre `SERVICE` na
auditoria de 18/09 e já o havia retratado com o Leo. Dois caminhos separados tropeçaram na
mesma coluna — o que é argumento para a ambiguidade ser tratada no esquema, não na cabeça de
quem consulta.

**Convergência (22/09/2026) — dono e forma do conserto do NOT_LEAD.** O conserto das linhas
138–142 do `sync-extranet-leads.js` é da **sessão da Extranet**, e está parado aguardando
decisão do Leo. Forma combinada entre as três frentes:

- `review_by='SERVICE'` vira **DESCONHECIDO** → gera **pendência humana**, nunca override
  silencioso (é a tradução prática de "o sistema não sabe quem decidiu");
- `lead_eventos.autor` entra como sinal **quando existir** — e só nome próprio afirma humano;
- três guardas que a 127/128 provaram necessárias: fato-somente via
  `stages.temFatoExtranetSql`, internos por dígitos, e desfecho intocável; só fato ≥
  experimental ressuscita (Conexão/Atendido não).

Os **12 leads com `extranet_auto`** hoje em NOT_LEAD são, pela leitura da sessão da Extranet,
leads que o sync avançou e o roteador rebaixou **antes** do fix de 18/09 — reforçam o caso.
**Ninguém toca o arquivo sem combinar antes.**

**DECIDIDO pelo Leo (22/09/2026) e IMPLEMENTADO (este commit) — sessão da Extranet.** As três
partes aprovadas na forma combinada acima:

1. **Auto-devolução LIGADA** (`ressuscitarDescartado` em `sync-extranet-leads.js`): fato ≥
   experimental devolve descartado automático ao funil; **Ganhou → CONVERTED com desfecho NULO**
   (molde da 127 — o `contractConvert` distingue conversão de cliente pré-existente; carimbar
   aqui inflaria a taxa); aula → EXPERIMENTAL_AGENDADA. `review_*` é **preservado** (lição da
   128: a 127 limpou e tirou a trava do roteador). Evento + `stage_autoapply_log`
   (`from_stage='descartado'`) → reversível no Monitor; reversão grava
   `suggested_stage_dismissed` e a regra a respeita (sem loop).
2. **Descarte CONFIRMADO** (`review_result='confirmed_not_lead'`, qualquer `review_by` — SERVICE
   é ambíguo por construção) **não é sobrescrito**: permanece no card Plantão › Filtro
   (`stats.pendencia_humana` conta). Escolha consciente, não limitação esquecida.
3. **Conserto estrutural** (dashboard gravar o NOME real de quem clica) → tarefa aberta em
   separado para a frente do Scheduler.

O estoque atual (leads com fato hoje em NOT_LEAD sem confirmação) é devolvido pelo próprio
cron no primeiro ciclo após o deploy — sem migração nova.

### A13 fechada (22/09/2026) — `43325ee`
`vincularLead` passou a receber `(msg, rawBody)` e a derivar o telefone pelo **mesmo**
`_telefoneDoContato()` da gravação. **Nada de `br_phone_key`, `telefoneBR.js` ou das migrações
085/094/112/113 foi alterado** — e a linha 68 do webhook continua intocada, como combinado:
só o meu chamador passou a respeitar a régua que já existia.

Três testes novos na suíte da origem: (24) `@lid` sem mapa não gruda a origem de um contato
real no lead fantasma — o cenário é o `+53751599612092` medido em produção; (25) o sufixo
`:12` vincula o **mesmo** contato em vez de inventar outro; (26) grupo nunca vincula.
Suíte na VPS: 68 puros + **26** origem + 13 isolamento + 6 ingestão = **113, zero falhas**.

*Por que não esperou o raio-X:* o conserto é de um chamador só, dentro do meu arquivo, e
**não antecipa** a normalização da porta de entrada — quando a linha 68 passar a normalizar, o
caminho aqui não muda, porque ele deriva do `rawBody` e não do `externalId`. Fechar agora tira
uma dependência do caminho daquela frente em vez de criar uma.

**Dimensão real do problema (22/09/2026, medida pela sessão de WhatsApp).** O número que
circulava — "38 NOT_LEAD com fato da Extranet" — estava **inflado**: contava linhas de
`extranet_lead`, e um lead tem várias. Uma linha por lead dá **28**. Desses, 15 têm fato de
verdade (aula agendada/realizada ou "Ganhou"); tirando 3 internos e 7 com desfecho posto por
gente, sobram **7 leads realmente errados hoje** — entre eles uma "Ganhou" e uma com aula
realizada em 27/08.

É bem menor do que parecia, e a manchete honesta é essa. **Não diminui o caso:** 6 dos 7 estão
com `review_result='confirmed_not_lead'` e ninguém consegue dizer se foi a recepção clicando
ou a máquina — que é exatamente o buraco de autoria descrito acima. Por isso a recomendação da
sessão da Extranet (virar PENDÊNCIA para humano em vez de ressuscitar sozinho) é a certa
enquanto o dado não existir.

*Terceiro caso no mesmo dia de número certo com significado errado* — depois da contagem de
`@lid` e da leitura de `review_by`. Os três vieram de medir sem checar a granularidade ou a
origem da coluna.

### Item 3 executado — `by_name` na família confirma/descarta (22/09/2026, frente do Scheduler)
O "conserto estrutural" da convergência acima: o dashboard agora manda `by_name` (nome do
usuário logado) em TODAS as escritas com autoria, e este repo passou a lê-lo nas rotas de
confirmar/descartar — `/leads/:id/review`, `/requalificar`, `/unclassified/:id/{promote,
ignore,marcar-interno}` (tenant.js, helper `_autorHumano`) e `marcar-lead`/`desmarcar-lead`
(inbox.js). `review_by` e `classification_feedback.feedback_by` recebem o nome; sem o campo,
fallback no `req.tenantRole` idêntico ao de hoje (aditivo; nenhum chamador quebra).

Semântica combinada com a frente de WhatsApp (que confirmou a fronteira): **pessoa = nome
próprio; serviço sem identidade = 'SERVICE'; automação = 'ia_auto'/'extranet_auto'/NULL** —
e o dashboard garante que clique de humano logado sem nome cadastrado vira
`humano sem nome (<papel>)`, nunca 'SERVICE'. O estoque velho continua ambíguo (por isso a
pendência humana do item 2 fica como está); daqui pra frente a coluna responde "quem decidiu".
NÃO tocado: `sync-extranet-leads.js`, latch do `contractConvert`, e a autoria de mudanças de
STATUS (`mover-kanban`/`lead_eventos.autor`) — Passo 4 da frente de WhatsApp; o campo já chega
do dashboard quando ela for ligar.
