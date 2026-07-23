'use strict';
// stages.js — RÉGUA CANÔNICA de estágios do lead (Passo 1 da consolidação; molde do lifecycle.js
// da Fatia A). FONTE ÚNICA da partição do kanban, das transições, dos desfechos de "perdido" e dos
// buckets do funil. Fecha as 3 réguas conceituais que estavam espalhadas em 7 pontos e DUPLICADAS
// à mão em 2 repos (kanbanColuna no LM / colunaDeLead no dashboard / DESTINO/ETAPAS no client JS).
//
// ------------------------------------------------------------------------------------------------
// PRECEDÊNCIA DE FONTES (por estágio) — desenhada AGORA, só o PROXY ligado nesta fatia:
//   FATO externo (Extranet/TrialEvent)  >  SUGESTÃO da IA (suggested_stage acima de limiar)  >  PROXY
//
//   Cada estágio-de-funil declara os três em ordem. detectSql() escolhe o PRIMEIRO não-nulo
//   (precedência COALESCE, não OR): hoje sourceOfTruth e iaSuggestion são null → cai EXATO no
//   proxyFallback atual → ZERO mudança de comportamento. Ligar a fonte de cima (Passo 2: Extranet
//   → 'experimental'/'realizada' vira FATO) é trocar `null` por um fragmento; nada re-hardcoda.
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
    // bucket "agendada" do funil. FATO/IA desligados nesta fatia → proxy da Fatia E.
    sourceOfTruth: null,        // Passo 2: TrialEvent status ∈ {Programada, Confirmada} correlacionado
    iaSuggestion:  null,        // futuro: suggested_stage='experimental' acima de limiar de confiança
    proxyFallback: (a) => _experimentalProxy(a) },
  { ordinal: 4, key: 'realizada',     status: null,                    emoji: '🎯', label: 'Experimental realizada',
    column: false, funilOnly: true,
    // bucket "realizada" do funil. FATO = aula aconteceu de verdade (Extranet status='Realizada').
    sourceOfTruth: null,        // Passo 2: TrialEvent status = 'Realizada' correlacionado
    iaSuggestion:  null,
    // Proxy negativo atual (Fatia E): dentro de "agendada" E chegou a um desfecho que não é no-show.
    proxyFallback: (a) => `(${_experimentalProxy(a)}) AND ${col(a, 'desfecho')} IS NOT NULL AND ${col(a, 'desfecho')} <> 'nao_compareceu_aula'` },
  { ordinal: 5, key: 'convertido',    status: 'CONVERTED',             emoji: '🎓', label: 'Matriculado', column: true,
    // bucket "matrícula" do funil.
    sourceOfTruth: null, iaSuggestion: null,
    proxyFallback: (a) => `${col(a, 'desfecho')} = 'matriculado'` },
  { ordinal: 6, key: 'perdido',       status: 'PERDIDO',               emoji: '❌', label: 'Perdido',
    requerMotivo: true, column: true },
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
    WHEN ${col(alias, 'desfecho')} = 'matriculado' OR ${col(alias, 'status')} = 'CONVERTED' THEN 'convertido'
    WHEN ${col(alias, 'status')} = 'NEW' THEN 'novo'
    WHEN ${col(alias, 'status')} = 'EXPERIMENTAL_AGENDADA' THEN 'experimental'
    WHEN ${col(alias, 'status')} = 'QUALIFIED' THEN 'qualificado'
    ELSE 'qualificando' END`;
}

// ---- buckets do funil (precedência FATO > IA > PROXY) -------------------------------------------
// Escolhe o PRIMEIRO não-nulo (COALESCE de fontes, não OR). Hoje só o proxy existe → devolve o
// proxy da Fatia E, semanticamente idêntico ao que o computeFunil tinha inline.
function detectSql(stage, alias = 'l') {
  const src = (stage && (stage.sourceOfTruth || stage.iaSuggestion || stage.proxyFallback)) || null;
  return src ? `(${src(alias)})` : null;
}
// Fragmento do bucket do funil por key ('experimental'=agendada, 'realizada', 'convertido'=matrícula).
// alias '' (default aqui) = colunas cruas, como no computeFunil (FROM leads sem alias).
function funilBucketSql(key, alias = '') { return detectSql(_byKey[key], alias); }

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
  PERDIDO_DESFECHOS, MOTIVOS_PERDA, KANBAN_TRANSICOES, KEY_TO_STATUS, STATUS_TO_KEY,
  stageKey, stageOfLead, isStage, stageSql,
  detectSql, funilBucketSql, stageCatalog, loadStages,
};
