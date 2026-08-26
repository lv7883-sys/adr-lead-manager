'use strict';
// stages.js — RÉGUA CANÔNICA de estágios do lead (Passo 1 da consolidação; molde do lifecycle.js
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

// Proxy da coluna "experimental" / bucket "agendada" do funil (Fatia E, preservado). Extraído p/
// função porque "realizada" o referencia (composição, sem re-declarar a string).
const _experimentalProxy = (a) =>
  `${col(a, 'intent')} = 'SCHEDULE_INTEREST' OR ${col(a, 'status')} = 'EXPERIMENTAL_AGENDADA' OR ${col(a, 'desfecho')} = 'nao_compareceu_aula'`;

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
    sourceOfTruth: (a) => _fatoExp(a, 'exp_agendada_em'),
    iaSuggestion:  null,        // futuro: suggested_stage='experimental' acima de limiar de confiança
    proxyFallback: (a) => _experimentalProxy(a) },
  { ordinal: 4, key: 'realizada',     status: null,                    emoji: '🎯', label: 'Experimental realizada',
    column: false, funilOnly: true,
    // bucket "realizada" do funil. FATO = aula aconteceu de verdade ('Exp. Realizada' na Extranet).
    combina: 'uniao',
    sourceOfTruth: (a) => _fatoExp(a, 'exp_realizada_em'),
    iaSuggestion:  null,
    // Proxy negativo (Fatia E): dentro de "agendada" E chegou a um desfecho que não é no-show. Ele
    // COLAPSA quando o lead converte (o move sobrescreve status e o lead sai de _experimentalProxy)
    // — é o que derrubava "realizadas" para perto de zero. Fica na união como fallback de quem não
    // tem link com a Extranet; quem tem passa a contar pelo carimbo.
    proxyFallback: (a) => `(${_experimentalProxy(a)}) AND ${col(a, 'desfecho')} IS NOT NULL AND ${col(a, 'desfecho')} <> 'nao_compareceu_aula'` },
  { ordinal: 5, key: 'convertido',    status: 'CONVERTED',             emoji: '🎓', label: 'Matriculado', column: true,
    // bucket "matrícula" do funil.
    sourceOfTruth: null, iaSuggestion: null,
    proxyFallback: (a) => `${col(a, 'desfecho')} = 'matriculado'` },
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
  if (stage.combina === 'uniao') return `(${fontes.map((f) => `(${f})`).join(' OR ')})`;
  return `(${fontes[0]})`;
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

// ---- catálogo servido ao dashboard (o dashboard CONSOME isto; não espelha) ----------------------
// Só apresentação/estrutura — sem funções (serializável em JSON). Uma fonte, servida na API.
function stageCatalog() {
  return {
    stages: KANBAN_STAGES.map((s) => ({
      key: s.key, status: s.status, emoji: s.emoji, label: s.label,
      dica: s.dica || null, auto: !!s.auto, requerMotivo: !!s.requerMotivo,
    })),
    transicoes: KANBAN_TRANSICOES,
    key_to_status: KEY_TO_STATUS,
    motivos_perda: MOTIVOS_PERDA,
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
  PERDIDO_DESFECHOS, CLIENTE_DESFECHO, MOTIVOS_PERDA, KANBAN_TRANSICOES, KEY_TO_STATUS, STATUS_TO_KEY,
  stageKey, stageOfLead, isStage, stageSql,
  detectSql, funilBucketSql, stageCatalog, loadStages,
  terminalParaSugestaoSql, sugestaoAtivaSql, isSugestaoAtiva,
};
