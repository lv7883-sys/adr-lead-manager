'use strict';
//
// agendaAcademiaDoRock.js — ADR-050 (E17-02). ADAPTADOR de agenda e presença da Academia do Rock.
//
// É o ÚNICO lugar do boas-vindas que conhece de onde vêm as aulas (ADR-050 §13.3, regra 10). Hoje a
// fonte é a grade que o Scheduler raspa da Extranet (app.agenda_snapshot); quando a API da Extranet
// existir (/v1/aulas, ADR-051), troca-se este arquivo e nada mais.
//
// O que ele entrega ao motor é neutro de ramo: "atendimentos" (inicio, fim, profissional, status).
//
// Fatos da fonte atual (verificados em produção, 2026-09-16):
//   • snapshot.aulasPorDia['YYYY-MM-DD'] = [{ aula_id, data, hora_inicio, hora_fim, aluno, curso,
//     status, aulaStatus, experimental, _prof, prof_tag, _id_aluno, _id_contrato, … }]
//   • _id_aluno / _id_contrato vêm em ~97% das aulas → ligação com o cadastro POR ID
//     (external_ref beneficiario / contrato), nunca por nome.
//   • status: "Realizada", "Confirmada pelo aluno", "Falta", "" (ainda não marcada), com ou sem " -"
//     no fim; aulaStatus: normal | falta | experimental.
//   • ⚠ o Scheduler raspa só a SEMANA CORRENTE (hoje → domingo). A aula da semana que vem só aparece
//     na segunda-feira; até lá a âncora "atendimento agendado" dessa aula fica aguardando.
//
// app.* não tem RLS: o isolamento é a franquia resolvida pelo tenant, SEM fallback (mesma regra do
// tenant-franquia.js do Scheduler). Tenant sem franquia única → não lê nada.
//
const NOME = 'academia-do-rock';
const ANCORAS = Object.freeze(['inicio_contrato', 'atendimento_agendado', 'primeiro_atendimento']);

const SQL_FRANQUIA = 'SELECT id FROM app.franquia WHERE lead_tenant_id = $1';
const SQL_SNAPSHOTS = `
  SELECT to_char(semana, 'YYYY-MM-DD') AS semana, snapshot->'aulasPorDia' AS aulas_por_dia
    FROM app.agenda_snapshot
   WHERE franquia_id = $1 AND semana >= ($2::date - 6) AND semana <= $3::date
   ORDER BY semana`;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Parte pura
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const HM = /^(\d{1,2}):(\d{2})/;
const ISO_DATA = /^\d{4}-\d{2}-\d{2}$/;

function instanteSP(data, hhmm) {
  const m = String(hhmm || '').match(HM);
  if (!ISO_DATA.test(String(data)) || !m) return null;
  return Date.parse(`${data}T${m[1].padStart(2, '0')}:${m[2]}:00-03:00`);
}

// Status da aula no vocabulário do motor.
function statusDaAula(a) {
  const s = String((a && a.status) || '').toLowerCase();
  if ((a && a.aulaStatus) === 'falta' || /falta/.test(s)) return 'falta';
  if (/cancel|reagend|remarc|desmarc/.test(s)) return 'cancelada';
  if (/^realizada/.test(s)) return 'realizada';
  return 'agendada';
}

// Aula individual de aluno matriculado: fora experimental e banda ("Música - Artista").
function ehAulaDeAluno(a) {
  if (!a || !a.aluno) return false;
  if (a.experimental === true || a.aulaStatus === 'experimental') return false;
  if (/\s-\s/.test(String(a.aluno))) return false;
  return instanteSP(a.data, a.hora_inicio) != null;
}

// aulasPorDia de vários snapshots → lista plana, sem repetir aula_id (o dia mais recente vence).
function achatarSnapshots(snapshots) {
  const porId = new Map();
  const semId = [];
  for (const s of snapshots || []) {
    const porDia = (s && (s.aulas_por_dia || s.aulasPorDia)) || {};
    for (const dia of Object.keys(porDia).sort()) {
      for (const a of porDia[dia] || []) {
        const aula = { ...a, data: a.data || dia };
        if (aula.aula_id != null) porId.set(String(aula.aula_id), aula);
        else semId.push(aula);
      }
    }
  }
  return [...porId.values(), ...semId];
}

// Aulas de UM contrato. Casa por _id_contrato; aula sem _id_contrato casa por _id_aluno
// (nunca por nome). Uma aula com OUTRO contrato do mesmo aluno (outro curso) não entra.
function aulasDoContrato(aulas, { idContrato, idAluno } = {}) {
  const ctr = idContrato != null && idContrato !== '' ? String(idContrato) : null;
  const alu = idAluno != null && idAluno !== '' ? String(idAluno) : null;
  if (!ctr && !alu) return [];
  return (aulas || []).filter((a) => {
    if (!ehAulaDeAluno(a)) return false;
    if (a._id_contrato != null) return ctr != null && String(a._id_contrato) === ctr;
    return alu != null && a._id_aluno != null && String(a._id_aluno) === alu;
  });
}

// Fatos que o motor usa, para um contrato:
//   atendimentos         aulas do contrato desde o início da vigência, em ordem, sem as canceladas
//                        (falta conta: a aula estava marcada)
//   primeiroAtendimento  primeira aula REALIZADA já terminada
function fatosDoContrato(aulas, { iniVigencia, agora } = {}) {
  const now = typeof agora === 'number' ? agora : Date.parse(agora);
  const lista = (aulas || [])
    .map((a) => ({
      aulaId: a.aula_id != null ? String(a.aula_id) : null,
      data: a.data,
      inicio: instanteSP(a.data, a.hora_inicio),
      fim: instanteSP(a.data, a.hora_fim) || instanteSP(a.data, a.hora_inicio),
      profissional: a._prof || a.prof_tag || null,
      status: statusDaAula(a),
    }))
    .filter((a) => a.inicio != null && (!iniVigencia || a.data >= iniVigencia) && a.status !== 'cancelada')
    .sort((x, y) => x.inicio - y.inicio);
  const realizada = lista.find((a) => a.status === 'realizada' && Number.isFinite(now) && a.fim <= now) || null;
  return { atendimentos: lista, primeiroAtendimento: realizada };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Parte com banco (lead_manager_user, com db/grants/boas_vindas_agenda_read.sql aplicado)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// { ok, franquiaId } | { ok:false, motivo }. Nunca lança por falta de acesso: sem agenda, o motor
// segue só com a âncora de início do contrato.
async function disponibilidade(c, tenantId) {
  await c.query('SAVEPOINT bv_franquia');   // falha de permissão não pode abortar a transação de quem chama
  try {
    const { rows } = await c.query(SQL_FRANQUIA, [tenantId]);
    await c.query('RELEASE SAVEPOINT bv_franquia');
    if (rows.length === 0) return { ok: false, motivo: 'unidade_sem_franquia' };
    if (rows.length > 1) return { ok: false, motivo: 'franquia_ambigua' };
    return { ok: true, franquiaId: rows[0].id };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT bv_franquia');
    if (e && (e.code === '42501' || e.code === '42P01' || e.code === '3F000')) return { ok: false, motivo: 'sem_acesso_a_agenda' };
    throw e;
  }
}

// Aulas da franquia entre `desde` e `ate` (YYYY-MM-DD). Usa SAVEPOINT para não abortar a transação
// de quem chama se a leitura falhar.
async function carregarAulas(c, franquiaId, { desde, ate }) {
  await c.query('SAVEPOINT bv_agenda');
  try {
    const { rows } = await c.query(SQL_SNAPSHOTS, [franquiaId, desde, ate]);
    await c.query('RELEASE SAVEPOINT bv_agenda');
    return achatarSnapshots(rows).filter((a) => a.data >= desde && a.data <= ate);
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT bv_agenda');
    throw e;
  }
}

module.exports = {
  NOME, ANCORAS, SQL_FRANQUIA, SQL_SNAPSHOTS,
  instanteSP, statusDaAula, ehAulaDeAluno, achatarSnapshots, aulasDoContrato, fatosDoContrato,
  disponibilidade, carregarAulas,
};
