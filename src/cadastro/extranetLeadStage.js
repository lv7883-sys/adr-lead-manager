'use strict';
//
// extranetLeadStage.js — RÉGUA da Situação da Extranet (mod_leads) → etapa do kanban (migr 102).
//
// HIERARQUIA (decisão do Leo 2026-08-11): HUMANO > EXTRANET > IA. A Extranet registra FATOS
// (experimental agendada, matrícula lançada na recepção); a IA infere de conversa. É o "Passo 2"
// que o cabeçalho do stages.js já anunciava (FATO externo > sugestão da IA > proxy).
//
// Duas peças:
//   mapSituacao(situacao)  — Situação crua da lista → etapa-alvo ('qualificando'|'qualificado'|
//                            'experimental'|'convertido') ou null (mirror-only: perda/desistência/
//                            desconhecida — a máquina não tira lead da mesa nem marca perda sozinha).
//   sustainedStageKey(c,…) — etapa que a Extranet SUSTENTA para um lead (via link extranet_lead).
//                            Usada pelo engine para a IA NÃO REBAIXAR sozinha um lead abaixo do
//                            fato registrado na Extranet (ela ainda pode SUGERIR; recepção decide).
//
// O mapa é por CHAVE NORMALIZADA (minúsculas, sem acento, sem pontuação) — a Extranet serve
// latin-ish com variações de caixa/abreviação. Situação fora do mapa → null + contador no sync
// (stats.situacao_desconhecida) para humano completar o mapa. Valores confirmados no probe 2026-08.
//
const stages = require('../stages');

// minúsculas, sem acento, sem pontuação, espaços colapsados: 'Exp. Agendada' → 'exp agendada'
function normSituacao(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Situação (normalizada) → etapa-alvo. null = mirror-only (registra no espelho, não move).
// Conjunto REAL do <select name="statusA"> da tela (probe 2026-08-11): Pendente, Conexão,
// Exp. Agendada, Exp. Realizada, Exp. Cancelada - Reagendar, Ganhou, Perdeu, Sem Retorno,
// Stand By, Desqualificado.
const SITUACAO_MAP = {
  'pendente': null,                 // estado inicial da Extranet — lead novo já nasce NEW aqui
  'conexao': 'qualificando',
  'atendido': 'qualificando',       // status legado (fora do select de filtro): recepção em contato
  'exp agendada': 'experimental',
  'exp realizada': 'experimental',  // 'realizada' não é coluna do kanban (funilOnly) — sustenta experimental
  'ganhou': 'convertido',           // matrícula (decisão 2026-08-11: aplica direto, desfecho_source='extranet')
  // mirror-only por desenho: perda/descarte exige motivo/decisão humana (molde e057bee); a aula
  // cancelada volta pra remarcação (não é fato de avanço); Sem Retorno/Stand By são pausa, não etapa.
  'exp cancelada': null,
  'exp cancelada reagendar': null,
  'perdeu': null,
  'sem retorno': null,
  'stand by': null,
  'desqualificado': null,
  // aliases defensivos (variações de digitação/histórico)
  'experimental agendada': 'experimental',
  'experimental realizada': 'experimental',
  'matricula': 'convertido',
  'matriculado': 'convertido',
};

// ---- CARIMBOS de aula experimental (migr 106) --------------------------------------------------
// A `situacao` do espelho é ESTADO ATUAL — o upsert do sync faz `situacao=EXCLUDED.situacao`, então
// quando a Extranet passa o lead para 'Ganhou' o badge 'Exp. Realizada' é sobrescrito e o fato de a
// aula ter acontecido some. O sync é o ÚNICO ponto que enxerga esse badge antes de ele sumir: estas
// duas chaves dizem o que a situação OBSERVADA prova, para ele carimbar (COALESCE, nunca limpa).
// 'realizada' implica 'agendada' — não se realiza aula que não foi marcada.
// ⚠ Pergunta DIFERENTE da do SITUACAO_MAP. Lá: "esta situação faz o lead AVANÇAR de etapa?" —
// e aula cancelada não avança (volta pra remarcação), por isso é mirror-only. Aqui: "esta situação
// PROVA que existiu uma aula marcada?" — e cancelada prova, porque só se cancela o que foi marcado.
// Incluir é o que faz o BI convergir com a tela Início, que conta a cancelada em "N agendadas" e
// depois em "N não aconteceram". Excluir encolheria o denominador e INFLARIA a taxa de
// comparecimento — o mesmo erro que a auditoria de 2026-08-26 apontou no bucket `outro` da Início.
const SITUACAO_EXP_AGENDADA = new Set([
  'exp agendada', 'exp realizada', 'experimental agendada', 'experimental realizada',
  'exp cancelada', 'exp cancelada reagendar',
]);
const SITUACAO_EXP_REALIZADA = new Set(['exp realizada', 'experimental realizada']);

// → { agendada: boolean, realizada: boolean }
function carimbosExperimental(situacao) {
  const n = normSituacao(situacao);
  return { agendada: SITUACAO_EXP_AGENDADA.has(n), realizada: SITUACAO_EXP_REALIZADA.has(n) };
}

// → { key: etapa|null, known: boolean } — distingue "mapeada para nada" de "desconhecida".
function mapSituacao(situacao) {
  const n = normSituacao(situacao);
  if (!n) return { key: null, known: false };
  if (n in SITUACAO_MAP) return { key: SITUACAO_MAP[n], known: true };
  return { key: null, known: false };
}

const ORDINAL = Object.fromEntries(stages.STAGES.map((s) => [s.key, s.ordinal]));

// Etapa que a Extranet SUSTENTA para o lead: a MAIOR etapa mapeada entre os links presentes
// (não soft-deletados) do espelho. null = Extranet não diz nada sobre esse lead.
// Degrada elegante se a migração 102 ainda não foi aplicada (tabela ausente) — molde loadConfig.
async function sustainedStageKey(c, { tenantId, leadId }) {
  let rows;
  try {
    rows = (await c.query(
      `SELECT situacao FROM lead_manager.extranet_lead
        WHERE tenant_id=$1 AND lead_id=$2 AND fonte_ausente_em IS NULL`,
      [tenantId, leadId])).rows;
  } catch { return null; }
  let best = null;
  for (const r of rows) {
    const { key } = mapSituacao(r.situacao);
    if (key && (best === null || ORDINAL[key] > ORDINAL[best])) best = key;
  }
  return best;
}

module.exports = {
  SITUACAO_MAP, normSituacao, mapSituacao, sustainedStageKey, ORDINAL,
  SITUACAO_EXP_AGENDADA, SITUACAO_EXP_REALIZADA, carimbosExperimental,
};
