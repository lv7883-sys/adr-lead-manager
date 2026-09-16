# ADR-050 — Boas-vindas / Onboarding do cliente novo (régua pós-contratação)

- **Status:** 🟢 **DECISÕES TRAVADAS** — rev. 5 (2026-09-16). **E17-01, E17-02 e E17-03/04 implementadas** — LM na branch `feat/boas-vindas-e17-01`, dashboard na branch `feat/boas-vindas-e17-03` (nenhuma mergeada, sem deploy, nada aplicado em banco real). E17-02 validada por simulação com dados reais de Valinhos (§14) — **aguarda aprovação do dono para ativar**.
- **Fonte do conteúdo:** planilha `Plano de Boas-vindas.xlsx` (OneDrive Gerencial/Recepção) — aba 1 (7 toques) e aba 2 (Guia do Aluno).
- **Relacionados:** ADR-049 (renovação — o **espelho** deste), ADR-047 (NPS Pulse — **fecha** esta régua), ADR-042 (Central de Mensagens), ADR-006 (MANUAL/SEMI/AUTO), ADR-037 (cadastro mestre), ADR-025 (recursos genéricos, fronteira anti-vazamento de nicho), migr. 119 (perfil da assistente por ramo).
- **Restrições do dono:**
  1. **Não mexer no Diapasão.** Tudo é *on top*: ler tabelas de `qualidade` pode; alterar código ou schema de lá, não.
  2. **Multi-tenant e multi-ramo.** Vale para a Academia do Rock, suas franqueadas **e empresas de outros segmentos**. O motor não pode saber o que é "aula", "professor" ou "instrumento".
  3. **Tudo configurável**, inclusive o anexo de cada mensagem.

---

## 1. Contexto

Entre a contratação e o primeiro marco de satisfação ou de renovação, ninguém fala com o cliente
novo. A recepção de Valinhos já desenhou, no papel, 7 toques que cobrem esse vazio. Este ADR
transforma a planilha em uma régua de sistema — e, por exigência do dono, **genérica**: a planilha
da Academia do Rock é o **primeiro modelo**, não o formato fixo.

**Framing:** é **ativação/onboarding**, não retenção. Retenção é o resultado. A régua termina
entregando a pesquisa de satisfação — onboarding alimenta satisfação, que alimenta retenção.

---

## 2. Onde mora: **Regente** (`adr-lead-manager`), schema `lead_manager`

Espelho do módulo de Renovação (`src/jobs/renovacao-sweep.js`). UI na aba **Boas-vindas** da Caixa
de Entrada (dashboard do Scheduler, autorização escopada D1 do ADR-042) e na tela de configuração.

| A régua precisa de | Onde já está |
|---|---|
| Início do contrato, serviço, profissional | `service_account` (`ini_vigencia`, `servico_label`, `professor_nome` — migr. 060/105) |
| Titular, responsável e telefone | `account_member` (pagador → beneficiário) + `contact_point` |
| Mensagem aparecer **na conversa** | inbox do Regente (rascunho, migr. 097) |
| Enviar texto, imagem, vídeo, documento e áudio | `evolution.sendMedia` / `sendWhatsAppAudio`; fluxo "anexar arquivo" em `inbox.js:1475` |
| Guardar arquivos | `MEDIA_ROOT` (`src/media.js`) |
| Horário de atendimento | `tenants.horario_comercial` + `src/horario.js` (migr. 049) |
| Ramo da empresa | `automacao_config.ramo_atividade` (migr. 119) |
| Guard-rails | `temaProibido.js`, opt-out LGPD (migr. 011), `withTenant`/RLS |

**Descartado — construir no Diapasão:** proibido pelo dono, e o Diapasão não tem contrato canônico
nem o canal de conversa.

---

## 3. O motor é genérico; a planilha é um modelo

A decisão estrutural da rev. 3: **as etapas são dados, não código.** O motor conhece só conceitos
que existem em qualquer negócio com contrato e atendimento.

### 3.1 Âncoras (catálogo fixo no código)

| Âncora | Significado genérico | Na Academia do Rock | Exige |
|---|---|---|---|
| `inicio_contrato` | contratação fechada | matrícula | cadastro mestre (todo tenant tem) |
| `atendimento_agendado` | próximo atendimento marcado | próxima aula | **fonte de agenda** |
| `primeiro_atendimento` | primeiro atendimento realizado | 1ª aula dada | **fonte de presença** |

Uma etapa só pode usar uma âncora cuja fonte o tenant tenha conectada. Empresa sem agenda integrada
usa apenas `inicio_contrato` — a régua funciona, só não tem lembrete de atendimento. A tela mostra
o motivo quando uma âncora está indisponível.

**Fontes de agenda/presença são adaptadores** (mesmo padrão dos adapters de cadastro e de recursos):

| Adaptador | Agenda | Presença |
|---|---|---|
| `academia-do-rock` (primeiro) | `app.agenda_snapshot` (Scheduler) | `qualidade.aula_diaria` / `presenca_aula` (Diapasão, **leitura**) |
| outros ramos | futuro (agenda do ERP, Google Calendar…) | futuro |

### 3.2 Modelos de régua

- Catálogo global `boas_vindas_modelo` + `boas_vindas_modelo_etapa` (sem tenant, somente leitura).
- **Primeiro modelo:** *Escola de música — Academia do Rock* (§4). Outros ramos ganham modelos à
  medida que chegarem clientes; o `ramo_atividade` da migr. 119 sugere o modelo inicial.
- Ao ligar o módulo, o tenant **escolhe um modelo e ele é copiado** para as etapas do tenant. Dali
  em diante a unidade edita a própria cópia; mudar o modelo não altera quem já copiou.
- Tenant sem modelo do seu ramo começa de uma régua vazia com os mínimos das travas (§5).

### 3.3 Vocabulário neutro

Variáveis do sistema, iguais para todo ramo: `{cliente}` `{responsavel}` `{empresa}` `{servico}`
`{profissional}` `{dia}` `{horario}`. Mais **variáveis livres por tenant** (chave → valor), por
exemplo `{link_ead}` na Academia do Rock. Interpolação igual a `aplicarVars()` do NPS: variável sem
valor some, nunca vaza `{profissional}` cru.

---

## 4. Modelo "Escola de música — Academia do Rock"

| # | Etapa | Âncora | Quando | Anexo (configurável) | Contrato curto |
|---|---|---|---|---|---|
| 1 | Boas-vindas | `inicio_contrato` | no dia (até D+2) | **imagem**: como navegar no link do EAD enviado na mensagem | ✅ |
| 2 | Orientações iniciais | `inicio_contrato` | D+2 | — | ✅ |
| 3 | Lembrete das 2 primeiras aulas | `atendimento_agendado` | véspera, fim do expediente (×2) | — | — |
| 4 | Como foi a 1ª aula | `primeiro_atendimento` | próximo horário de atendimento | — | ✅ |
| 5 | Guia do Aluno | `primeiro_atendimento` | +5 dias | **PDF**: Guia do Aluno (aba 2 da planilha — o guia traz as regras dentro) | ✅ |
| 6 | Projetos e eventos | `primeiro_atendimento` | +25 dias | **imagem**: projetos de banda, Rock Bands, Rock Hour e datas dos eventos | — |
| 7 | Pesquisa de satisfação | `inicio_contrato` | D+30 | — | — |

- **Etapa 7 é `entregue_por = 'externo'`**: quem envia é o NPS Pulse do Diapasão, que já tem o
  primeiro ponto em `ini_vigencia + 30d` (`startBuf = 30` em `qualidade-nps-cadencia.js`). O Regente
  mostra a etapa na linha do tempo e **não envia**. Tenant sem Diapasão transforma a etapa numa
  mensagem normal com o link da própria pesquisa no texto.
  - Ressalva: com quantidade 1 no plano trimestral, o NPS cai perto do fim, não em D+30. Resolve-se
    na tela de NPS (≥ 2 pontos), sem código.
- **Contrato curto** (vigência ≤ 45 dias, o "mensal" da Academia do Rock): rodam só as etapas
  marcadas — 1, 2, 4 e 5. Confirmado pelo dono.
- **Rótulos da planilha:** as linhas 5 e 6 tinham nomes que não batiam com o texto. Decisão do dono:
  etapa 5 é o **Guia** (que contém as regras), etapa 6 é a **imagem de projetos e eventos**.
- **Duas versões de texto** (titular e responsável) quando a planilha as escreve; etapas 2 e 6 têm
  texto único, usado para os dois.

### Quem recebe

1. Pagador ≠ beneficiário → versão **responsável**, telefone do pagador.
2. Pagador = beneficiário → versão **titular**.
3. Sem telefone do pagador → telefone do beneficiário, mantendo a versão responsável se as pessoas
   forem diferentes.

É a resolução que `renovacao-sweep.js:contratosNoMarco` já faz — reusar.

---

## 5. Travas de código (a unidade não altera)

- **R1 — Primeira mensagem entre D+0 e D+2** do início do contrato.
- **R2 — Última mensagem:** `min(D+60, 50% da vigência, início da régua de renovação)`.
  O teto de 60 dias é deliberado: uma etapa em "1º atendimento + 25 dias" com o cliente começando no
  limite do alerta (21 dias) cai em **D+46**; um teto de 45 cortaria a régua da própria matriz.
  Etapa que passaria do teto **não é enviada** e fica registrada como `fora_da_janela`.
  **Contrato curto ignora o início da renovação** (ver §10.1): no mensal a renovação começa no dia da
  matrícula, e a proteção é a régua reduzida + o teto de 50%.
- **R3 — Pelo menos 48 h entre duas mensagens comuns da régua.** Etapas presas a um atendimento
  (véspera / próximo expediente) não entram na conta das 48 h, porque por desenho ficam coladas nele.
- **R4 — Mínimo de 2 e máximo de 10 etapas** ativas.
- **R5 — Só dentro do horário de atendimento do tenant** (`src/horario.js`, fuso de São Paulo
  centralizado ali). Nunca faixa fixa, nunca `getHours()` do processo. Fora do expediente, escorrega
  para a próxima faixa aberta; nunca antecipa.
  - "Véspera" = última faixa aberta do dia anterior, com preferência pelo fim do expediente (âncora
    18:00). Evita o literal "12 h antes", que para uma aula às 15 h daria 3 h da manhã.
  - "Próximo expediente" = primeira faixa aberta após o atendimento.
- **R6 — Sem retroativo.** Cada mensagem tem prazo: **7 dias** (etapas em dias), **2 dias** ("próximo
  expediente": "como foi a primeira aula" não cabe uma semana depois) e **até a 00:00 do dia da aula**
  (véspera: depois disso "amanhã" seria mentira). Passou do prazo, não sai.
  - **Exceção (rev. 4, achada na simulação):** etapa do início do contrato que cita a aula (`{dia}`,
    `{horario}`, `{profissional}`) atrasa por falta de DADO — a agenda só mostra a semana corrente —, não
    por culpa da família. Ela vale **até o dia seguinte à 1ª aula**; enquanto a 1ª aula não acontece,
    segue valendo (dentro do teto R2). E cita sempre a **próxima** aula a partir do envio, nunca uma que
    já passou.
  - **Ativação** (`--ativar`, uma vez por unidade): o que já está devido é registrado como
    `fora_da_janela` (`anterior_a_ativacao`) sem ir para a recepção.
- **R7 — Uma mensagem por família por dia** (chave de telefone igual à `br_phone_key`). Refinada na
  rev. 4 depois da simulação:
  - irmãos na mesma etapa → **uma** mensagem, com os dois nomes ("Ana e Bruno");
  - a **véspera da aula** nunca espera e ocupa o dia da família;
  - fora ela, uma por dia — **"como foi a primeira aula" inclusive**;
  - quem vai primeiro: a que deixaria de valer antes do dia seguinte; depois, a ordem da régua;
  - vale sobre o que está **pronto agora**, não sobre a data prevista: ao ligar a régua, ou quando a
    recepção ou a agenda atrasam, mensagens de dias diferentes ficam prontas juntas e saem uma por vez.
- **R8 — Mensagem com `{dia}`, `{horario}` ou `{profissional}` não sai sem o dado.** Vira pendência
  para a recepção completar, nunca "sua aula é às [horário]".
- **R9 — Só contratação nova.** O titular não pode ter contrato anterior no tenant; quem renova
  recebe a régua de renovação.
- **R10 — Anexo e texto seguem a regra do WhatsApp** (§6.2), não a escolha de quem configura.

---

## 6. Mensagens e anexos — tudo configurável

### 6.1 O que a unidade edita em cada etapa

| Campo | Regra |
|---|---|
| Ligada / desligada | respeitando R4 |
| Nome da etapa | livre |
| Âncora | só as disponíveis para o tenant (§3.1) |
| Quando | dentro das travas R1–R3 e R5 |
| Texto — titular | obrigatório (ou anexo sem texto) |
| Texto — responsável | opcional; vazio = usa o do titular |
| **Anexo** | opcional: **imagem, vídeo, áudio ou documento** |
| Roda em contrato curto | sim / não |

E no nível do tenant: modo (§7), variáveis livres (§3.3), **dias sem 1º atendimento para gerar o
alerta** (padrão 21, faixa 7–30) e o modelo de origem.

### 6.2 Como o anexo sai (R10)

| Tipo | Formatos | Como é enviado |
|---|---|---|
| Imagem | JPG, PNG, WebP | uma mensagem, texto como legenda |
| Vídeo | MP4 | uma mensagem, texto como legenda |
| Documento | PDF (e demais) | uma mensagem, texto como legenda, nome do arquivo preservado |
| Áudio | OGG, MP3, M4A | **áudio primeiro, texto em seguida** — o WhatsApp não aceita legenda em áudio |

- Texto longo demais para legenda → arquivo e texto em duas mensagens seguidas.
- Duas mensagens seguidas contam como **um** toque para R3 e R7.
- Limites de tamanho validados no upload, com a mensagem de erro dizendo o limite do tipo.
- Envio pelo caminho que o inbox já usa (`sendMedia` / `sendWhatsAppAudio` + registro de saída), então
  a mensagem aparece na conversa com a mídia.
- **Arquivo com prazo de validade:** a imagem da etapa 6 traz datas de eventos. A tela mostra a data
  do último upload de cada anexo, para a recepção perceber quando a arte ficou velha.

### 6.3 Papel da Janis

Nenhum por padrão: os textos são promessa institucional e contêm regra de contrato — sai o texto
configurado, interpolado. Onde a etapa pede resposta aberta ("como foi a primeira aula"), a Janis
ajuda **a responder a família depois**, no fluxo normal do inbox, não a escrever o toque.

### 6.4 `temaProibido.js` **não é alterado**

A trava existe para texto que a **IA gera** (entrada e saída do `autoReply`, rascunho da Janis na
renovação). O texto de boas-vindas é outra coisa: foi **escrito e aprovado pela gestão** na tela de
configuração, e os fatos (`{dia}`, `{horario}`, `{profissional}`) vêm do sistema de registro por
interpolação. Portanto:

- O envio **não** passa pela trava — sem exceção nova, sem allowlist, sem tocar no arquivo.
- A tela de configuração roda `detectarSaida()` sobre o **template** e mostra um aviso ("este texto
  fala de reposição e contrato — confira antes de ligar o automático"), **sem bloquear**. O texto da
  própria matriz dispara esse aviso na etapa 2, e está certo que dispare.
- Resultado: zero risco de regressão no `autoReply`, que usa o mesmo módulo.

---

## 7. Modos de operação

| Modo | Comportamento | Padrão |
|---|---|---|
| `desligado` | nada roda | — |
| `avisa` | a mensagem fica pronta na conversa; a recepção confere e envia com um clique | ✅ |
| `auto` | envia sozinha, dentro de todas as travas | opt-in |

Mesmo em `auto`, etapa sem pré-requisito (R8, anexo configurado mas arquivo ausente) **vira
pendência** em vez de sair incompleta.

**Alerta de cliente que não começou:** sem `primeiro_atendimento` depois de N dias (configurável,
padrão 21), as etapas presas a essa âncora são suspensas e a recepção recebe o alerta. Só existe
para tenants com fonte de presença.

---

## 8. Dados da agenda (Academia do Rock)

Dia e horário das aulas estão em **`app.agenda_snapshot`** — a grade que o Scheduler raspa da
Extranet toda semana (`snapshot.aulasPorDia['YYYY-MM-DD']` com `aluno, hora_inicio, hora_fim,
curso, prof_tag, status, aula_id`). O filtro de "aula que realmente acontece" já existe em
`qualidade-diario-auto.js:aulasDoDia()` — reusar a regra.

**A ligação com o cadastro é por id, não por nome:**

```
app.cache_identidade_aula.id_aluno    ≡  external_ref(person,  'beneficiario', idA)
app.cache_identidade_aula.id_contrato ≡  external_ref(account, 'contrato',     idC)
app.franquia.lead_tenant_id           ≡  tenant_id do Regente   (migr. 063, nunca com fallback)
```

**Liberar (aditivo):** `GRANT SELECT` ao `lead_manager_user` em `app.agenda_snapshot`,
`app.cache_identidade_aula` e `app.franquia`. O schema `app` não tem RLS e é escopado por
`franquia_id` — a resolução tenant → franquia fica no adaptador e, sem tenant explícito, **não lê
nada e avisa**. A leitura de `qualidade.*` já tem GRANT (migr. 016 do Scheduler) e **precisa rodar
dentro do `withTenant`**, senão volta zero linha em silêncio.

---

## 9. Envio

Fase 1: o caminho da renovação (`outbound.credsForTenant` + Evolution + cap diário + intervalo entre
envios), com mídia pelo fluxo do inbox. Volume = contratações por dia, não a base inteira.

Fase 2: migrar para o gargalo único de envio quando existir (E15-A). Este módulo **não cria um
quarto throttle**.

Guard-rails do `auto`, todos já em código: horário de atendimento (R5), sem domingo/feriado, cap
diário, intervalo entre envios, `temaProibido` na saída, opt-out LGPD, instância WhatsApp `open`
(senão adia **sem marcar**).

---

## 10. Modelo de dados — **implementado na E17-01** (migrations 120–125 + 1 arquivo de grants)

| Arquivo | O que faz |
|---|---|
| `120_boas_vindas_config.sql` | `automacao_config` + `boas_vindas_modo` (padrão `desligado`), `boas_vindas_alerta_dias` (21, CHECK 7–30), `boas_vindas_variaveis` (jsonb objeto), `boas_vindas_modelo` (slug de origem) |
| `121_boas_vindas_modelo.sql` | catálogo global `boas_vindas_modelo` (PK = `slug`) + `boas_vindas_modelo_etapa`. Sem tenant e sem RLS; dono = quem aplica, app só tem `SELECT` |
| `122_boas_vindas_anexo.sql` | arquivos por tenant (RLS). `UNIQUE (tenant_id, id)` para as FKs compostas |
| `123_boas_vindas_etapa.sql` | régua do tenant (RLS) + função `boas_vindas_copiar_modelo(tenant, slug, por)` |
| `124_boas_vindas_toque.sql` | cada mensagem de um contrato (RLS) |
| `125_boas_vindas_modelo_escola_musica.sql` | seed do modelo da §4 com os textos da planilha |
| `db/grants/boas_vindas_agenda_read.sql` | leitura de `app.agenda_snapshot`, `app.cache_identidade_aula` e **só as colunas** `id, lead_tenant_id` de `app.franquia` (§8) |

Diferenças em relação ao rascunho desta seção, decididas na implementação:

- **Grants de `app.*` saíram da sequência de migrations** e foram para `db/grants/`, onde já mora o
  `professor_notificacao_read.sql` (mesmo tipo de leitura cruzada). Por isso as migrations são 120–125;
  a **126 fica livre**. Em banco sem o schema `app` o arquivo só avisa, não quebra.
- **`app.franquia` com grant por coluna** (`id, lead_tenant_id`): a tabela guarda credenciais cifradas
  da Evolution, que este módulo não precisa ler.
- **Idempotência do toque sem a data da âncora:** `UNIQUE (tenant_id, account_id, etapa_id, repeticao)`.
  Se a 1ª aula for remarcada, a linha pendente é **atualizada**; incluir a data criaria uma segunda
  mensagem para a mesma etapa.
- **Isolamento por FK composta:** etapa → anexo e toque → etapa/anexo usam `(tenant_id, id)`. FK não
  passa pelo RLS; sem isso uma unidade poderia apontar para o arquivo de outra.
- **Histórico protegido:** etapa com toque registrado não pode ser apagada (só desligada); arquivo em uso
  não pode ser apagado.
- **Cópia do modelo:** recusa se a unidade já tem régua (nunca sobrescreve edição) e recusa tenant
  diferente do `app.current_tenant` da sessão.
- **`bloqueio`** aceita `sem_telefone | sem_horario | sem_profissional | sem_anexo | sem_horario_atendimento`,
  e o CHECK amarra `status = 'bloqueado'` ⇔ `bloqueio` preenchido.
- **CHECKs à prova de NULL:** o itest pegou duas regras que aceitavam dado inválido porque uma
  expressão com `OR` dava NULL (toque sem telefone e sem bloqueio; etapa com `quando = {}`). Corrigido com
  `IS NOT DISTINCT FROM` / `coalesce`.

Tabelas com tenant: `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy `tenant_isolation` por
`app.current_tenant`, `OWNER TO lead_manager_user` — iguais à 092. Todas aditivas e idempotentes
(aplicadas duas vezes no teste). O modo padrão é `desligado`: **nenhuma unidade muda de comportamento
sem configurar.**

### 10.1 Módulo de regras — `src/boasVindasRegua.js`

Puro (sem banco, sem rede, "agora" sempre por parâmetro). Não altera `src/horario.js`: reusa a
normalização dele e a mesma convenção de fuso (São Paulo = UTC-3).

| Função | Regra |
|---|---|
| `validarRegua`, `validarEtapa`, `validarVariaveisLivres`, `validarAlertaDias`, `validarAnexo` | R1, R3 (estático), R4, âncoras disponíveis, variáveis conhecidas, limites de anexo |
| `calcularMensagens` | datas de cada etapa × repetição; R2, R3 (em execução), R5, contrato curto |
| `proximaAbertura`, `momentoVespera` | R5 (horário de atendimento, feriados, véspera no fim do expediente) |
| `situacaoAgora` | R6 (7 dias de tolerância; véspera vence à 00:00 do dia do atendimento) |
| `escolherDestinatario` | titular × responsável (§4) |
| `bloqueioDaMensagem` | R8 |
| `umaPorFamilia` | R7 (irmãos na mesma etapa: agrupa; etapas diferentes: adia a menos urgente) |
| `planoDeEnvio`, `ANEXO`, `LIMITE_LEGENDA` | R10 (legenda até 1.024 caracteres; áudio antes do texto) |
| `ehContratacaoNova`, `ehContratoCurto`, `tetoDaRegua`, `precisaAlertaSemInicio` | R9, contrato curto, R2, alerta |

**Ajuste de regra descoberto na implementação (R2 × contrato curto):** num contrato de 30 dias, a régua
de renovação já começa no dia da matrícula (marco D-30). Aplicar "antes da renovação" ao contrato curto
zeraria o boas-vindas do mensal, contrariando a decisão 4. Por isso **o contrato curto ignora o início da
renovação** e fica protegido pela régua reduzida (etapas 1, 2, 4 e 5) somada ao teto de 50% da vigência.

### 10.2 Testes

| Arquivo | Onde roda | Resultado em 2026-09-16 |
|---|---|---|
| `test/boas-vindas-regua.test.js` (26 testes) | `node --test`, sem banco | ✅ 26/26 |
| `test/boas-vindas-migrations.itest.js` (14 testes) | `test/run-boas-vindas-itest.sh` (Docker, PG 16) | ✅ 14/14 num Postgres 18 local descartável (Docker indisponível na máquina de desenvolvimento). **Rodar o `.sh` no host antes do merge.** |

O teste unitário lê a própria migration 125 e valida o modelo contra as regras; o itest valida a régua
**copiada do banco** contra as mesmas regras (paridade código ↔ banco).

---

## 11. Etapas de entrega (épico E17)

| Fase | Entrega | Valor sozinha? |
|---|---|---|
| **E17-01** ✅ | Migrations 120–125 + grants de agenda + `src/boasVindasRegua.js` (cálculo de datas e travas R1–R10) com testes — branch `feat/boas-vindas-e17-01` | — |
| **E17-02** ✅ | Adaptador `academia-do-rock` (agenda + presença) + job diário em modo `avisa` + simulação com dados reais (§14) | — |
| **E17-03** ✅ | Aba **Boas-vindas** na Caixa de Entrada: toque pronto na conversa, envio com um clique, com anexo (§15) | ✅ |
| **E17-04** ✅ (parte) | Tela de configuração: textos, **arquivo por mensagem**, dias, variáveis, alerta, escolha do modelo (§15). Falta: criar/apagar/reordenar etapas | ✅ |
| **E17-05** | Modo `auto`, `seed`, uma-por-família e alerta de cliente que não começou | ✅ |

---

## 12. Decisões do dono (registro)

| # | Pergunta | Decisão (2026-09-16) |
|---|---|---|
| 1 | Anexo da etapa 1 | Imagem que mostra como navegar no link do EAD. **Toda etapa pode ter anexo** (imagem, vídeo, áudio, documento). |
| 2 | Rótulos trocados | Etapa 5 = Guia do Aluno (com as regras dentro). Etapa 6 = imagem de projetos de banda, Rock Bands, Rock Hour e datas dos eventos. |
| 3 | Arte da etapa 6 | Anexada à mensagem, mesmo modelo da etapa 1. |
| 4 | Contrato mensal | Régua reduzida (etapas 1, 2, 4 e 5). De acordo. |
| 5 | Alerta sem 1ª aula | 21 dias, **configurável**. E o módulo inteiro precisa servir a outros ramos. |
| — | Horário de envio | Horário de atendimento configurado do tenant. |
| — | Dia/horário da aula | Vêm da agenda dos professores (`app.agenda_snapshot`). |
| — | Fim do ciclo | NPS Pulse, sem mexer no Diapasão. |

---

## 13. Coordenação e proteção do que já existe

**Estado em 2026-09-16:** E17-01 a E17-03/04 commitadas **só nas branches** `feat/boas-vindas-e17-01` (LM) e `feat/boas-vindas-e17-03` (dashboard). Nada no `main`, nada aplicado em banco real, nenhum deploy.

### 13.1 Chats consultados

| Chat | Área | Sobreposição |
|---|---|---|
| Conciliações e gestão de extratos ADR-BI | `compasso.*`, `lib/compasso*`, certificado, NFS-e; talvez `bi_raw.conta_bancaria` | **Nenhuma.** Não toca `app.agenda_snapshot`, `app.cache_identidade_aula`, `app.franquia`, `tenant-franquia.js`, `routes/leads.js` nem config-leads. Sem deploy do dashboard previsto. |
| Proposta de API para integração Regente | API Extranet / rede de franquias (só documentos, sem código) | **Nenhuma hoje.** Não usa migrations do LM e não toca `automacao_config`, `service_account`, `external_ref` nem o modelo tenant/franquia. Três impactos **futuros** incorporados em 13.3 (regras 10–12). "Onboarding" lá = implantação da unidade; no código deles vira `implantacao`. |
| Proposta de API para integração Regente — **ADR-051** (núcleo canônico, grupos de dados sob demanda; proposto) | Migrations LM **127–139**; `plataforma.assinatura` + `pode_rodar(unidade, job)` | **Compatível.** Portão e manifesto registrados na regra 11 (13.3). A 126 não foi usada por este módulo e fica livre. |

### 13.2 Reservas e numeração

- **Migrations 120–125 do `adr-lead-manager`: usadas por este módulo; a 126 foi liberada.** Conferir o
  `origin/main` imediatamente antes de criar os arquivos — o LM e o Scheduler usam **duas sequências
  independentes no mesmo banco**, e o Scheduler já precisou renumerar migrations por colisão
  (108→110, 111→112).
- Os `GRANT` sobre `app.*` ficam em `db/grants/boas_vindas_agenda_read.sql` do LM (é o usuário do LM
  que precisa ler), fora de qualquer fila de numeração.

### 13.3 Regras de não regressão

1. **`automacao_config`.** As colunas `boas_vindas_*` são gravadas por **endpoint próprio**, com
   `UPDATE` apenas delas. Nunca entram no upsert do `PUT /automacao` (`tenant.js:2386`). Esse upsert
   lista as colunas explicitamente, por isso não apaga colunas novas — conferido; e é o mesmo
   endpoint onde houve o bug de apagar nome/contexto, então não deve ganhar mais responsabilidade.
2. **`temaProibido.js`: intocado** (§6.4).
3. **Caixa de Entrada.** *(Como ficou na E17-03.)* A aba **não** entra no `Set VIEWS` do `inbox.js`:
   tem consulta própria (`GET /boas-vindas/fila`), e a consulta pesada da lista (incidente de
   performance de agosto) não mudou. As mensagens de boas-vindas não aparecem em Todas/Leads/Outras/
   Renovações. Os links da aba usam `bv=`/`conversa=` para não cair no `?c=` da navegação sem
   recarregar. Testes das abas atuais seguem verdes (dashboard: 584/587, as 3 falhas são de
   certificado/Compasso e já existiam no `main`).
4. **Renovação: intocada.** O módulo só **lê** o primeiro marco da renovação para o teto R2.
5. **Diapasão: intocado.** O NPS só depende de configuração na tela dele.
6. **Deploy neutro.** O modo padrão é `desligado`: subir o código não muda o comportamento de
   nenhum tenant.
7. **Testes.** Itest próprio em PG descartável, no padrão de `run-renovacao-itest.sh`. Antes do merge
   rodar também `renovacao-sweep.itest` e `autoreply.itest`, que compartilham `automacao_config`,
   `service_account` e o caminho de envio.
8. **Dashboard.** Push no `main` do Scheduler só depois de avisar o chat do Compasso/BI (o deploy
   publica o `origin/main` inteiro) e rebasear sobre o `origin/main` do momento.
9. **Nome.** No código, "boas-vindas" (`boas_vindas_*`), nunca "onboarding" — a proposta de API usa
   "onboarding" para a entrada de **unidades** na rede.
10. **A fonte da agenda vai mudar — isolar a leitura.** Hoje `app.agenda_snapshot` e
    `app.cache_identidade_aula` vêm de raspagem. Com a API da Extranet, a fonte passa a ser
    `/v1/aulas` (com `aluno_id`, `contrato_id`, `grade_id` estável e `reposicao_de_aula_id`). Toda
    leitura de agenda e presença fica **atrás de uma única interface do adaptador**
    (`proximosAtendimentos(conta)`, `primeiroAtendimento(conta)`). O job e o cálculo de datas nunca
    leem tabela de agenda diretamente — trocar a fonte é trocar o adaptador.
11. **O job respeita a assinatura da unidade.** *(Atualizado pelo ADR-051.)* Os módulos serão vendidos por unidade. O
    `boas-vindas-sweep` pula o tenant sem módulo ativo, pelo mesmo `gating.js`/`tenant_subscriptions`
    que já controla o `LEAD_MANAGER` — além de pular quem está em modo `desligado`. A chave nasce
    parametrizada: `LEAD_MANAGER` enquanto o módulo fizer parte do Regente base, `BOAS_VINDAS` se for
    vendido à parte (decisão comercial, não bloqueia a E17-01).
    **Alvo (ADR-051):** a fonte única vira `plataforma.assinatura`, com o código de aplicação
    `boas_vindas`, e o job pergunta `pode_rodar(unidade, 'boas_vindas')`. Enquanto a função não existir,
    fica o `gating.js` parametrizado; quando existir, troca-se uma chamada. A CHECK de
    `tenant_subscriptions` **não** é estendida por este módulo sem alinhar com o ADR-051.
    **Manifesto do boas-vindas:** `pessoas`; `contratos` (histórico P90D); `agenda` com histórico
    **P60D**, que inclui a presença. Os 60 dias são o teto da régua (R2): encurtar a janela da agenda
    faz as etapas presas ao 1º atendimento perderem a âncora. Não usa `recursos` nem
    `recebiveis_alunos`. O horário de atendimento é config da unidade (`tenants.horario_comercial`),
    não grupo de dados.
12. **Nada fixo de unidade.** Nenhum `tenant_id` de Valinhos, nenhum `franquia_id = 1`, nenhuma
    variável de ambiente de tenant no código de produção — só nos testes. Tenant sem franquia
    resolvida não lê agenda e registra o motivo.

---

**Conteúdo (atualizado na rev. 4):** a imagem do EAD (etapa 1) **já existia dentro da planilha** e foi extraída;
o **Guia rápido do Aluno** (etapa 5) virou uma imagem de uma tela de celular — o guia completo de 14 seções era longo demais para WhatsApp (decisão do dono). Falta só a arte da
etapa 6. Os arquivos entram pela tela de configuração (E17-04).

---

## 14. E17-02 — rotina diária, adaptador de agenda e simulação com dados reais

### 14.1 O que foi construído (branch `feat/boas-vindas-e17-01`)

| Arquivo | Papel |
|---|---|
| `src/boasVindas/agendaAcademiaDoRock.js` | **Adaptador único** de agenda e presença (regra 10). Lê `app.agenda_snapshot` pela franquia do tenant (sem fallback), casa aula ↔ contrato por `_id_contrato` (ou `_id_aluno`), nunca por nome; exclui experimental e banda; traduz o status da Extranet |
| `src/boasVindas/dados.js` | Consultas: contratos novos (60 dias, titular/pagador/telefone, ids externos, renovação, contato interno), config, régua, modelo, mensagens; upsert que **nunca** mexe no que a recepção já tratou |
| `src/boasVindas/planejar.js` | Planejamento **puro** da unidade — a mesma função na rotina e na simulação |
| `src/jobs/boas-vindas-sweep.js` | Rotina. `--dry` (simulação, não grava), `--ativar` (primeiro dia), `--tenant=`. Portão = `tenants_active()` + modo ≠ desligado; régua inválida não roda. **Não envia nada e não está no cron** |

Testes: 50 unitários (`boas-vindas-regua`, `boas-vindas-planejar`) + 23 de banco (`boas-vindas-migrations`,
`boas-vindas-sweep`), todos verdes num Postgres local descartável. `test/run-boas-vindas-itest.sh` (Docker, PG 16)
ainda precisa rodar no host antes do merge.

### 14.2 Fatos da fonte verificados em produção (somente leitura, 16/09)

- `app.agenda_snapshot` guarda **uma linha por semana**, desde 22/06; o Scheduler raspa só **a semana corrente**.
- 97% das aulas trazem `_id_aluno` e `_id_contrato`; `qualidade.presenca_aula` **não** tem `id_aluno`
  preenchido — por isso a presença também sai do snapshot (status "Realizada").
- Horário de atendimento de Valinhos: seg–sex 9h–21h, sáb 9h–13h. Não há tabela de feriados no banco.

### 14.3 Simulação: "e se estivesse ligado nos últimos 60 dias?"

Replay de meia em meia hora dentro do expediente, com o código real, vendo só a agenda que existia em cada
momento e supondo que a recepção envia assim que a mensagem fica pronta.

| Resultado | Valor |
|---|---|
| Matrículas novas no período (renovações excluídas: 81) | 27 |
| Aulas encontradas pela ligação por id | 26 de 27 alunos |
| Mensagens enviadas / previstas | 145 / 186 (78%) |
| Dias em que uma família recebeu duas mensagens | **0** |
| Boas-vindas enviadas | 25 de 27 (1 agrupada com irmão; 1 aluno sem aula na agenda) |
| Boas-vindas no dia da matrícula | 14; as demais esperaram a agenda (1 a 9 dias) |
| Lembretes de aula enviados | 39 de 52 |

**Ajustes feitos por causa da simulação** (já nas regras acima e nos testes):

1. O professor da aula se perdia no cálculo do lembrete (bug) — corrigido.
2. Família recebia várias mensagens atrasadas no mesmo dia — R7 passou a valer sobre o que está pronto agora.
3. Boas-vindas + "como foi a primeira aula" no mesmo dia (6 casos) — só a véspera fura a fila.
4. Boas-vindas perdida por esperar a agenda (3 casos) — exceção da R6.
5. Lembrete de aula no **próprio dia da matrícula** é impossível (16 de 54 casos) — "duas primeiras aulas"
   passou a contar a partir do dia seguinte à matrícula.

### 14.4 Limitações que continuam — decisão do dono

| # | Limitação | Tamanho | Opções |
|---|---|---|---|
| L1 | **Lembrete de aula de segunda-feira não sai**: a véspera cai no sábado, antes de a agenda da semana ser raspada | 7 de 52 lembretes | (a) aceitar até a API da Extranet; (b) o Scheduler raspar também a semana seguinte no sábado — toca o Scheduler e gasta requisições à Extranet |
| L2 | **"Projetos e eventos" cortado no trimestral**: 1ª aula + 25 dias passa do teto (dia 44) quando a 1ª aula demora mais de 19 dias | 8 casos, todos trimestrais | (a) aceitar; (b) aproximar a etapa (ex.: 1ª aula + 15 dias) |
| L3 | **Boas-vindas espera a agenda** quando a 1ª aula é na semana seguinte | 11 de 25 saíram com 1 a 9 dias | resolve com a API; no modo avisa a recepção pode completar dia/horário à mão (E17-03) |

### 14.5 Para ativar em Valinhos (após aprovação)

1. Aplicar migrations 120–125 e `db/grants/boas_vindas_agenda_read.sql` (aditivas).
2. Deploy do LM (a rotina não roda sozinha: não está no cron).
3. Configurar Valinhos: `boas_vindas_modo = 'avisa'`, copiar o modelo, variável `link_ead`.
4. `node src/jobs/boas-vindas-sweep.js --tenant=<valinhos> --dry` → conferir; depois `--ativar` uma vez.
5. Cron diário (e de hora em hora no expediente, para véspera e "como foi").
6. As mensagens só ficam **visíveis** para a recepção com a aba Boas-vindas (E17-03) — deploy do
   dashboard junto, avisando antes o chat do Compasso/BI (regra 8).
7. Pela tela **Configurações → Boas-vindas**, subir a imagem do EAD (etapa 1) e o Guia rápido (etapa 5).

**Janela de publicação (decisão do dono no chat do ADR-051):** toda publicação precisa ser reversível,
testada e comparada com o que roda hoje, e sai **fora do expediente da recepção e dos crons** — evitar
02h–06h30 e 8h–22h. Reverter = voltar o modo para `desligado` (código) e `git revert` do deploy; as
migrations são aditivas e ficam.

**Grupos do ADR-051:** as tabelas `boas_vindas_*` pertencem ao grupo `relacionamento`; as colunas
`boas_vindas_*` de `automacao_config` ao grupo `unidade`. Boas-vindas faz parte de **Atendimento e
Leads** (chave `LEAD_MANAGER` hoje; `pode_rodar(unidade, 'boas_vindas')` quando existir). Quando
`plataforma.catalogo_objeto` existir, as migrations 120–125 precisam das linhas de catálogo.

---

## 15. E17-03/04 — a recepção envia e cada unidade monta as suas mensagens

### 15.1 Lead Manager (branch `feat/boas-vindas-e17-01`)

| Rota (`/tenant/:id/boas-vindas/...`) | Quem | O que faz |
|---|---|---|
| `GET fila` | leitura | Mensagens prontas/bloqueadas de hoje, com conversa (por `br_phone_key`), texto já preenchido e arquivo atual da etapa |
| `GET toques/:id` | leitura | Uma mensagem |
| `POST toques/:id/enviar` `{texto, com_anexo}` | escrita | Reserva (`aprovado`), envia pelo mesmo caminho da Caixa de Entrada (mídia com legenda; áudio antes do texto — R10), grava `enviado` com o texto final e o arquivo usado; se falhar, volta com `erro` |
| `POST toques/:id/descartar` | escrita | Descarta com motivo |
| `GET/PUT config` | leitura / gestão | Modo (`desligado`/`avisa`; `auto` recusado), alerta, campos da unidade. Só `UPDATE` das colunas `boas_vindas_*` (regra 1) |
| `POST copiar-modelo` | gestão | Copia o modelo para a unidade (uma vez) |
| `PUT etapas/:id` | gestão | Nome, textos, ligada, contrato curto, dias (só etapa do tipo "dias"). Recusa só erro **novo** de régua |
| `POST/DELETE etapas/:id/anexo` | gestão | Sobe o arquivo (limites do WhatsApp por tipo, sha256, pasta de mídia do tenant) ou tira da mensagem. O arquivo antigo fica — é o histórico do que já foi enviado |

Código: `src/boasVindas/recepcao.js`, `src/boasVindas/configuracao.js`, `src/routes/boas-vindas.js`.
Testes: `test/boas-vindas-recepcao.itest.js` (11) — total de banco 34 + 50 unitários, verdes no Postgres local.

### 15.2 Dashboard (branch `feat/boas-vindas-e17-03`)

- **Caixa de Entrada → aba Boas-vindas** (com contador): lista das mensagens, cartão acima da conversa
  com texto editável, prévia do arquivo (imagem, vídeo, áudio, documento), "Enviar com o arquivo",
  Enviar e Descartar. Sem conversa ainda, o cartão ocupa o centro e o envio abre a conversa. Gerente e
  admin veem o atalho "Configurar mensagens".
- **Configurações → Boas-vindas** (gerente/admin): escolher modelo; modo; campos da unidade
  (`{link_ead}` etc.); dias do alerta; e em **cada mensagem**: nome, dias, ligada, contrato curto,
  texto do aluno e do responsável com botões dos campos, e o **arquivo** (anexar, trocar, tirar) com
  prévia, data de envio e a sugestão do modelo. Assim cada unidade faz o seu Guia rápido e a sua arte.
- O upload vai cru do navegador ao LM (mesmo padrão do `/midia` da Caixa de Entrada); a prévia usa a
  ponte `/media/:tenant/:arquivo` que já existe.
- Testes: `dashboard/test/boas-vindas-telas.test.js` (5).

### 15.3 Ainda não feito

- Criar, apagar e reordenar etapas pela tela (hoje: editar as que vieram do modelo).
- Modo `auto`, alerta "não começou" na recepção (E17-05).
- Itest Docker no host antes do merge; L1–L3 (§14.4).
