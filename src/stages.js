'use strict';
// stages.js — RÉGUA CANÔNICA de estágios do lead (Passo 1 da consolidação; molde do lifecycle.js
const stagesUi = require('./stagesUi');   // colunas como a unidade quer ver (migr 188)
// da Fatia A). FONTE ÚNICA da partição do kanban, das transições, dos desfechos de "perdido" e dos
// buckets do funil. Fecha as 3 réguas conceituais que estavam espalhadas em 7 pontos e DUPLICADAS
// à mão em 2 repos (kanbanColuna no LM / colunaDeLead no dashboard / DESTINO/ETAPAS no client JS).
//
// ------------------------------------------------------------------------------------------------
// PRECEDÊNCIA DE FONTES (por estágio):
//   FATO externo (Extranet/TrialEvent)  >  SUGESTÃO da IA (suggested_stage acima de limiar)  >  PROXY
//
//   Cada estágio-de-funil declara os três em ordem. detectSql() escolhe o PRIMEIRO não-nulo
//   (precedência COALESCE, não OR) — salvo quando o estágio declara `combina:'uniao'`, e aí soma
//   as fontes com OR.
//
//   PASSO 2 (migr 106) — LIGADO para 'experimental' e 'realizada': o FATO vem dos carimbos
//   append-only de extranet_lead (exp_agendada_em / exp_realizada_em), em UNIÃO com o proxy.
//   Une, em vez de substituir, porque o carimbo só existe para lead LINKADO ao espelho — trocar o
//   proxy faria sumir do funil quem só tem sinal da IA. Os demais estágios seguem em precedência
//   pura, com sourceOfTruth/iaSuggestion null → proxy da Fatia E, byte-a-byte.
//
//   O que o Passo 2 conserta: `status` é campo único mutável, e o move para 'convertido'
//   (tenant.js) sobrescrevia EXPERIMENTAL_AGENDADA — o lead saía de "agendadas" E de "realizadas"
//   mas continuava em "matrículas", produzindo taxa de conversão acima de 100% no BI. O carimbo é
//   imune: ninguém o reescreve.
// ------------------------------------------------------------------------------------------------
//
// DUAS PROJEÇÕES sobre a mesma régua, propositalmente distintas (não confundir):
//   • PARTIÇÃO do kanban  — stageOfLead/stageSql: cada lead cai em UMA coluna (novo…perdido).
//   • BUCKETS do funil    — funilBucketSql: predicados de PROXY que SE SOBREPÕEM (um lead conta em
//                           "agendada" por intent mesmo sem estar na coluna experimental). Por isso
//                           o funil NÃO é a partição — é a régua da Fatia E, preservada byte-a-byte.

// Desfechos que caem na coluna "perdido" (ADR-011: desfecho dirige o terminal; PERDIDO preserva o
// status, NÃO vira NOT_LEAD). Fonte única — metrics.js e tenant.js passam a reexportar daqui.
const PERDIDO_DESFECHOS = [
  'nao_matriculado_preco', 'nao_matriculado_horario', 'nao_matriculado_concorrente',
  'nao_matriculado_desistiu', 'nao_compareceu_aula', 'outro',
];

// CLIENTE (079) — desfecho do PRÉ-EXISTENTE: pagante reconhecido pelo cadastro cujo contrato é
// ANTERIOR à existência dele como lead no Regente. NÃO é conversão (não nasceu no funil) e NÃO é
// perda (não perdemos ninguém) — é um terceiro terminal, fora da fila e fora da taxa. Distinto de
// 'nao_e_lead' (spam/interno). Só a régua de ORIGEM do contractConvert grava este desfecho.
const CLIENTE_DESFECHO = 'cliente';

// Motivos de "perdido" com rótulo (viram o `desfecho`). Espelha o dashboard (MOTIVOS_PERDA);
// agora servido pela API pra o dashboard consumir em vez de manter cópia.
const MOTIVOS_PERDA = [
  ['nao_matriculado_preco', 'Preço'], ['nao_matriculado_horario', 'Horário'],
  ['nao_matriculado_concorrente', 'Concorrente'], ['nao_matriculado_desistiu', 'Desistiu'],
  ['nao_compareceu_aula', 'Não compareceu'], ['outro', 'Outro'],
];

// col(alias,name) — referência de coluna com ou sem alias de tabela. Sem alias (''/null) devolve
// a coluna crua — é o que o computeFunil usa (FROM leads, sem alias). Com alias, prefixa "l.".
const col = (a, n) => (a ? `${a}.${n}` : n);
const q = (arr) => arr.map((d) => `'${d}'`).join(', ');

// leadRef(alias,name) — como col(), MAS para referenciar o lead DE DENTRO de uma subquery
// correlacionada. Sem alias, col() devolve a coluna crua e isso é uma armadilha aqui: dentro do
// EXISTS, um `id` cru resolveria para a coluna id do PRÓPRIO espelho (o escopo interno vence),
// não para o lead de fora. Qualifica pelo nome da tabela, que é válido no `FROM leads` sem alias
// do computeFunil.
const leadRef = (a, n) => (a ? `${a}.${n}` : `leads.${n}`);

// FATO da Extranet (Passo 2, migr 106) — carimbos append-only do espelho. Lidos em vez do badge
// `situacao` de propósito: o upsert do sync faz `situacao=EXCLUDED.situacao`, então 'Exp. Realizada'
// é APAGADA quando a Extranet passa o lead para 'Ganhou'. Os carimbos são gravados no instante da
// observação e nunca limpos, então a matrícula deixa de apagar a aula.
// NÃO filtra fonte_ausente_em: o lead pode ter saído da lista, mas a aula aconteceu — o funil é
// histórico, ao contrário do sustainedStageKey (que pergunta o que a Extranet sustenta HOJE).
// Escopo por tenant vem da RLS de extranet_lead (migr 102); a query roda sob withTenant.
const _fatoExp = (a, campo) =>
  `EXISTS (SELECT 1 FROM lead_manager.extranet_lead el
            WHERE el.lead_id = ${leadRef(a, 'id')} AND el.${campo} IS NOT NULL)`;

// Situação da Extranet que prova MATRÍCULA. 'Ganhou' é terminal na Extranet (o lead ganhou, fim),
// então diferente de 'Exp. Realizada' ele não é apagado por um estado posterior — dá para ler do
// badge sem precisar de carimbo. Acento normalizado porque o rótulo é texto livre da tela.
const _situacaoNorm = (t) => `lower(translate(coalesce(${t}, ''), 'áàâãéêíóôõúüç', 'aaaaeeioooouc'))`;
const _fatoMatricula = (a) =>
  `EXISTS (SELECT 1 FROM lead_manager.extranet_lead el
            WHERE el.lead_id = ${leadRef(a, 'id')}
              AND ${_situacaoNorm('el.situacao')} IN ('ganhou', 'matricula', 'matriculado'))`;

// FATO da Extranet de QUALQUER natureza: marcou aula, fez aula, ou matriculou.
//
// PARA QUE SERVE: ser EXCEÇÃO ao descarte do classificador. O funil exclui status NOT_LEAD/
// REVIEW_QUEUE — o que é certo para quem o gate descartou de verdade, e errado para quem ele
// descartou POR ENGANO. Medido em produção (2026-08-28): dos 44 leads marcados NOT_LEAD que têm
// linha no espelho, 20 marcaram aula experimental, 8 fizeram a aula e 6 estão em 'Ganhou'. O funil
// perdia 15 leads em junho, 6 em julho e 6 em agosto — gente com matrícula comprovada, invisível
// no BI porque o classificador errou.
//
// A regra é a mesma da régua toda: FATO vence classificação. Quem marcou aula na Extranet É lead,
// independentemente do que o gate decidiu. E de quebra torna o falso-positivo do Filtro MENSURÁVEL
// — o Plantão dizia "falso-positivo não verificável com o gate ligado"; este EXISTS é a verificação.
// ---- FATO da AGENDA da Extranet (migr 129, 2026-09-18) --------------------------------------
// Uma linha por aula experimental, com o resultado em CÓDIGO e o lead ligado pelo telefone. É a
// fonte que não deduz: os carimbos do extranet_lead dependem de o sync de 3h FLAGRAR a situação na
// tela de leads, e perdiam a aula de quem matriculava logo depois (dos 15 que marcaram e
// matricularam, só 4 tinham a aula registrada). A agenda registra cada aula, com resultado.
//   200 Realizada · 210 Realizada sem matrícula · 220 Realizada com matrícula posterior · 230 Online
const AULA_REALIZADA = [200, 210, 220, 230];
const AULA_COM_MATRICULA = [220];
const _fatoAula = (a, codigos) =>
  `EXISTS (SELECT 1 FROM lead_manager.aula_experimental ae
            WHERE ae.lead_id = ${leadRef(a, 'id')}${codigos ? ` AND ae.status_cod IN (${codigos.join(', ')})` : ''})`;

const temFatoExtranetSql = (a) =>
  `(EXISTS (SELECT 1 FROM lead_manager.extranet_lead el
            WHERE el.lead_id = ${leadRef(a, 'id')}
              AND (el.exp_agendada_em IS NOT NULL
                OR el.exp_realizada_em IS NOT NULL
                OR ${_situacaoNorm('el.situacao')} IN ('ganhou', 'matricula', 'matriculado')))
    OR ${_fatoAula(a)})`;   // aula na agenda também é fato: quem marcou aula É lead (migr 129)

// ---- RENOVAÇÃO não é matrícula (regra dos 60 dias, 2026-09-18) --------------------------------
// Decisão do Leo: "renovação não conta como matrícula se ficar dentro da regra dos 60 dias". É a
// MESMA regra do BI (dashboard/lib/bi-contratos.js temSucessor, qualidade-snapshot): contrato novo
// do MESMO aluno que começa até 60 dias depois do fim do anterior = renovação; mais que isso =
// reativação (conta); sobreposição de 30 dias ou mais = curso paralelo (não é sucessor).
//
// Qual contrato julgar: o PRIMEIRO de cada aluno ligado ao telefone do lead, iniciado a partir do
// lead (menos 7 dias, a mesma folga do contractConvert). Não os seguintes: o Eduardo renovou em
// 17/06 e abriu um 2º curso em 29/07 — o 2º é paralelo, e julgá-lo diria "matrícula nova" para
// quem só renovou.
// Mesmo aluno = mesmo person_id (o cadastro já deduplica pessoa; em 2026-09-18 só 1 nome de aluno
// aparecia com dois ids). Sem o casamento por nome do BI: custava 14 s por consulta do funil.
// Qual aluno: pelo telefone (contact_point de qualquer membro da conta). Se a aula experimental com
// matrícula (220) diz QUEM matriculou, só esse aluno — senão a mãe que fez aula ela mesma viraria
// "renovação" por causa do contrato do filho.
// É renovação só se TODOS os primeiros contratos novos têm antecessor: um aluno novo na família já
// é matrícula. Sem contrato novo nenhum (ainda não entrou no cadastro), não há como julgar — conta.
// Medido em 2026-09-18: Christiane (Olivia), Eduardo Parma, Karina (Klara/Theodoro/Gustavo), Yohana
// (Carlo) e Leandro (João Lucas) — gap de 11 a 56 dias, todos alunos que já estavam na escola.
const _nomeNorm = (x) => `lower(translate(btrim(coalesce(${x}, '')), 'áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ', 'aaaaeeioooouucaaaaeeioooouuc'))`;
const _contratosNovosDoLead = (a) => `
  SELECT DISTINCT ON (ben.person_id) novo.id, novo.ini_vigencia, ben.person_id
    FROM lead_manager.contact_point cp
    JOIN lead_manager.account_member am  ON am.person_id = cp.person_id
    JOIN lead_manager.account_member ben ON ben.account_id = am.account_id AND ben.bond = 'beneficiario'
    JOIN lead_manager.person pb          ON pb.id = ben.person_id
    JOIN lead_manager.service_account novo ON novo.id = am.account_id
   WHERE cp.kind = 'phone' AND cp.tenant_id = ${leadRef(a, 'tenant_id')}
     AND cp.br_key <> ''
     AND cp.br_key = lead_manager.br_phone_key(${leadRef(a, 'phone')})   -- br_key ≡ br_phone_key(value_raw), indexado
     AND novo.ini_vigencia >= (${leadRef(a, 'created_at')} AT TIME ZONE 'America/Sao_Paulo')::date - 7
     AND (NOT ${_fatoAula(a, AULA_COM_MATRICULA)}
          OR ${_nomeNorm('pb.display_name')} IN (SELECT ${_nomeNorm('ae.aluno')} FROM lead_manager.aula_experimental ae
                                                   WHERE ae.lead_id = ${leadRef(a, 'id')} AND ae.status_cod = 220))
   ORDER BY ben.person_id, novo.ini_vigencia, novo.id`;
const _temAntecessor = (n) => `EXISTS (
  SELECT 1 FROM lead_manager.account_member b2
    JOIN lead_manager.service_account ant ON ant.id = b2.account_id
   WHERE b2.bond = 'beneficiario' AND b2.person_id = ${n}.person_id
     AND ant.id <> ${n}.id AND ant.ini_vigencia < ${n}.ini_vigencia AND ant.fim_vigencia IS NOT NULL
     AND ant.fim_vigencia - ${n}.ini_vigencia < 30
     AND ${n}.ini_vigencia - ant.fim_vigencia <= 60)`;
const renovacaoSql = (a) => `(EXISTS (SELECT 1 FROM (${_contratosNovosDoLead(a)}) n WHERE ${_temAntecessor('n')})
   AND NOT EXISTS (SELECT 1 FROM (${_contratosNovosDoLead(a)}) n WHERE NOT ${_temAntecessor('n')}))`;

// Proxy da coluna "experimental" / bucket "agendada" do funil (Fatia E, preservado). Extraído p/
// função porque "realizada" o referencia (composição, sem re-declarar a string).
//
// ⚠ SEM intent='SCHEDULE_INTEREST' desde 2026-09-18. Esse intent é a IA percebendo que a pessoa
// QUER marcar ("queria agendar uma aula"), não que marcou. Contá-lo como aula agendada inflava o
// denominador de "agendada → realizada": dos 123 leads que o funil chamava de "agendados" nos
// últimos 6 meses, 35 só tinham dito que queriam — e a taxa caía para 33%, enquanto a agenda da
// Extranet mostrava 63–78% das aulas acontecendo. O Leo olhou e disse que o número parecia irreal.
// Interesse em marcar é sinal de temperatura (metrics.js ainda usa para "quente"), não de funil.
const _experimentalProxy = (a) =>
  `${col(a, 'status')} = 'EXPERIMENTAL_AGENDADA' OR ${col(a, 'desfecho')} = 'nao_compareceu_aula'`;

// ================================================================================================
// STAGES — a régua ordenada. `column:true` = é coluna do kanban (partição). Estágios de funil
// carregam a precedência de fontes (sourceOfTruth > iaSuggestion > proxyFallback). `status` = o
// valor de leads.status que o mover-kanban seta (null quando o estágio não é destino de arraste).
// ------------------------------------------------------------------------------------------------
// ⚠ 'realizada' (ordinal 4) é estágio de FUNIL, NÃO coluna de kanban (column:false) — hoje só existe
//    como número no BI (proxy negativo). Fica na régua pra o Passo 2 promovê-lo a FATO sem re-mexer
//    na ordem; a partição do kanban o ignora.
const STAGES = [
  { ordinal: 0, key: 'novo',          status: 'NEW',                   emoji: '🆕', label: 'Novo',
    dica: 'Novos leads aparecerão aqui', auto: true, column: true },
  { ordinal: 1, key: 'qualificando',  status: 'QUALIFYING',            emoji: '🔍', label: 'Qualificando',
    dica: 'Leads em conversa ativa', column: true },
  { ordinal: 2, key: 'qualificado',   status: 'QUALIFIED',             emoji: '✅', label: 'Qualificado', column: true },
  { ordinal: 3, key: 'experimental',  status: 'EXPERIMENTAL_AGENDADA', emoji: '🎯', label: 'Experimental',
    dica: 'Aula experimental agendada', column: true,
    // bucket "agendada" do funil. Passo 2 LIGADO: FATO da Extranet unido ao proxy.
    combina: 'uniao',           // ver detectSql — decisão do Leo 2026-08-26 (cobertura)
    // FATO = carimbo da tela de leads OU aula registrada na agenda (qualquer resultado, inclusive
    // cancelada: a pessoa MARCOU). A agenda é a fonte forte; o carimbo segue na união para quem tem
    // aula anterior ao espelho da agenda (migr 129 começa em jun/2026).
    sourceOfTruth: (a) => `(${_fatoExp(a, 'exp_agendada_em')} OR ${_fatoAula(a)})`,
    iaSuggestion:  null,        // futuro: suggested_stage='experimental' acima de limiar de confiança
    proxyFallback: (a) => _experimentalProxy(a) },
  { ordinal: 4, key: 'realizada',     status: null,                    emoji: '🎯', label: 'Experimental realizada',
    column: false, funilOnly: true,
    // bucket "realizada" do funil. FATO = aula aconteceu de verdade ('Exp. Realizada' na Extranet).
    combina: 'uniao',
    // FATO = carimbo 'Exp. Realizada' OU (marcou aula E matriculou). O segundo termo existe porque o
    // carimbo só nasce se o sync de 3h FLAGRAR a situação 'Exp. Realizada' — e quem matricula logo
    // depois da aula pula direto para 'Ganhou'. Medido em 2026-09-18: dos 15 leads que marcaram aula
    // e matricularam, só 4 tinham o carimbo de realizada. Marcou + matriculou = a aula aconteceu.
    // A agenda (migr 129) é a prova direta: código 200/210/220/230. A presunção "marcou E matriculou"
    // (correção rápida de 2026-09-18) fica só para quem NÃO tem aula na agenda — quando há registro,
    // o código manda, inclusive se disser que a aula foi cancelada e a pessoa matriculou mesmo assim.
    sourceOfTruth: (a) => `(${_fatoExp(a, 'exp_realizada_em')} OR ${_fatoAula(a, AULA_REALIZADA)}
      OR (${_fatoExp(a, 'exp_agendada_em')} AND ${_fatoMatricula(a)} AND NOT ${_fatoAula(a)}))`,
    iaSuggestion:  null,
    // Proxy negativo (Fatia E): dentro de "agendada" E chegou a um desfecho que não é no-show. Ele
    // COLAPSA quando o lead converte (o move sobrescreve status e o lead sai de _experimentalProxy)
    // — é o que derrubava "realizadas" para perto de zero. Fica na união como fallback de quem não
    // tem link com a Extranet; quem tem passa a contar pelo carimbo.
    proxyFallback: (a) => `(${_experimentalProxy(a)}) AND ${col(a, 'desfecho')} IS NOT NULL AND ${col(a, 'desfecho')} <> 'nao_compareceu_aula'` },
  { ordinal: 5, key: 'convertido',    status: 'CONVERTED',             emoji: '🎓', label: 'Matriculado', column: true,
    // bucket "matrícula" do funil. FATO = 'Ganhou' na Extranet, que é onde a matrícula acontece de
    // verdade. O proxy (desfecho preenchido à mão) continua na união, mas não dá mais para depender
    // só dele: medido em produção, 86% a 90% dos leads com aula experimental estão SEM desfecho
    // preenchido (44 de 49 em 'Exp. Agendada', 18 de 21 em 'Exp. Realizada'). A recepção atende e
    // não fecha o registro — o funil estava medindo quem lembrou de preencher, não quem converteu.
    combina: 'uniao',
    // + 'Realizada com matrícula posterior' (código 220) na agenda: a própria Extranet ligando a aula
    // experimental à matrícula (migr 129).
    sourceOfTruth: (a) => `(${_fatoMatricula(a)} OR ${_fatoAula(a, AULA_COM_MATRICULA)})`,
    iaSuggestion: null,
    proxyFallback: (a) => `${col(a, 'desfecho')} = 'matriculado'`,
    // Vale sobre TODAS as fontes (Ganhou, aula 220, desfecho à mão): renovação não é matrícula.
    exclui: renovacaoSql },
  { ordinal: 6, key: 'perdido',       status: 'PERDIDO',               emoji: '❌', label: 'Perdido',
    requerMotivo: true, column: true },
  // ⚠ 'cliente' (079) NÃO é coluna do kanban nem bucket do funil: é o terminal do PRÉ-EXISTENTE
  //   (contrato anterior ao lead). Fica na régua para stageKey/stageSql o nomearem honestamente —
  //   antes ele caía em 'qualificando' por eliminação. status NOT_LEAD mantém fora de todo o BI.
  { ordinal: 7, key: 'cliente',       status: 'NOT_LEAD',              emoji: '🧾', label: 'Cliente',
    dica: 'Já era cliente antes de virar lead — fora do funil e da taxa', column: false, terminal: true },
];

const _byKey = Object.fromEntries(STAGES.map((s) => [s.key, s]));
// Colunas do kanban na ordem da régua (as 6 com column:true).
const KANBAN_STAGES = STAGES.filter((s) => s.column);
const KANBAN_KEYS = KANBAN_STAGES.map((s) => s.key);
// Etapas de trabalho = colunas do kanban menos 'novo' (intake; origem, nunca destino de arraste).
const ETAPAS_TRABALHO = KANBAN_KEYS.filter((k) => k !== 'novo');

// status ↔ key (só colunas com status; 'novo' fora do de-para de arraste, como no _KANBAN_DEST_COL).
const KEY_TO_STATUS = Object.fromEntries(
  KANBAN_STAGES.filter((s) => s.status && s.key !== 'novo').map((s) => [s.key, s.status]));
const STATUS_TO_KEY = Object.fromEntries(Object.entries(KEY_TO_STATUS).map(([k, s]) => [s, k]));

// Transições permitidas (origem → destinos). Política PERMISSIVA (recall-first): full-mesh entre as
// etapas de trabalho; 'novo' é origem de tudo mas não é destino. Derivado da régua (era hardcoded
// em metrics.js E re-copiado no client do dashboard).
const KANBAN_TRANSICOES = Object.fromEntries(
  KANBAN_KEYS.map((k) => [k, k === 'novo' ? [...ETAPAS_TRABALHO] : ETAPAS_TRABALHO.filter((x) => x !== k)]));

// ---- partição do kanban (porta EXATA de kanbanColuna/colunaDeLead) ------------------------------
// Deriva a coluna de status+desfecho. NÃO normaliza status (os valores já vêm em caixa alta do DB)
// — réplica fiel do comportamento anterior (zero mudança). stageSql() é o gêmeo em SQL (prova SQL≡JS).
function stageKey(status, desfecho) {
  if (PERDIDO_DESFECHOS.includes(desfecho)) return 'perdido';
  // 079: 'cliente' antes de 'convertido' — pré-existente NÃO conta como matrícula do funil. (Não
  // colidem: a régua de origem nunca grava 'cliente' sobre desfecho='matriculado'.)
  if (desfecho === CLIENTE_DESFECHO) return 'cliente';
  if (desfecho === 'matriculado' || status === 'CONVERTED') return 'convertido';
  if (status === 'NEW') return 'novo';
  if (status === 'EXPERIMENTAL_AGENDADA') return 'experimental';
  if (status === 'QUALIFIED') return 'qualificado';
  return 'qualificando';
}
function stageOfLead(l) { return stageKey(l && l.status, l && l.desfecho); }
function isStage(l, key) { return stageOfLead(l) === key; }

// CASE canônico: mesma partição em SQL. Ordem idêntica à de stageKey → SQL ≡ JS (o itest cobre
// todas as combinações). Útil pra qualquer agregação SQL-side; o computeKanban segue em JS.
function stageSql(alias = 'l') {
  return `CASE
    WHEN ${col(alias, 'desfecho')} IN (${q(PERDIDO_DESFECHOS)}) THEN 'perdido'
    WHEN ${col(alias, 'desfecho')} = '${CLIENTE_DESFECHO}' THEN 'cliente'
    WHEN ${col(alias, 'desfecho')} = 'matriculado' OR ${col(alias, 'status')} = 'CONVERTED' THEN 'convertido'
    WHEN ${col(alias, 'status')} = 'NEW' THEN 'novo'
    WHEN ${col(alias, 'status')} = 'EXPERIMENTAL_AGENDADA' THEN 'experimental'
    WHEN ${col(alias, 'status')} = 'QUALIFIED' THEN 'qualificado'
    ELSE 'qualificando' END`;
}

// ---- buckets do funil (FATO > IA > PROXY, ou união quando o estágio pede) -----------------------
// `combina:'uniao'` (Passo 2) = FATO ∪ IA ∪ PROXY em vez de precedência. Decisão do Leo
// (2026-08-26) para os buckets de experimental: o carimbo da Extranet só existe para lead LINKADO
// ao espelho, e substituir o proxy faria sumir do funil quem só tem sinal da IA. A união é
// monotônica — nenhum lead que conta hoje deixa de contar, e os que a conversão apagava voltam.
// Sem `combina`, o comportamento é o de sempre: PRIMEIRO não-nulo (COALESCE de fontes, não OR).
function detectSql(stage, alias = 'l') {
  if (!stage) return null;
  const fontes = [stage.sourceOfTruth, stage.iaSuggestion, stage.proxyFallback]
    .filter(Boolean).map((f) => f(alias)).filter(Boolean);
  if (!fontes.length) return null;
  const base = stage.combina === 'uniao' ? `(${fontes.map((f) => `(${f})`).join(' OR ')})` : `(${fontes[0]})`;
  // `exclui`: o que NUNCA conta no bucket, venha de qual fonte vier (ex.: renovação em 'convertido').
  return stage.exclui ? `(${base} AND NOT ${stage.exclui(alias)})` : base;
}
// Fragmento do bucket do funil por key ('experimental'=agendada, 'realizada', 'convertido'=matrícula).
// alias '' (default aqui) = colunas cruas, como no computeFunil (FROM leads sem alias).
function funilBucketSql(key, alias = '') { return detectSql(_byKey[key], alias); }

// ---- sugestão de etapa da IA (fatia (b)) --------------------------------------------------------
// Sugestão ATIVA (acionável): há suggested_stage, o lead NÃO é terminal (não descartado/terminal),
// e a sugestão não é a etapa ATUAL nem a que a recepção já dispensou. É o universo do badge do kanban
// (item 2) e do que a recepção confirma. FONTE ÚNICA — o count do /leads, a limpeza e o itest usam a
// MESMA régua. `terminalParaSugestaoSql` é a condição que faz a sugestão virar órfã (limpeza + raiz).
function terminalParaSugestaoSql(a = 'l') {
  return `(${a}.status IN ('NOT_LEAD', 'REVIEW_QUEUE') OR ${a}.desfecho IS NOT NULL)`;
}
function sugestaoAtivaSql(a = 'l') {
  return `${a}.suggested_stage IS NOT NULL
    AND NOT ${terminalParaSugestaoSql(a)}
    AND ${a}.suggested_stage <> (${stageSql(a)})
    AND (${a}.suggested_stage_dismissed IS NULL OR ${a}.suggested_stage <> ${a}.suggested_stage_dismissed)`;
}
// Gêmeo JS (itest prova SQL≡JS).
function isSugestaoAtiva(l) {
  if (!l || !l.suggested_stage) return false;
  const s = String(l.status || '').toUpperCase();
  if (['NOT_LEAD', 'REVIEW_QUEUE'].includes(s) || l.desfecho != null) return false;
  if (l.suggested_stage === stageOfLead(l)) return false;
  if (l.suggested_stage_dismissed && l.suggested_stage === l.suggested_stage_dismissed) return false;
  return true;
}

// ---- RÓTULO POR RAMO (multi-ramo, 02/11/2026) ---------------------------------------------------
//
// Dois dos seis rótulos do kanban nasceram numa escola de música: 'Experimental' (de AULA
// experimental) e 'Matriculado' 🎓. Numa clínica eles mentem na tela. Decisão do Leo em
// 02/11/2026: o kanban precisa ser adaptado para clínica médica.
//
// ⚠ O QUE **NÃO** MUDA, E É O QUE TORNA ISTO BARATO
//
// A `key` e o `status` continuam os mesmos: 'experimental' / 'EXPERIMENTAL_AGENDADA',
// 'convertido' / 'CONVERTED'. Só o TEXTO muda. Trocar a chave mexeria em dado já gravado
// (`leads.status`), nas transições e no de-para que `mover-kanban` espera — risco desproporcional
// ao ganho, e nenhum deles aparece na tela.
//
// ⚠ E O DEFAULT É O DE HOJE, BYTE POR BYTE
//
// Ramo ausente → a lista de hoje, inalterada. Isso não é conveniência: é a direção da falha.
// A Valinhos é a única unidade real, e **medido em produção em 02/11/2026 o `ramo_atividade` dela
// está VAZIO** — então ela cai no default e não vê diferença nenhuma. Se um dia alguém preencher
// o ramo dela com algo de escola, o guarda-chuva de educação abaixo a mantém no default.
// `test/demo-mf8.test.js` escreve os seis textos de hoje LITERALMENTE e falha se o default mudar.
//
// A fonte do ramo é a MESMA que já decide o texto da assistente (`automacao_config.ramo_atividade`,
// lida por `perfilAssistente.generico`) — não uma segunda régua.
const ROTULOS_POR_RAMO = Object.freeze({
  // Saúde: clínica, consultório, odontologia, fisioterapia… O equivalente da aula experimental é
  // a consulta de AVALIAÇÃO, e o equivalente de matricular é o paciente entrar em TRATAMENTO.
  saude: Object.freeze({
    experimental: { label: 'Avaliação', emoji: '🩺', dica: 'Consulta de avaliação agendada' },
    realizada: { label: 'Avaliação realizada', emoji: '🩺' },
    convertido: { label: 'Em tratamento', emoji: '🩺' },
  }),
});

// Palavras que levam ao conjunto de saúde. Texto livre digitado pela unidade, então a leitura é
// por palavra-chave — e o modo de falha de não reconhecer é "fica o default", que é seguro.
// ⚠ `consultorio` e NÃO `consultori`: 'consultori' é prefixo de "consultorIA", e "consultoria
// tributária" — o ramo da própria empresa a quem a demonstração de 04/11 é feita — passaria a ver
// "Avaliação" e "Em tratamento" no kanban. Achado testando o matcher, não imaginado.
const _PALAVRAS_SAUDE = [
  'clinic', 'clínic', 'consultorio', 'consultório', 'médic', 'medic', 'odonto', 'dentist',
  'fisioterap', 'ortoped', 'pediatr', 'dermatolog', 'psicolog', 'psiquiatr', 'nutri',
  'fonoaudio', 'veterinári', 'veterinari', 'hospital', 'laboratóri', 'laboratori',
  'reabilitaç', 'terapia', 'saúde', 'saude',
];
// GUARDA-CHUVA: o ramo descreve o que a empresa FAZ, não quem ela atende. Uma frase que nomeia
// outro ramo vence a menção a saúde, e o resultado é o default — que é sempre seguro.
//
// Isto não é zelo abstrato: "consultoria tributária para empresas médicas" é o ramo da própria
// empresa a quem a demonstração de 04/11/2026 é feita. Sem este guarda-chuva, se ela virasse
// cliente e digitasse isso, o kanban dela diria "Avaliação" e "Em tratamento" — os clientes dela
// são empresas, não pacientes. Achado testando o matcher com o texto real do público.
//
// Ensino está aqui porque é a ORIGEM desta régua e o default já é dele ("escola de música para
// terapeutas" não é clínica).
const _PALAVRAS_OUTRO_RAMO = [
  // ensino
  'escola', 'músic', 'music', 'instrument', 'curso livre', 'aula de',
  // serviços profissionais: quem presta serviço PARA a saúde não atende paciente
  'consultoria', 'assessoria', 'contabil', 'contábil', 'advocacia', 'advogad', 'jurídic', 'juridic',
  'software', 'tecnologia', 'marketing', 'publicidade', 'seguros', 'imobiliári', 'imobiliari',
];

const _semAcento = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Ramo canônico do rótulo, a partir do perfil da assistente. PURA.
 * @returns {'saude'|null}  null = use o conjunto de hoje (o default)
 */
function ramoDoRotulo(perfil) {
  const cru = perfil && perfil.ramo_atividade;
  if (!cru || !String(cru).trim()) return null;
  const t = _semAcento(cru);
  if (_PALAVRAS_OUTRO_RAMO.some((p) => t.includes(_semAcento(p)))) return null;
  if (_PALAVRAS_SAUDE.some((p) => t.includes(_semAcento(p)))) return 'saude';
  return null;
}

/** Rótulo/emoji/dica de um estágio, já resolvidos pelo ramo. PURA. */
function rotuloDoEstagio(stage, perfil) {
  const ramo = ramoDoRotulo(perfil);
  const over = (ramo && ROTULOS_POR_RAMO[ramo] && ROTULOS_POR_RAMO[ramo][stage.key]) || null;
  return {
    label: over && over.label ? over.label : stage.label,
    emoji: over && over.emoji ? over.emoji : stage.emoji,
    dica: (over && 'dica' in over ? over.dica : stage.dica) || null,
  };
}

// ---- catálogo servido ao dashboard (o dashboard CONSOME isto; não espelha) ----------------------
// Só apresentação/estrutura — sem funções (serializável em JSON). Uma fonte, servida na API.
//
// `perfil` é opcional: sem ele, o catálogo é o de hoje. `dashboard/views/stages.js` é ESPELHO DE
// CONTINGÊNCIA (usado só quando este payload falta) — quem rotula é aqui.
// Vocabulário da TELA que depende do ramo e não é nome de coluna. Serve para o consumidor parar
// de ter literais de escola de música espalhados: em 02/11/2026 o Leo marcou num print o filtro
// "Todos os instrumentos" na tela de uma clínica — medido, era UMA string visível em
// `views/recep-kanban.js:118` do outro repositório, e o resto eram nomes de variável.
//
// O campo filtrado é `lead_qualifications.instrument`: "o que a pessoa procura". Numa escola é o
// instrumento; numa clínica, a especialidade. A palavra muda; o campo não.
const ROTULOS_DE_TELA = Object.freeze({
  padrao: Object.freeze({ filtro_interesse: 'Todos os instrumentos', interesse: 'instrumento' }),
  saude: Object.freeze({ filtro_interesse: 'Todas as especialidades', interesse: 'especialidade' }),
});

function rotulosDeTela(perfil) {
  const ramo = ramoDoRotulo(perfil);
  return { ...ROTULOS_DE_TELA.padrao, ...(ramo && ROTULOS_DE_TELA[ramo] ? ROTULOS_DE_TELA[ramo] : {}) };
}

/**
 * @param {object} [perfil]    perfil da assistente (decide o conjunto de rótulos por ramo)
 * @param {object} [stageUi]   `tenant_lead_config.stage_ui` já VALIDADO (migr 188). Ausente ou
 *                             vazio = o quadro canônico, byte a byte — o caso de toda unidade
 *                             que não configurou nada.
 */
function stageCatalog(perfil, stageUi) {
  const canonicas = KANBAN_STAGES.map((s) => {
    const r = rotuloDoEstagio(s, perfil);
    return {
      key: s.key, status: s.status, emoji: r.emoji, label: r.label,
      dica: r.dica, auto: !!s.auto, requerMotivo: !!s.requerMotivo,
    };
  });
  const stages = stagesUi.aplicarConfig(canonicas, stageUi);
  return {
    stages,
    transicoes: KANBAN_TRANSICOES,
    key_to_status: KEY_TO_STATUS,
    motivos_perda: MOTIVOS_PERDA,
    // Diz ao consumidor QUAL conjunto foi aplicado — sem isso, "por que está escrito Avaliação?"
    // só se responde lendo código. null = o conjunto de hoje.
    ramo_rotulo: ramoDoRotulo(perfil),
    rotulos: rotulosDeTela(perfil),
    // As chaves das colunas que a unidade CRIOU. O consumidor precisa distinguir: card numa
    // coluna extra não mudou de etapa no funil — mudou de lugar no quadro.
    extras: stages.filter((s) => s.extra).map((s) => s.key),
  };
}

// ---- loadStages(tenantId) — ponto de migração p/ stage_definitions por-tenant (Surface A / PR #1)
// Funde as descrições em linguagem natural do tenant (tenant_lead_config.stage_definitions, usadas
// pelo detector da IA) sobre a régua default. SEM config → cai no default (nenhuma descrição), sem
// erro. É o único lugar que a personalização por-tenant entra; ninguém re-hardcoda.
async function loadStages(tenantId, deps = {}) {
  let defs = null;
  try {
    const withTenant = deps.withTenant || require('./db').withTenant;
    defs = await withTenant(tenantId, (c) => c
      .query('SELECT stage_definitions FROM tenant_lead_config WHERE tenant_id = $1', [tenantId])
      .then((r) => r.rows[0]?.stage_definitions || null));
  } catch { defs = null; } // sem config/tabela → default puro
  const d = defs && typeof defs === 'object' ? defs : {};
  return STAGES.map((s) => ({ ...s, definition: (s.key in d ? d[s.key] : null) }));
}

module.exports = {
  STAGES, KANBAN_STAGES, KANBAN_KEYS, ETAPAS_TRABALHO,
  PERDIDO_DESFECHOS, CLIENTE_DESFECHO, MOTIVOS_PERDA, AULA_REALIZADA, AULA_COM_MATRICULA, KANBAN_TRANSICOES, KEY_TO_STATUS, STATUS_TO_KEY,
  stageKey, stageOfLead, isStage, stageSql,
  detectSql, funilBucketSql, temFatoExtranetSql, renovacaoSql, stageCatalog, loadStages,
  ROTULOS_POR_RAMO, ramoDoRotulo, rotuloDoEstagio, rotulosDeTela, ROTULOS_DE_TELA,
  terminalParaSugestaoSql, sugestaoAtivaSql, isSugestaoAtiva,
};
