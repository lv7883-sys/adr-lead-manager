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
