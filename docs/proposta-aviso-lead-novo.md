# Proposta — aviso de lead novo para recepção e gestão (inclusive no celular)

**Pedido do Leo, 16/11/2026:** *"toda vez que um lead novo chegar o sistema gerar um aviso via
popup tanto para as recepcionistas quanto para os gestores. É importante que esse popup apareça
no celular também."*

Documento para DECISÃO. Nada foi implementado. As afirmações sobre o código estão marcadas
*(verificado em código)* com arquivo e linha; o que não deu para conferir está marcado como tal.

---

## Estado da obra (17/11/2026) — construído, NÃO publicado

Tudo abaixo está escrito e com as duas suítes verdes (**Lead Manager 88/88**, **dashboard
2202/2202**). Nada foi aplicado em banco nenhum e nenhum push foi enviado de verdade.

| Onde | O que |
|---|---|
| dashboard `db/migrations/201_push_inscricao.sql` | os aparelhos inscritos (um por APARELHO, não por pessoa) |
| dashboard `public/push-sw.js` → `/sw.js` | recebe o aviso com o Regente FECHADO; mostra a notificação, põe o número no ícone e avisa a aba aberta |
| dashboard `routes/push.js` | o manifesto (o que permite instalar no iPhone) + ativar/desativar/testar |
| dashboard `lib/push.js` | o envio para os aparelhos da unidade; 404/410 apaga a inscrição |
| dashboard `routes/api.js` | `POST /api/avisos/lead` — o que o Lead Manager chama |
| dashboard `views/recep-layout.js` | o convite "Receber aviso neste aparelho?" e o cartão na tela |
| LM `src/avisoDispositivo.js` | o disparo nos **dois tempos** |
| LM `src/semAtendimentoHumano.js` | a contagem de D1 ("ninguém olhou ainda") |
| LM `src/routes/webhook.js` | 1º tempo, na chegada da mensagem |
| LM `src/engine.js` | 2º tempo, ao lado do `notificar('novo_lead')` |
| LM `db/migrations/192_ingestao_latencia.sql` + `scripts/latencia-ingestao.js` | o cronômetro (§D2d) |

### Como pôr no ar (nesta ordem, e a ordem importa)

**1. As chaves do push.** Em um terminal seu, no dashboard:

```
node scripts/gerar-vapid.js
```

Usa só o Node, nenhuma dependência, e imprime as três variáveis. A **privada é segredo**: vai
direto para o ambiente do dashboard, sem passar por chat, log ou ticket. ⚠ **Gere uma vez e
guarde** — trocar o par depois desliga o aviso de todos os aparelhos **em silêncio**, e a única
saída é cada pessoa aceitar de novo, uma por uma.

**2. `INTERNAL_API_TOKEN` no ambiente do Lead Manager**, com o **mesmo valor** que o dashboard já
usa. É o canal interno que já existia; nenhum segredo novo. Sem ele o disparo fica inerte e
registra `aviso_dispositivo.inerte` no log — não falha calado.

**3. As duas migrações.** Como `postgres`; as duas são aditivas (criam tabela nova, não alteram
nada existente):

```
psql "$DATABASE_URL" -f db/migrations/192_ingestao_latencia.sql     # no adr-lead-manager
psql "$DATABASE_URL" -f db/migrations/201_push_inscricao.sql        # no adr-whatsapp-scheduler
```

⚠ **Depois de aplicar, atualize a coluna "Aplicada?" dos dois `RESERVAS.md` no mesmo movimento.**
É a única invariante daqueles arquivos que nenhum teste alcança, e já esteve errada seis vezes.

**4. Publicar os dois serviços — o dashboard PRIMEIRO.** Se o Lead Manager subir antes, ele dispara
aviso para um endereço que ainda não existe: ninguém recebe nada e o log enche de `http_404`.

**5. Conferir que chegou, sem esperar lead.** Abra o Regente e aceite o convite "Receber aviso de
lead novo neste aparelho?" — o próprio aceite dispara um aviso de teste. No iPhone, antes disso:
Compartilhar → Adicionar à Tela de Início.

**6. Dois ou três dias depois, ler o cronômetro:**

```
make latencia-ingestao ARGS="--dias 3"
```

É o que decide se o aviso em dois tempos (§D2c) era luxo ou necessidade. ⚠ Zero linhas **não** é
"está rápido" — é "não mediu", e o script grita isso em vez de imprimir um painel vazio.

### Três decisões que eu tomei por padrão (diga se discorda)

1. **Quem recebe:** `recepcionista`, `coordenador`, `gerente` e `admin` **da unidade** que
   inscreveram um aparelho. O `admin` de plataforma não recebe o lead de todas as unidades — só o
   da unidade em que se inscrever. (Era a pergunta §5.3.)
2. **Importação em lote da Extranet não avisa** — e isto saiu de graça: o disparo só existe no
   caminho da mensagem de WhatsApp. Carga em lote não passa por lá. (Era a §5.2/§5.4.)
3. **Avisa a qualquer hora, inclusive de madrugada e fim de semana.** Você pediu "imediatamente", e
   segurar o aviso contradiz isso. Se quiser silêncio fora do expediente, é um `if` sobre
   `src/horario.js` no disparo — meia hora, não um redesenho. (Era a §5.4.)

---

## ⚠ Quando outras empresas entrarem, isto vira custo de implantação

*(Registrado em 19/11/2026, a partir de uma pergunta do Leo: "hoje nenhuma, mas no futuro serão
muitas quando outras empresas entrarem".)*

**Hoje a equipe de Valinhos não tem nenhum iPhone**, então o passo a passo com imagens não vale a
pena agora. Mas o Regente vai para outras empresas, e aí o quadro muda de natureza — não é mais
"a recepção instala no celular dela", é **um item do roteiro de implantação de cada cliente novo**.

O que não escala sozinho, e por quê:

| | O que a pessoa faz | Dá para pré-autorizar? |
|---|---|---|
| Computador da empresa | nada, se o TI pré-autorizar o site uma vez na máquina | **sim** — configuração do Chrome, ou política se houver domínio |
| Android pessoal | 2 toques (Ativar → Permitir), uma vez | **não** — celular pessoal não aceita política da empresa |
| iPhone pessoal | 3 passos, e o do meio é abrir **pelo ícone**, não pelo Safari | **não** |

⚠ **O passo do meio do iPhone é onde a implantação vai travar.** Quem abre pelo Safari em vez do
ícone recém-criado não recebe nem a oferta de permissão — e vai relatar "não funciona", com razão,
sem nada no log para investigar. É o tipo de falha que consome atendimento e parece defeito do
produto.

**Onde isto deveria morar, e não mora ainda:** no roteiro da implantação guiada (ADR-052), como um
passo com texto pronto por plataforma. Enquanto não existir, cada implantação vai redescobrir isto.

⚠ **E a conta muda de dono:** em Valinhos o custo é de minutos, uma vez. Num produto vendido, é por
cliente, por pessoa e por aparelho, para sempre. Vale decidir cedo se o caminho padrão de um cliente
novo é o push (barato de operar, caro de ativar) ou o WhatsApp, que **não pede permissão nenhuma,
não exige instalar nada e não tem versão mínima de sistema** — e já está programado
(`src/notificacao.js`). Hoje a resposta certa pode ser "os dois, e o push é opcional".

---

## Decisões já tomadas

### D1 — O número do ícone conta "ninguém da casa olhou ainda" *(Leo, 16/11/2026)*

Entre as duas contas possíveis (§4.4d), vale a segunda: **o número só desce quando uma pessoa
responde.** A resposta automática da Janis **não** tira o lead da conta.

**Definição, em palavras:** um lead está no número enquanto **o cliente falou e nenhuma pessoa da
escola respondeu ainda**. Sai quando alguém de carne e osso responde — pelo painel do Regente ou
pelo WhatsApp da própria recepcionista —, quando a recepção dá um desfecho ao lead no kanban, ou
quando ele vira matrícula.

**Definição, para implementar:**

| | Regra | Reusa |
|---|---|---|
| Entra | lead vivo (não `CONVERTED`, não `EXPERIMENTAL_AGENDADA`, `desfecho IS NULL`) | as mesmas exclusões do `awaiting_reply` (`src/routes/tenant.js:810`) |
| Entra | o cliente mandou mensagem de verdade (reação não conta) | `naoEhReacaoSql` (`src/reacao.js`) |
| Sai | existe saída **humana** depois da fala do cliente | `FONTES_HUMANAS = {web, android, ios, desktop}` (`src/staffSamples.js:15`) **ou** `source='api' AND sender <> nome_ia` (filtro que `src/autoReply.js:213-219` já usa) |
| Sai | desfecho no kanban, ou conversão | já são exclusões existentes |

⚠️ **Por que NÃO é só trocar um parâmetro da régua da bola** (a tentação óbvia, e ela falharia em
silêncio): `bolaSql` recebe `lastOut` de fora, então parecia bastar passar "última saída humana" no
lugar de "última saída". **Não basta.** A régua consulta antes o veredito da IA
(`conversation_state`), e quando a Janis responde o motor grava `AGUARDANDO_CLIENTE` — veredito que
vence a conta independentemente do `lastOut` que eu passar *(verificado em código:
`src/bola.js:129-142`, `src/engine.js:1075`)*. O lead sumiria do número do mesmo jeito, e o defeito
seria invisível: um número plausível, só que errado.

Então **"ninguém olhou ainda" é uma pergunta diferente de "de quem é a bola"**, e ganha conta
própria com nome próprio — reusando as exclusões e a regra de reação, nunca remendando `bola.js`.
A régua da bola continua intocada e continua sendo a única resposta para "devemos resposta".

**Duas consequências boas, de graça:**

1. **A avalanche da Extranet (§3.2) não alcança o badge.** Lead importado em lote não tem mensagem
   de cliente, então nunca entra no número. (A decisão §5.2 continua valendo para o *popup*.)
2. O número vira a medida honesta do **trabalho da equipe**, não da dívida com o cliente.

**Uma consequência que precisa de cuidado — dois números parecidos na mesma tela:** a lateral do
Regente já mostra "Leads" = *devemos resposta* (conta A). O ícone passará a mostrar *ninguém olhou*
(conta B). Elas vão divergir todo dia: a Janis responde, a A zera, a B continua 3. Esta casa já
levou prejuízo com "dois números sob o mesmo rótulo" *(o comentário está em
`src/routes/tenant.js:741`)*. **Proposta:** rótulos explicitamente diferentes — o ícone e a notificação
dizem *"3 leads sem atendimento humano"*, e a lateral continua *"devemos resposta"*. Se preferir
que as duas telas passem a mostrar a conta B, é mudança maior e precisa ser dita agora.

**Porta de saída:** quem lê o lead e decide **não** responder (não era lead, é aluno, trote)
precisa dar o desfecho no kanban, senão aquele lead fica no número para sempre. A ação já existe —
é a mesma que a régua da bola usa para fechar o ciclo. Vale dizer isso à recepção no dia de ligar.

---

### D2 — O aviso e o número têm de aparecer no instante em que o lead chega *(Leo, 16/11/2026)*

Isto **mata a Opção A como entrega isolada** e tem uma consequência desconfortável que precisa
ficar escrita: boa parte da espera não está no nosso jeito de avisar — está em descobrir que aquela
mensagem é um lead.

#### (a) Consulta de tempos em tempos não serve mais — e, com o app fechado, nada resolve além do push

A Opção A perguntava ao servidor a cada 15–20 segundos. "No instante" exige o contrário: **o
servidor empurrar**. Com o Regente **aberto** numa aba há dois caminhos (o push avisando a página,
ou uma conexão aberta no estilo SSE — e já existe SSE nesta casa, em `src/routes/resources.js:89`).
Com o Regente **fechado no celular**, só existe **um**: o push. Nada roda no aparelho para
perguntar.

> Em uma linha: **"no instante" + "no celular" = Opção B obrigatória.** A Opção A vira o plano B de
> quem negar a permissão de notificação, não mais o primeiro passo.

Detalhe que economiza trabalho: o **mesmo** push serve os dois casos. O service worker recebe,
mostra a notificação (app fechado) **e** avisa a aba aberta, que mostra o toast. Um mecanismo, dois
efeitos.

#### (b) Onde a espera realmente está: o lead só existe depois que a IA classifica

A corrente de hoje, para uma mensagem de WhatsApp *(verificado em código:
`src/routes/webhook.js:735-748` e `src/engine.js:528`)*:

```
cliente manda mensagem
  → Evolution → despachante de webhooks → Lead Manager
  → grava a origem do anúncio
  → se for áudio: baixa e TRANSCREVE com a IA
  → classifica com a IA  ← a espera mora aqui
  → o lead é criado (a classificação é parâmetro da criação)
  → notificarRecepcao('novo_lead')  ← o gancho do aviso já existe
```

O lead **nasce depois** da classificação: `captureForReview` recebe o resultado `cls` como
argumento *(`src/engine.js:528`)*. Então "o instante em que o lead chega" não é o instante em que a
mensagem chega — é alguns segundos depois. Em áudio, são **duas** chamadas de IA (transcrever e
classificar).

⚠️ **E eu não sei dizer quantos segundos: ninguém mede.** Não existe nenhum registro de duração em
`src/gemini.js` nem em `src/engine.js` *(verificado: zero ocorrências de medição de tempo nos
dois)*. Qualquer promessa de "x segundos" que eu desse agora seria chute.

⚠️ **Nos dias ruins não são segundos.** Quando a IA fica indisponível, existe um amortecedor de
**15 minutos** antes de o lead cair na fila de revisão *(`src/notificacao.js`, aviso
`classificacao_indisponivel`)*. E em 2026 já houve **25 horas seguidas** com a IA muda por falta de
crédito. Nessas janelas não há aviso instantâneo nenhum — não há lead.

⚠️ **O despachante de webhooks não tem fila nem repetição.** Se ele cair no segundo em que a
mensagem chega, o aviso não atrasa: ele **não acontece**. "No instante" depende de um elo que hoje
não tem rede de proteção.

#### (c) A escolha que isso põe na sua mão

| | Avisa quando a **mensagem** chega | Avisa quando o **lead** nasce |
|---|---|---|
| Rapidez | ~1 segundo | segundos (não medidos); minutos ou nada nos dias ruins |
| Conteúdo | "Mensagem nova de um número desconhecido" | "Lead novo: Mariana — teclado" |
| Erro | às vezes avisa quem não era lead | não erra, mas chega depois |
| Depende da IA | não | sim |

**Há um meio-termo que eu recomendo, e ele não é gambiarra:** notificação tem `tag`. Um segundo
push com a mesma `tag` **substitui** o aviso que já está na tela, sem vibrar de novo. Então:

1. a mensagem chega → aviso em ~1 s: *"Contato novo — (19) 9xxxx-xxxx"*, o número do ícone sobe;
2. a IA classifica → o **mesmo** aviso vira *"Lead novo: Mariana — teclado"*, sem segundo toque;
3. se não era lead → o número do ícone desce junto com essa mesma substituição.

Ou seja: a correção pega carona num aviso que já ia aparecer — que é exatamente o que a regra da
Apple (§4.4c) exige. **Custo:** +0,5 a 1 dia sobre a Opção B, e um critério barato e sem IA para
"contato novo" (número que não é aluno, nem equipe, nem fornecedor — o portão de triagem já existe
em `lead_manager.known_contacts`, migr. 004).

#### (d) O primeiro passo, que custa quase nada — ✅ **CONSTRUÍDO em 16/11/2026, ainda não publicado**

| Arquivo | O que é |
|---|---|
| `db/migrations/192_ingestao_latencia.sql` | a tabela do cronômetro (nasceu 191; renumerada ao achar colisão com um ramo não mergeado) |
| `src/ingestaoLatencia.js` | o cronômetro e o resumo em percentis |
| `src/routes/webhook.js` | três marcas de relógio no caminho de entrada (origem / mídia+transcrição / funil) |
| `scripts/latencia-ingestao.js` | a leitura: `make latencia-ingestao ARGS="--dias 7"` |
| `test/ingestao-latencia.test.js` | 8 testes puros; a suíte inteira passou (79/79) |

**Estado honesto:** o código está escrito e testado **sem banco**. A migração **não foi executada em
lugar nenhum** — o Docker local não está no ar, então nem no banco de teste. Ela só vira número
depois de: aplicar a 192 na VPS, publicar o Lead Manager, e esperar alguns dias de movimento.

⚠️ **Enquanto a tabela estiver vazia, não confunda com "está rápido".** O script grita isso em vez
de imprimir um painel vazio — mas a confusão é tão fácil que vale repetir aqui.

#### (d.1) Por que a medição é tabela, e não linha de log

O log deste projeto é a saída do contêiner: some no deploy. Já aconteceu — dois deploys apagaram os
registros de 13/10 no meio de uma investigação. Uma medição que precisa de dias de coleta não pode
morar lá.

Antes de prometer "no instante" a quem quer que seja, **medir**: um registro de duração entre a
mensagem entrar e o lead existir. É menos de meio dia, e é o que transforma "é rápido" em um número
que a gente defende. Eu faria isso **antes** da Opção B, não depois — se a mediana for 3 segundos,
o desenho (c) é luxo; se for 40, ele é obrigatório.

#### (e) Quem dispara o push

O gancho já existe e está no lugar certo: `notificarRecepcao(tenantId, 'novo_lead', …)`
*(`src/engine.js:828` e `:1187`)*. O push entra ao lado dele. Como quem guarda os usuários é o
dashboard e quem sabe do lead é o Lead Manager, falta **uma credencial no sentido Lead Manager →
dashboard** (hoje só existe a do sentido contrário, `SERVICE_TOKEN`). É item de infraestrutura,
não de tela, e precisa entrar na conta do prazo.

---

## 1. "Popup" são coisas diferentes, e só uma resolve o celular no bolso

Esta é a parte mais importante do documento, porque a palavra esconde a decisão inteira.

**(1) Aviso dentro da página ("toast").** Um cartão que desliza no canto da tela do Regente.
Só aparece **se a pessoa está com o Regente aberto na tela**. É o mais barato de fazer e não pede
permissão de ninguém. No celular funciona igual — desde que a aba esteja aberta e visível.

**(2) Aviso do sistema operacional com a página aberta.** Aquela notificação que aparece no canto
do computador por cima de qualquer programa. Funciona com o Regente aberto numa aba, mesmo que a
aba esteja atrás de outra janela. **No celular isso praticamente não funciona:** quando a pessoa
troca de app, o navegador congela a página e o aviso não sai.

**(3) Aviso de verdade no celular ("push").** Chega com o navegador **fechado**, como chega
mensagem de WhatsApp. É o que o pedido descreve. Exige três peças que hoje não existem para a tela
da recepção: um *service worker* (um pedacinho de programa que fica instalado no aparelho e acorda
quando o servidor chama), uma assinatura por aparelho guardada no banco, e a pessoa dizendo "sim"
uma vez na permissão do navegador.

**E tem a pedra no caminho: o iPhone.** No Android, o push funciona direto pelo Chrome. No iPhone,
a Apple só entrega push para site que a pessoa tiver **adicionado à Tela de Início** — o atalho com
ícone. É um passo manual, por pessoa, por aparelho, e nenhum código resolve por ela. Hoje a tela da
recepção **não tem nem o arquivo que permite adicionar à Tela de Início** *(verificado em código:
o único manifesto e o único service worker do dashboard são do portal do professor —
`routes/qualidade-publico.js:73` e `:94`, `public/q-sw.js`, registrado em
`views/qualidade-diario-page.js:105` com escopo `/q/`)*.

**(4) Número no ícone do app ("badge"), pedido do Leo em 16/11.** O numerozinho vermelho no canto
do ícone, como o do WhatsApp. Não é um quarto caminho independente: ele **anda junto do push** e
exige as mesmas peças, mais a instalação. Tem seção própria (§4.4) porque inverte o quadro —
**no iPhone o número funciona e no Android não.**

**Quinta via, que já existe e não é popup:** mandar WhatsApp. Chega em qualquer celular, sem
instalar nada, sem permissão, sem o problema do iPhone — e o Lead Manager **já faz isso hoje**
(item 2). Não é o que foi pedido, mas hoje é o único caminho que alcança um iPhone no bolso.

---

## 2. O que já existe hoje (e por que isso muda o tamanho do trabalho)

| O que existe | Onde | O que isso nos dá |
|---|---|---|
| Aviso de lead novo por **WhatsApp** para a recepção | `src/notificacao.js` (`notificarRecepcao`, tipo `novo_lead`), ligado em `src/engine.js:828` e `:1187` | O gatilho "nasceu um lead" **já está identificado no motor**. Tem confiança mínima (padrão 0,85), anti-spam de 30 min por lead e telefones configurados por unidade (`tenants.notif_phones`). |
| **Consulta automática a cada 45 s** em toda página da recepção | `views/recep-layout.js:931` (+ re-busca ao voltar para a aba) | Já existe um "batimento" rodando em todas as telas. O toast pode pegar carona nele. |
| Contador `novos` (leads em status `NEW`) | `routes/leads.js:585` (`GET /f/:slug/contadores`) e `:568` | Já chega no navegador. **Mas não serve de gatilho** — ver 3.1. |
| Toast pronto, visualmente | `public/js/inbox-conversa.js:26` (`window.__inboxToast`) | Só vive dentro da Caixa de Entrada. Precisa subir para o layout geral. |
| Modelo genérico de preferência de notificação | `db/migration-2026-06-22-notification-preference.sql` (`app.notification_preference`: tenant, destinatário, canal, tipo) | O "quem quer receber o quê" já tem tabela. Hoje só é usada para professor/WhatsApp. |
| Layout já responsivo | `views/recep-layout.js:813` (`<meta name="viewport">`) | A tela funciona no celular. Falta o manifesto e o ícone de Tela de Início. |

**O que NÃO existe** *(verificado em código)*:

- Nenhuma biblioteca de push instalada (`web-push` não está no `package.json` de nenhum dos dois repositórios).
- Nenhum manifesto / service worker fora do `/q/` do professor.
- Nenhuma tabela de aparelhos inscritos.
- Nenhum índice por data de criação em `leads` — só `idx_leads_tenant ON leads(tenant_id)`
  (`db/migrations/001_init_lead_manager.sql:33`).

---

## 3. Quatro armadilhas que precisam entrar na decisão

### 3.1 O contador que já existe NÃO pode ser o gatilho

O número `novos` é um **estado** ("quantos leads estão parados em NEW"), não um **evento**
("chegou um lead agora"). Se o popup disparar quando esse número sobe:

- chega 1 lead e a recepcionista resolve outro entre duas leituras → o número não muda → **o aviso
  nunca aparece**, e ninguém descobre, porque não há erro nenhum;
- a pessoa aperta F5 com 5 leads parados → **5 popups**, ou nenhum, dependendo do que o navegador
  lembrava.

O gatilho certo é o lead ter **identidade e hora de nascimento**: "me dê os leads criados depois de
tal instante". É uma consulta nova e barata no Lead Manager, e o navegador guarda o que já mostrou.
É a mesma família de defeito que esta casa já catalogou mais de uma vez — estado usado como se
fosse evento, falhando em silêncio e com cara de número certo.

Detalhe de custo que ajuda a decidir: hoje, para saber `novos`, o dashboard **baixa a lista inteira
de leads** do Lead Manager a cada 45 s *(verificado em código: `routes/leads.js:561`, chamada a
`/tenant/:id/leads` com teto de 10 s)*. Acelerar esse batimento sem uma consulta enxuta seria
multiplicar a parte cara. A consulta nova nasce pequena de propósito.

### 3.2 A avalanche da Extranet

Lead não nasce só de mensagem no WhatsApp. **Há pelo menos 12 pontos no código que criam lead**
*(verificado em código: `engine.js` ×9, `routes/inbox.js` ×2, `routes/tenant.js` ×2)*, e a
sincronização com a Extranet importa em lote, com janela de 90 dias. Se o aviso for "qualquer linha
nova na tabela de leads", um dia de sincronização vira **dezenas de popups seguidos** — e no dia
seguinte ninguém olha mais para popup nenhum.

Precisa de regra de origem: avisa o que chegou por conversa/anúncio, **não** avisa importação em
lote. (Decisão sua, 5.2.)

### 3.3 Madrugada, fim de semana e a pessoa que já está atendendo

Hoje o aviso por WhatsApp tem anti-spam de 30 min por lead, mas **não tem horário**. Um popup de
sistema às 2h no celular do gerente é um custo real. O Regente já sabe o expediente da unidade
(`src/horario.js`). Dá para segurar fora do expediente e entregar um resumo na abertura — ou não
segurar nada, se a regra for "lead não espera".

E quem **já está com aquela conversa aberta** não deveria ser interrompida pelo aviso do mesmo lead.

### 3.4 Som no celular

Navegador de celular **bloqueia som** se a pessoa não tocou na tela antes. Um aviso sonoro vai
funcionar no computador e falhar calado no celular, a menos que a pessoa autorize uma vez.
*(Inferido — comportamento padrão de navegador; não medido nos aparelhos da unidade.)*

---

## 4. As três opções

### Opção A — Aviso dentro do Regente (sem push)

**O que a recepcionista vê:** com o Regente aberto (computador ou celular), chega um cartão no
canto: *"Lead novo — Mariana, veio do anúncio do Instagram"*, com botão "Abrir". O número da
lateral sobe junto. Opcional: um som curto no computador.

**O que muda por baixo:** uma consulta nova e barata no Lead Manager
(`GET /tenant/:id/leads/novos?desde=…`, devolvendo só id, nome, origem e hora); o batimento de 45 s
passa a 15–20 s; o toast sai da Caixa de Entrada e sobe para o layout de todas as telas; o navegador
guarda quais ids já mostrou. Nenhuma permissão, nenhuma instalação, nenhum banco novo.

**O que NÃO resolve:** celular no bolso com o Regente fechado. Não avisa.

**Tamanho estimado:** 1 dia. Dashboard + 1 rota no LM. Sem migração. *(Estimativa, não medição.)*

**O que não dá para desfazer:** nada. É tela; some com um deploy.

---

### Opção B — A + push de verdade (computador e Android; iPhone só se a pessoa instalar)

**O que a pessoa vê:** na primeira vez, um pedido de permissão ("Receber avisos de lead novo?").
Dizendo sim, o aviso passa a chegar **com o navegador fechado**: no Windows aparece no canto da
tela; no Android, na barra de notificações como qualquer app. No iPhone, só depois de
**Compartilhar → Adicionar à Tela de Início** — e aí funciona igual.

**O que muda por baixo:**

- service worker na raiz do dashboard, **só para push, sem cache** (de propósito: um service worker
  que guarda página velha na tela de quem salva presença e matrícula é risco que não compensa — o
  `/q/sw.js` do professor já documenta esse cuidado por extenso);
- manifesto + ícones para a área da recepção (os ícones já existem: `public/icone-192.png`, `-512`,
  maskable);
- biblioteca `web-push` + par de chaves VAPID nas variáveis de ambiente;
- **uma migração nova**: tabela de aparelhos inscritos (usuário, unidade, endereço do push, chaves,
  criado em, último sucesso) + registro de qual lead já foi avisado a quem, para não repetir;
- quem dispara: o Lead Manager avisa o dashboard quando o lead nasce (o ponto já existe —
  `engine.js:828` e `:1187`), e o dashboard entrega o push.

**O que NÃO resolve:** iPhone de quem não fizer o passo de instalar. Não tem contorno técnico.

**Tamanho estimado:** 3 a 4 dias, dois repositórios, uma migração nova em cada série (LM: faixa
191–199 livre pelo `RESERVAS.md`; dashboard: 190+, a confirmar contra o `origin/main`).
*(Estimativa, não medição.)*

**O que não dá para desfazer:** o endereço de push de cada aparelho passa a ser dado pessoal
guardado no banco (LGPD: é identificador de dispositivo). Apagar depois é fácil; ter guardado, não
se desfaz. E service worker instalado em celular é **pegajoso**: uma versão com defeito pode ficar
presa no aparelho da pessoa. Por isso o worker sem cache — ele não tem como servir nada velho.

**O número no ícone (badge) é um acréscimo desta opção, não uma opção separada** — ver §4.4.

---

### Opção C — A + B + WhatsApp para quem não instalar

Reaproveita o que já existe (`src/notificacao.js`) e liga a preferência por pessoa na tabela que já
existe (`app.notification_preference`): cada um escolhe popup, WhatsApp, os dois ou nenhum.

**Por que isto existe como opção:** é o único caminho que alcança um **iPhone no bolso sem
instalação**. O aviso por WhatsApp já está programado — mas **eu não consegui verificar se ele está
LIGADO em Valinhos** (`tenants.notif_enabled` e `notif_phones`): a porta do banco de produção está
fechada daqui. É conferível em um minuto com acesso ao banco, e precisa ser conferido antes de
qualquer promessa.

**O custo escondido:** cada aviso é uma mensagem saindo pela instância da escola — o mesmo canal que
fala com cliente. Volume de aviso interno disputa com o anti-ban. Tem teto prático.

**Tamanho estimado:** +1 a 2 dias sobre a B (tela de preferências e a regra de quem recebe o quê).

---

### 4.4 O número no ícone (badge) — pedido do Leo, 16/11/2026

> *"no ícone do regente (site no navegador) aparecer um badge com o número de leads que chegaram e,
> à medida que o lead teve a primeira resposta da recepção, ele apaga (ou diminui o valor)."*

Dá para fazer, e o número que ele mostra **já existe no sistema**. Mas três coisas precisam ficar
claras antes, porque mudam o que você está escolhendo.

#### (a) O badge não é alternativa ao push — ele fica em cima dele

Para existir um ícone a ser carimbado, o Regente tem de estar **instalado** (Tela de Início no
iPhone, "Instalar app" no Chrome/Edge do computador). Site aberto numa aba comum não tem ícone na
tela do celular — não há onde pôr o número. E para o número **mudar com o app fechado**, só existe
um caminho: a mensagem de push acordar o service worker. Ou seja: **badge = tudo da Opção B, mais a
instalação.** Não encurta nada; melhora o que a Opção B entrega.

#### (b) O quadro se inverte: o iPhone pode mostrar número, o Android não

| Aparelho | Número no ícone | Observação |
|---|---|---|
| **iPhone / iPad** (Tela de Início, iOS 16.4+) | **Sim** | Precisa também de permissão de notificação concedida |
| **Android (Chrome)** | **Não** — a API não existe no Android | O Android põe um **pontinho** no ícone do app instalado quando há notificação não lida. Bolinha, não número |
| **Windows / macOS** (Chrome ou Edge, app instalado) | **Sim** | Linux não mostra |
| **Qualquer um em aba comum do navegador** | **Não** | Sem ícone instalado, não há badge |

*(Fontes abaixo; conferido na web em 16/11/2026, não medido nos aparelhos da equipe.)*

Isto inverte o que eu te disse na §1: para **push**, o iPhone é o aparelho difícil; para o **número
no ícone**, o iPhone é o único celular que consegue. Quem usa Android ganha a bolinha "tem coisa
nova", sem quantidade.

#### (c) "Diminuir sozinho" esbarra numa regra da Apple

A Apple **não permite push invisível**: todo push que chega tem de mostrar uma notificação, senão o
Safari **cancela a permissão do site**. Consequência prática direta no seu pedido:

- **Subir o badge é fácil:** o aviso de lead novo já vai mostrar notificação de qualquer jeito — o
  número sobe junto, de graça.
- **Descer o badge em silêncio é proibido.** Mandar um push só para dizer "o lead 7 foi atendido,
  tire 1 do número" significaria **mostrar uma notificação inútil** a cada atendimento dos colegas.

O desenho honesto é: **o número sobe na hora e é recalculado (exato) quando a pessoa abre o Regente
ou quando chega o próximo aviso.** Na prática: se três leads chegam e a recepcionista atende os
três pelo computador, o ícone no celular do gerente pode continuar marcando 3 até ele abrir o
Regente — ou até o próximo lead chegar e o número ser recarimbado como 1.

Isso é limite da plataforma, não do nosso código, e não tem contorno.

#### (d) O número: ele já existe — e esconde uma decisão sua

Hoje o Lead Manager já entrega, por lead, o campo `awaiting_reply` = "a bola está conosco"
*(verificado em código: `src/routes/tenant.js:811`, calculado por `devemosRespostaSql` de
`src/bola.js`, a **régua única** criada em 22/09/2026 justamente porque existiam quatro cópias
discordando)*. O dashboard já soma isso no contador `leadsPendentes` *(`routes/leads.js:417`)*.
**O badge não precisa de conta nova** — e não pode ganhar uma, sob pena de virar a sexta cópia.

**Mas tem um porém grande, e ele é a sua decisão:** essa conta considera respondido **qualquer
saída**, inclusive a resposta automática da Janis *(verificado em código: `src/autoReply.js:294`
grava a resposta da IA em `staff_outbound_samples`, que é a fonte de "a gente respondeu" em
`src/routes/tenant.js:735`)*. Ou seja, do jeito que está:

> a Janis responde o lead em segundos → a bola passa para o cliente → **o badge zera antes de
> qualquer pessoa ter olhado.**

Você escreveu "primeira resposta **da recepção**". Então são dois números diferentes:

- **Número A — "devemos resposta"** (o que já existe): some quando qualquer um responde, Janis
  inclusive. Mede *dívida com o cliente*.
- **Número B — "ninguém da casa olhou ainda"**: só some quando um **humano** responde. Mede
  *trabalho da equipe*. É o que o seu pedido descreve.

A boa notícia: **o Número B também não precisa de régua nova.** O sistema já distingue humano de IA
em dois níveis *(verificado em código: `src/staffSamples.js:15` — `FONTES_HUMANAS = {web, android,
ios, desktop}`, que é a recepcionista digitando no WhatsApp dela; e `sender` diferente do nome da
Janis para o que sai pelo painel, filtro que `src/autoReply.js:213-219` já usa)*. É um filtro a
mais sobre a régua existente, não uma régua nova.

⚠️ **Uma fragilidade conhecida:** quando a recepcionista responde pelo WhatsApp **dela**, quem avisa
o Regente é o eco do webhook — e o despachante de webhooks não tem fila nem repetição, então um eco
perdido deixaria o badge inflado *(registrado como dívida conhecida deste sistema)*. Não quebra
nada; só faz o número ficar maior que a realidade até alguém abrir o lead.

#### (e) Tamanho

**+1 dia sobre a Opção B** (e só faz sentido com ela): chamar `setAppBadge` ao carregar/focar a
página e dentro do service worker quando o push chega, mais a consulta do Número B. A escolha entre
Número A e B é que decide se é 1 dia ou ~1,5 (o B precisa do filtro de autoria, e de teste contra
o A para provar que a diferença é a esperada).

**O que não dá para desfazer:** nada além do que a Opção B já traz. Badge se apaga com uma chamada.

---

## 5. O que eu preciso que você decida

**5.1 Até onde vai nesta rodada.**

⚠️ **Reescrito depois de D2.** "No instante em que o lead chega" tira a Opção A da mesa como
entrega isolada: consulta de tempos em tempos não é instantânea, e com o app fechado nada roda no
aparelho para perguntar. O caminho passa a ser:

| Passo | O que entrega | Estimativa |
|---|---|---|
| **0. Medir** (§D2d) | quantos segundos a IA leva entre a mensagem e o lead existir | ~0,5 dia |
| **1. Opção B** (push + instalável) | aviso no instante, com o app fechado — PC e Android; iPhone depois de instalar | 3–4 dias |
| **2. Badge** (§4.4) | o número no ícone, com a conta de D1 | +1 a 1,5 dia |
| **3. Aviso em dois tempos** (§D2c) | aviso em ~1 s que depois se corrige sozinho, sem tocar duas vezes | +0,5 a 1 dia |
| **4. Opção A** vira rede de proteção | toast para quem negar a permissão | já sai de graça no passo 1 |
| **5. Opção C** (WhatsApp) | só se sobrar iPhone sem instalação | +1 a 2 dias |

- **Minha recomendação:** passos 0 → 1 → 2, e decidir o 3 **com o número do passo 0 na mão**. Se a
  IA responde em 3 segundos, o passo 3 é luxo; se leva 40, é obrigatório. Total do caminho
  recomendado: **cerca de uma semana de trabalho**, e não há como ser honestamente menos que isso
  sem abrir mão do "no instante" ou do celular.

**5.2 O que conta como "lead novo" para avisar.** Minha sugestão: avisa lead que nasceu de conversa
ou de anúncio; **não** avisa importação em lote da Extranet nem cadastro feito à mão pela própria
recepção (ela acabou de digitar). Se discordar, é aqui.

**5.3 Quem recebe.** Hoje os papéis são `recepcionista`, `coordenador`, `gerente`, `admin`
*(verificado em código: `lib/auth.js:97-115`)*. "Gestores" = **todos** os gerentes ativos da
unidade? E o `admin` da plataforma (você) entra ou fica de fora?

**5.4 Fora do expediente.** Segurar o aviso e entregar um resumo na abertura, ou mandar sempre?

**5.5 Som.** Com som no computador (e sem som garantido no celular) ou mudo?

**5.6 Qual celular.** Para dimensionar a Opção B eu preciso saber quantas pessoas da recepção e da
gestão usam **iPhone**. Não dá para descobrir pelo código. Com o badge no pedido, isso deixou de ser
só dimensionamento: **só os iPhones mostram o número**; os Android mostram bolinha.

**5.7 Qual número o badge mostra** — ✅ **DECIDIDO em 16/11: "ninguém olhou ainda"** (ver D1 no
topo). O que segue fica só como registro do que foi comparado:

- *Número A — "devemos resposta"*: já existe pronto, mas **zera quando a Janis responde sozinha** —
  o badge pode ir a zero sem ninguém ter olhado.
- *Número B — "ninguém da casa olhou ainda"*: só desce com resposta **humana**. É o que você
  descreveu. Custa um filtro a mais sobre a régua que já existe (+~meio dia).
- **Minha recomendação:** Número B. O A mede dívida com o cliente, não trabalho da equipe — e com a
  Janis ligada ele quase não sobe.

**5.8 Você aceita o badge "atrasado para baixo"?** A Apple proíbe push invisível: o número sobe na
hora, mas só desce quando a pessoa abre o Regente ou quando chega o próximo aviso. A alternativa
seria disparar uma notificação visível a cada atendimento dos colegas — que eu não recomendo.

---

## 6. O que eu NÃO verifiquei

- Se o aviso por WhatsApp de lead novo está **ligado em produção** em Valinhos (banco inacessível daqui).
- **Quantos leads chegam por dia** — é o número que decide se o aviso ajuda ou vira ruído.
- Se alguém da equipe já usa o Regente adicionado à Tela de Início.
- O comportamento do badge **nos aparelhos da equipe** — o quadro da §4.4b veio de documentação
  (Chrome, MDN, caniuse) e de busca na web em 16/11/2026, não de teste em celular real. Antes de
  prometer o número no ícone, vale um teste de 10 minutos num iPhone e num Android da unidade.
- As estimativas de dias são julgamento meu, não medição.

**Fontes do quadro de suporte do badge (§4.4b/c):**
[Badging API — Chrome for Developers](https://developer.chrome.com/docs/capabilities/web-apis/badging-api) ·
[Display a badge on the app icon — MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Display_badge_on_app_icon) ·
[caniuse: Navigator.setAppBadge](https://caniuse.com/mdn-api_navigator_setappbadge) ·
[Badging API — W3C](https://www.w3.org/TR/badging/) ·
[Web Push on iOS and iPadOS (16.4+)](https://openpwa.net/reference/notifications/ios-safari-push/) ·
[Web Push on iOS & Safari: Requirements, Limits, Debugging](https://progressivewebapps.com/background/ios-web-push/)

---

## Resumo

**O que foi feito:** nada foi programado. Li o código dos dois sistemas e montei esta proposta.

**O que você precisa saber:** "popup" são coisas diferentes. A barata só aparece com o sistema
aberto na tela. A que aparece no celular com o navegador fechado dá mais trabalho — e **no iPhone só
funciona se a pessoa adicionar o Regente à Tela de Início com a mão**. Não há jeito técnico de
contornar isso.

**Sobre o número no ícone (seu pedido de 16/11), três coisas mudam o plano:**

- Ele **não substitui** o aviso no celular: precisa de tudo aquilo, **mais** o app instalado.
- **Só o iPhone mostra número.** O Android não tem esse recurso — mostra uma bolinha de "tem coisa
  nova", sem quantidade. É o contrário do aviso, em que o Android é o fácil.
- **O número sobe na hora, mas só desce quando a pessoa abre o Regente** (ou quando chega o próximo
  aviso). A Apple proíbe mexer no número em silêncio; descer na hora exigiria mostrar uma
  notificação a cada atendimento feito pelos colegas.

**Já decidido (16/11):**

- O número conta **"ninguém da casa olhou ainda"** — a resposta automática da Janis não faz o número
  descer. Só desce com resposta de gente, desfecho no kanban ou matrícula. Efeito colateral bom:
  lead importado em lote da Extranet nunca entra nesse número.
- **O aviso tem de ser no instante.** Isso descarta a versão barata (perguntar de tempos em tempos)
  e torna o caminho do celular **obrigatório**, não opcional.

**E aqui está a notícia desconfortável desta rodada:** a maior parte da espera **não é do jeito de
avisar — é de descobrir que aquilo é um lead.** A mensagem chega e a inteligência artificial precisa
lê-la antes de o lead existir; só então há o que avisar. Em áudio são duas leituras. **E ninguém
mede esse tempo hoje** — não existe nenhum relógio nesse trecho do sistema, então qualquer promessa
de "x segundos" que eu desse agora seria chute. Em dias de IA fora do ar, não são segundos: já houve
25 horas seguidas sem classificação nenhuma.

Por isso o primeiro passo que eu recomendo é **meia tarde colocando um relógio nesse trecho**, antes
de prometer "no instante" a alguém. Com o número na mão, dá para escolher entre avisar certo (alguns
segundos depois) ou avisar em 1 segundo "contato novo" e deixar o próprio aviso se corrigir sozinho
na tela quando a IA responder — sem tocar duas vezes no celular.

**O que você tem que decidir (a primeira é a urgente):**

1. **Até onde ir agora:** medir primeiro (meio dia) → aviso no celular (3–4 dias) → número no ícone
   (+1 dia) → aviso em dois tempos (+1 dia). **Cerca de uma semana** para o conjunto, e não há como
   ser honestamente menos sem abrir mão do "no instante" ou do celular.
2. **Os dois números na mesma tela:** a lateral vai continuar mostrando "devemos resposta" (que a
   Janis zera) enquanto o ícone mostra "ninguém olhou". Eles vão divergir todo dia. Dou nomes
   diferentes aos dois, ou mudo também a lateral para a conta nova?
3. **Quem é "gestor"** que recebe: todos os gerentes da unidade? você também?
4. **Lead importado em lote da Extranet avisa ou não?** Vale só para o aviso; no número do ícone ele
   já fica de fora por construção.
5. **De madrugada e no fim de semana:** avisa na hora ou guarda para a abertura?
6. **Quantas pessoas da equipe usam iPhone?** Isso decide quem enxerga o número e quem só enxerga a
   bolinha.
