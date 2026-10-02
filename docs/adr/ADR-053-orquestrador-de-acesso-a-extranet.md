# ADR-053 — Orquestrador de acesso à Extranet

- **Status:** proposto (02/10/2026)
- **Decisor:** Leo. Pediu o inventário e a coordenação em 01/10/2026, com uma condição textual: *"garanta com todas as sessões que essa medida não vai quebrar nada do que temos hoje"*.
- **Escopo:** acesso de leitura à Extranet pelos dois sistemas (`adr-lead-manager` e `adr-whatsapp-scheduler`). Não trata do que a franqueadora vai expor por API — isso é de outra frente, com escopo Valinhos e somente leitura.
- **Relaciona:** ADR-051 (núcleo canônico, D12 "cada fonte declara qual pergunta responde"), ADR-025/ADR-026 (acesso à Extranet), ADR-037.

---

## 1. Por que existe

Doze rotinas automáticas de dois sistemas leem a Extranet todo dia. Cada uma foi criada por uma frente diferente, cada uma defensável sozinha. **O total nunca teve dono**, e três consequências apareceram na mesma semana:

- **A coleta de cadastro falhou em 30/09 e 01/10**, nas duas vezes perto do fim de um run de ~11h30, com "fetch failed". As rotinas curtas do mesmo dia passaram ilesas, inclusive sete minutos depois de uma das falhas. O que distingue a vítima é o tempo de exposição, não a rede.
- **`qualidade.aulas_mensal` ficou 37 dias parada** sem ninguém notar: o cron rodava, o log dizia "OK", e nada registrava quem raspava o quê.
- **A agenda consome mais que todo o resto somado** e ninguém tinha medido: 264 leituras/dia, contra ~30 de leads e experimentais.

Existe hoje uma trava compartilhada (`pg_advisory_lock` com a chave `hashtext('extranet-access')`, usada pelos dois sistemas) que impede acesso simultâneo. Ela funciona e **não é substituída por este ADR**. O que falta é o andar de cima: orçamento, medição e registro.

## 2. Inventário (02/10/2026)

**Medido** — o `lead_manager.cadastro_sync_log` grava requisições por execução:

| Rotina | Frequência | Req/dia | Duração |
|---|---|---|---|
| Cadastro de contratos e alunos | 1×/dia, 01:00 | **1.535** | ~11h30 (antes da migr 131) |
| Sincronização de leads | 5×/dia, 08–20h | ~25 | 2–5 min |
| Experimentais | 1×/dia, 07:00 | ~6 | 1–3 min |

**Derivado do código, não medido** — é a lacuna que a D1 fecha:

| Rotina | Frequência | Req/dia (estimativa) |
|---|---|---|
| Agenda — dia corrente | 15 min | ~96 |
| Agenda — semana (7 dias, 1 req por dia) | 60 min | ~168 |
| Recursos — ocupação de salas e professores (4 semanas, dia a dia) | 1×/dia | ~28 |
| Detalhe de aula (quando falta identidade) | sob demanda | dezenas |
| Status de alunos — passada completa | 1×/dia, 23:00 | não medido |
| Status de alunos — passadas intradiárias | 08h, 13h30, 18h | não medido |
| Aulas do diário (janela de 70 dias) | 1×/dia, 03:15 | não medido |
| Aulas por aluno no mês | 1×/dia, 04:10 | ~24 |
| Identidade de professor | 1×/dia, 03:40 | não medido |
| Faturamento previsto, cancelados | manual | — |

**Total estimado: ~1.900 requisições/dia**, das quais o cadastro é ~80% e a agenda ~14%.

## 3. Decisões

### D1 — Toda requisição se registra, com o nome da rotina
Uma linha por requisição no banco compartilhado: rotina, unidade, quando, prioridade, resultado. Sem isso, 9 das 12 rotinas são invisíveis e um cron pode rodar "OK" por 37 dias sem atualizar nada. O nome da rotina na linha é obrigatório — foi a ausência dele que escondeu o caso do `aulas_mensal`.

### D2 — Cota diária por rotina, que ATRASA e nunca PULA
Cada rotina declara a sua cota. Estourou, o trabalho vai para a janela seguinte **e fica registrado como pendente até ser feito**. Cortar silenciosamente é inaceitável: o detalhe da aula é a única fonte do código que marca "esta experimental virou matrícula"; pular sem registro faz o funil subcontar matrículas **sem nenhum sinal de erro**.

**Pendência que envelhece vira alerta no plantão.** Adiar um dia é rotina; cinco dias seguidos, ou atravessar a virada do mês sem ler a grade do mês seguinte, é defeito.

### D3 — Prioridade: gente na frente de automação (invariante já existente)
Clique da recepção > rotina do dia > rotina de fundo. **Isto já funciona hoje** e a regra aqui é preservá-lo, não construí-lo: a trava é tomada **por requisição**, com o intervalo de 25 s **fora** dela, então o lock fica retido ~0,5 s e o clique humano entra na fila a cada busca.

⚠ **O erro a não cometer:** construir a fila por cima da trava e deixar o intervalo *dentro* dela. Cada requisição passaria a segurar a trava por 25 s em vez de 0,5 s, e tudo serializaria 50 vezes pior — inclusive o clique que a fila deveria priorizar. É regressão que não aparece em teste e só dói em produção.

### D4 — Faixas de horário, com uma exceção de negócio
Pesado de madrugada, leve no comercial. **Exceção:** a sincronização de leads **não vai para a madrugada** — ela roda de 3 em 3 horas no comercial porque um lead cadastrado às 9h precisa aparecer no kanban no mesmo dia. Atraso de minutos nela não tem consequência (ela não dispara mensagem a cliente); atraso de um dia tem.

### D5 — Carimbo de última captura bem-sucedida, legível pelo consumidor
Por rotina e por unidade. Hoje uma tela mostra "o professor deste aluno" com toda a confiança e ninguém consegue saber que o dado é de semanas atrás. **Dado velho com cara de dado fresco é pior que dado ausente**, porque não se defende. Com o carimbo, a tela avisa ("atualizado há 3 dias") em vez de mentir com cara séria, e rotina sem captura há N dias vira alerta.

**Limite do carimbo (D12 do ADR-051):** ele diz quando a captura aconteceu, não há quanto tempo a resposta está errada.

### D6 — Trabalho parcial de coleta se guarda sempre
Coleta interrompida não pode descartar o que já leu. Dois precedentes, pelo mesmo defeito em lugares diferentes:
- o cadastro perdia 11h de trabalho por uma falha no fim — resolvido pela migração 131 (cada página gravada na hora);
- a agenda descartava a raspagem inteira quando o orçamento estourava no meio, e **professores ficaram dois dias sem diário** em 20/09 — resolvido com retomada parcial (`datasFeitas`), que **não pode ser perdida** em nenhuma reescrita.

**O dia de hoje nunca pode ser a vítima do fim do laço.**

### D7 — Rotina nova só entra registrada
Nenhuma frente cria rotina que lê a Extranet sem declarar no inventário: nome, frequência, cota, janela aceitável e o que quebra se atrasar. Mesma regra que resolveu as colisões de numeração de migração — reserva combinada só em conversa não sobrevive a duas semanas.

### D8 — Uma leitura, vários consumidores
Quando duas rotinas precisam da mesma página, elas compartilham a leitura em vez de repeti-la. O caso imediato é a agenda e Recursos (§4).

### D9 — Recarga pontual é evento, não rotina
Carga inicial e backfill têm modo próprio: pedido nominal, teto próprio e registro. Não dependem de combinar variável de ambiente por fora, e não consomem a cota da rotina diária.

### D10 — Afirmação sobre dado só entra com a consulta que a sustenta
Três afirmações desta semana precisaram de correção — o número de professores divergentes, a existência do identificador de aula e o impacto do R5 —, e nos três casos quem corrigiu foi quem foi medir. Número sem consulta é opinião com cara de fato.

## 4. Agenda: o desenho novo

**Requisito do Leo (01/10):**
1. Envio da agenda **semanal** aos professores na segunda de manhã, no horário configurado, a partir de uma leitura semanal que grava um baseline por dia.
2. Toda manhã, nova leitura do dia para conferir se o baseline mudou; muda se precisar e envia o lembrete do dia de qualquer forma.
3. Alertas de cancelamento, experimental, troca de sala e reposição: **professor avisado em até 15 min** quando for para o dia corrente; para dias futuros, o baseline daquele dia é atualizado para que o envio futuro já saia certo.

**O que a medição mudou.** A tela `/mod_agenda/list_expansivo.php?hoje=AAAA-MM-DD` devolve **a semana inteira numa requisição** (7 dias, ~180 KB), com sala, horário, aluno, curso, situação (Prevista, Realizada, Cancelada, Falta do aluno, Reposição) e **nome completo** de professor e aluno. A grade diária usada hoje devolve **um dia por requisição** e só o **primeiro nome** — que é a causa do aviso "Agenda não enviada: Prof. Luis serve para mais de um cadastro". Os identificadores de ocorrência (`aula_edit(<id>)`) estão nas duas: os 22 ids de 02/10 da grade diária aparecem entre os 219 da semana.

| Leitura | Frequência | Req/dia |
|---|---|---|
| Semana corrente (alertas + baseline + lembrete do dia) | 15 min | 96 |
| Semana seguinte | 1×/dia | 1 |
| Semanas +2 e +3 (Recursos) | 1×/dia | 2 |
| Detalhe de aula que mudou | sob demanda | poucas |
| **Total** | | **~100** (hoje: 292 com Recursos) |

Com a semana inteira numa leitura, o alerta de 15 min passa a valer **para qualquer dia da semana corrente**, não só para hoje e amanhã — melhor que o requisito.

**A confirmar na implementação, sem mudar a decisão:** se o horário de término vem na tela semanal (a diária traz), e se Recursos consegue derivar a ocupação por sala da mesma leitura.

**Dono:** a implementação é da frente de qualidade (orquestrador e envio ao professor). Este ADR entra com o teto, a prioridade e a medição.

## 5. Dependências de ordem (não quebrar)

- **Fechamento por contrato (13:00) roda DEPOIS da coleta de cadastro**, de propósito. Se a coleta atrasar para além disso, o fechamento decide com dado de ontem: não quebra (é idempotente e pega no dia seguinte), mas o funil fica um dia defasado e aparece como "a matrícula não entrou".
- **Experimentais precisa de uma rodada antes do expediente** (05:00–08:00 serve), porque o card de Início e o funil mostram as aulas do dia anterior.
- **Status de alunos alimenta o Rock Hour** (quem é o professor de cada aluno em banda). Diária basta; dias de pausa, não.

## 6. Exceções datadas

- **Até 08/11/2026 (show do Rock Hour):** se houver conflito de cota, preserva-se o cadastro de aluno e professor; a varredura semanal da agenda cede. Exceção com data de validade — exceção sem prazo vira regra permanente que ninguém revisa.

## 7. Fases

| Fase | O quê | Resultado |
|---|---|---|
| **0 — feito** | Cache da coleta de cadastro (migr 131) | 1.535 req/dia → dezenas; falha deixa de custar o dia |
| **1** | Registro por requisição com nome da rotina (D1) | as 12 rotinas passam a ser medidas; a estimativa vira número |
| **2** | Cotas em **modo observação**: registram o que teriam segurado, sem segurar nada | prova que a cota não quebra ninguém antes de ligar |
| **3** | Cotas ligadas + carimbo de última captura (D5) + alertas de pendência velha | teto real, com defesa |
| **4** | Agenda pela tela semanal (§4) e Recursos compartilhando a leitura | 292 → ~100 req/dia e a ambiguidade de nome resolvida |

Nenhuma fase liga trava sobre produção sem a anterior ter medido.

## 8. Riscos

| Risco | Tratamento |
|---|---|
| Fila global destruir a prioridade da recepção | D3: intervalo fora da trava, verificado em revisão e em teste de carga |
| Cota cortar dado que ninguém percebe faltar | D2: atrasa e registra; pendência velha alerta |
| Registro por requisição virar gargalo | linha curta, escrita assíncrona, ~2 mil/dia é volume irrelevante |
| Tela semanal mudar de forma e quebrar o parser | a grade diária continua existindo como alternativa; a troca é por rotina, não global |
| A medição revelar que o total é maior que o estimado | é o objetivo; a Fase 1 existe para isso |

## 9. O que este ADR NÃO faz

- Não mexe no que a franqueadora vai expor: escopo Valinhos e somente leitura, coordenado por outra frente.
- Não substitui a trava de acesso existente.
- Não governa rotinas que não leem a Extranet (o lembrete do diário de bordo, por exemplo, lê o banco e tem requisito próprio de 20 min).
- Não decide quanto cada rotina pode gastar: as cotas nascem da medição da Fase 1, com cada frente declarando a sua.

## 10. Requisitos declarados pelas frentes (01–02/10/2026)

| Frente | Requisito | Quebra com cota? |
|---|---|---|
| Indicadores / experimentais | uma rodada entre 05:00 e 08:00; cota pode atrasar, nunca pular o detalhe; válvula para recarga | não |
| Leads | não ir para a madrugada; atraso de minutos é indiferente | não |
| Rock Hour | frescor diário (não latência); carimbo de última captura; cadastro preservado até 08/11 | não |
| Qualidade / agenda | retomada parcial preservada; lembrete do diário fora do escopo | não |
