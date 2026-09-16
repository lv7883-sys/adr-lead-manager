'use strict';
//
// ADR-050 (E17-02) — adaptador de agenda da Academia do Rock + planejamento da unidade. Puros, sem banco.
// Aulas no formato REAL do app.agenda_snapshot (verificado em produção em 2026-09-16), com nomes fictícios.
// Calendário (SP): 2026-09-18 SEXTA (matrícula) · 2026-09-24 QUINTA (1ª aula) · 2026-10-01 QUINTA (2ª).
//
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../src/boasVindasRegua');
const A = require('../src/boasVindas/agendaAcademiaDoRock');
const { planejarUnidade, nomeCurto } = require('../src/boasVindas/planejar');
const { RENOVACAO_PRIMEIRO_MARCO_DIAS } = require('../src/boasVindas/dados');

const HORARIO = {
  1: [{ inicio: '09:00', fim: '21:00' }], 2: [{ inicio: '09:00', fim: '21:00' }], 3: [{ inicio: '09:00', fim: '21:00' }],
  4: [{ inicio: '09:00', fim: '21:00' }], 5: [{ inicio: '09:00', fim: '21:00' }], 6: [{ inicio: '09:00', fim: '13:00' }],
};
const sp = (data, hhmm) => Date.parse(`${data}T${hhmm}:00-03:00`);

const aula = (over = {}) => ({
  data: '2026-09-24', sala: 'Sala 6', _prof: 'Juliano Prado', prof_tag: 'Juliano', aluno: 'Pedro Souza', curso: 'Curso BASS',
  status: '', _profId: '2', aula_id: '1', hora_inicio: '15:00', hora_fim: '16:00', _id_aluno: 540, _id_curso: 13,
  _id_turma: 653, aulaStatus: 'normal', _id_contrato: 1154, experimental: false, ...over,
});

// Régua = o modelo da migration 125 (mesmo parser do teste da régua).
const SEED = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '125_boas_vindas_modelo_escola_musica.sql'), 'utf8');
const MODELO = SEED.slice(SEED.indexOf('INSERT INTO lead_manager.boas_vindas_modelo_etapa')).split(/\n-- \d ─/).slice(1).map((b) => {
  const h = b.match(/\('escola-de-musica-academia-do-rock', (\d+), '([^']+)', '(\w+)', '(\{[^']+\})', (\d), (true|false),/);
  const textos = [...b.matchAll(/\$t\$([\s\S]*?)\$t\$/g)].map((m) => m[1]);
  return {
    id: `e${h[1]}`, ordem: Number(h[1]), nome: h[2], ancora: h[3], quando: JSON.parse(h[4]), repeticoes: Number(h[5]),
    contrato_curto: h[6] === 'true', texto_titular: textos[0], texto_responsavel: textos[1] || null,
    entregue_por: b.match(/'(regente|externo)'\)/)[1], ativo: true, anexo_id: null,
    anexo_sugerido: /'imagem', 'regente'\)|'documento', 'regente'\)/.test(b) ? 'sugerido' : null,
  };
});
const CONFIG = { horario: HORARIO, modo: 'avisa', alertaDias: 21, variaveis: { link_ead: 'https://ead.exemplo.com' }, empresa: 'Academia do Rock Valinhos' };

const contrato = (over = {}) => ({
  accountId: 'acc-1', iniVigencia: '2026-09-18', fimVigencia: '2027-09-17', servico: 'Baixo', periodicidade: 'anual',
  professorNome: 'MARCOS TEIXEIRA', contratoExt: '1154',   // de propósito ≠ do professor da aula
  beneficiario: { personId: 'p-aluno', nome: 'PEDRO SOUZA', telefone: '5519911110000', alunoExt: '540' },
  pagador: { personId: 'p-mae', nome: 'Carla Souza', telefone: '5519922220000' },
  temContratoAnterior: false, contatoInterno: false, ...over,
});
const toqueDe = (plano, ordem, rep = 1) => plano.toques.find((t) => t.ordem === ordem && t.repeticao === rep);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
test('adaptador: status da Extranet no vocabulário do motor', () => {
  assert.equal(A.statusDaAula(aula({ status: 'Realizada' })), 'realizada');
  assert.equal(A.statusDaAula(aula({ status: 'Realizada - ' })), 'realizada');
  assert.equal(A.statusDaAula(aula({ status: 'Confirmada pelo aluno' })), 'agendada');
  assert.equal(A.statusDaAula(aula({ status: '' })), 'agendada');
  assert.equal(A.statusDaAula(aula({ status: 'Falta', aulaStatus: 'falta' })), 'falta');
  assert.equal(A.statusDaAula(aula({ status: 'Cancelada pelo aluno' })), 'cancelada');
  assert.equal(A.statusDaAula(aula({ status: 'Reagendada' })), 'cancelada');
});

test('adaptador: só aula individual de aluno — sem experimental nem banda', () => {
  assert.equal(A.ehAulaDeAluno(aula()), true);
  assert.equal(A.ehAulaDeAluno(aula({ experimental: true })), false);
  assert.equal(A.ehAulaDeAluno(aula({ aulaStatus: 'experimental' })), false);
  assert.equal(A.ehAulaDeAluno(aula({ aluno: 'Legião Urbana - Tempo Perdido' })), false);
  assert.equal(A.ehAulaDeAluno(aula({ hora_inicio: '' })), false);
});

test('adaptador: casa pelo id do contrato; sem id de contrato, pelo id do aluno; nunca pelo nome', () => {
  const aulas = [
    aula({ aula_id: '1' }),
    aula({ aula_id: '2', _id_contrato: 999 }),                             // outro curso do mesmo aluno
    aula({ aula_id: '3', _id_contrato: undefined }),                      // sem contrato → casa pelo aluno
    aula({ aula_id: '4', _id_contrato: undefined, _id_aluno: 777 }),      // outro aluno
    aula({ aula_id: '5', _id_contrato: undefined, _id_aluno: undefined }), // mesmo nome, sem id → fora
  ];
  assert.deepEqual(A.aulasDoContrato(aulas, { idContrato: '1154', idAluno: '540' }).map((a) => a.aula_id), ['1', '3']);
  assert.deepEqual(A.aulasDoContrato(aulas, {}), []);
});

test('adaptador: semanas diferentes com a mesma aula não duplicam', () => {
  const s1 = { semana: '2026-09-21', aulas_por_dia: { '2026-09-24': [aula({ aula_id: '10', status: '' })] } };
  const s2 = { semana: '2026-09-21', aulas_por_dia: { '2026-09-24': [aula({ aula_id: '10', status: 'Realizada' })] } };
  const r = A.achatarSnapshots([s1, s2]);
  assert.equal(r.length, 1);
  assert.equal(r[0].status, 'Realizada', 'a leitura mais recente vence');
});

test('adaptador: fatos — cancelada não conta, falta conta como aula marcada, 1ª realizada só depois de terminar', () => {
  const aulas = [
    aula({ aula_id: '0', data: '2026-09-10', status: 'Realizada' }),               // antes do contrato
    aula({ aula_id: '1', data: '2026-09-22', status: 'Cancelada pelo aluno' }),
    aula({ aula_id: '2', data: '2026-09-24', status: 'Falta', aulaStatus: 'falta' }),
    aula({ aula_id: '3', data: '2026-10-01', status: 'Realizada', _prof: 'Ana Lima' }),
  ];
  const f = A.fatosDoContrato(aulas, { iniVigencia: '2026-09-18', agora: sp('2026-10-01', '15:30') });
  assert.deepEqual(f.atendimentos.map((a) => a.aulaId), ['2', '3']);
  assert.equal(f.primeiroAtendimento, null, 'a aula das 15h ainda não terminou às 15h30');
  const depois = A.fatosDoContrato(aulas, { iniVigencia: '2026-09-18', agora: sp('2026-10-01', '16:00') });
  assert.equal(depois.primeiroAtendimento.aulaId, '3');
  assert.equal(depois.primeiroAtendimento.profissional, 'Ana Lima');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
test('paridade: o teto usa o mesmo primeiro marco da régua de renovação', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'jobs', 'renovacao-sweep.js'), 'utf8');
  const marcos = [...src.match(/const MARCO_DE = \{([^}]*)\}/)[1].matchAll(/(\d+):/g)].map((m) => Number(m[1]));
  assert.equal(Math.max(...marcos), RENOVACAO_PRIMEIRO_MARCO_DIAS);
});

test('nomes: primeiro nome, sem CAIXA ALTA', () => {
  assert.equal(nomeCurto('PEDRO SOUZA'), 'Pedro');
  assert.equal(nomeCurto('Érica Lima'), 'Érica');
  assert.equal(nomeCurto('ÉRICA'), 'Érica');
  assert.equal(nomeCurto(''), null);
});

function planoDe({ contratos = [contrato()], aulas = [], agora, existentes = [], fonteAgenda = true, config = CONFIG } = {}) {
  const fatos = new Map(contratos.map((ct) => [ct.accountId,
    A.fatosDoContrato(A.aulasDoContrato(aulas, { idContrato: ct.contratoExt, idAluno: ct.beneficiario && ct.beneficiario.alunoExt }), { iniVigencia: ct.iniVigencia, agora })]));
  return planejarUnidade({ contratos, etapas: MODELO, fatosPorConta: fatos, fonteAgenda, config, agora, existentes });
}

test('planejar: matrícula nova com agenda — boas-vindas devida para o responsável, com dia, horário e professor', () => {
  const aulas = [aula({ aula_id: '1' }), aula({ aula_id: '2', data: '2026-10-01', _prof: 'Ana Lima' })];
  const r = planoDe({ aulas, agora: sp('2026-09-18', '10:00') });
  const bv1 = toqueDe(r.planos[0], 1);
  assert.equal(bv1.status, 'pendente');
  assert.equal(bv1.momento, 'devida');
  assert.equal(bv1.versao, 'responsavel');
  assert.equal(bv1.phone, '5519922220000');
  assert.match(bv1.textoFinal, /^\*Pedro, seja muito bem-vindo!\*/);
  assert.match(bv1.textoFinal, /\* Instrumento: Baixo\n\* Professor: Juliano\n\* Dia: quinta-feira, 24\/09\n\* Horário: 15h/);
  assert.match(bv1.textoFinal, /https:\/\/ead\.exemplo\.com/);
  assert.match(bv1.textoFinal, /Academia do Rock Valinhos$/);
  assert.equal(bv1.motivo, 'anexo_nao_configurado', 'a imagem do EAD ainda não foi enviada pela unidade');
  // Lembretes das 2 aulas: futuros, texto do responsável.
  assert.match(toqueDe(r.planos[0], 3, 1).textoFinal, /aula do\(a\) Pedro será amanhã, quinta-feira, 24\/09, às 15h, com o professor Juliano/);
  assert.equal(toqueDe(r.planos[0], 3, 2).momento, 'futura');
  assert.match(toqueDe(r.planos[0], 3, 2).textoFinal, /com o professor Ana\./, 'o professor é o DA AULA, não o do contrato');
  // Etapas presas à 1ª aula ainda não existem; a pesquisa é externa: nada gravado para ela.
  assert.equal(toqueDe(r.planos[0], 4), undefined);
  assert.equal(toqueDe(r.planos[0], 7), undefined);
  assert.equal(r.resumo.criar, r.toques.length);
});

test('planejar: sem a aula na agenda, a boas-vindas fica BLOQUEADA (nunca sai "às [horário]")', () => {
  const r = planoDe({ aulas: [], agora: sp('2026-09-18', '10:00') });
  const bv1 = toqueDe(r.planos[0], 1);
  assert.equal(bv1.status, 'bloqueado');
  assert.equal(bv1.bloqueio, 'sem_horario');
  assert.equal(toqueDe(r.planos[0], 2).status, 'pendente', 'as orientações não dependem da aula');
});

test('planejar: renovação e contato interno não recebem boas-vindas', () => {
  const r = planoDe({
    contratos: [contrato({ accountId: 'ren', temContratoAnterior: true }), contrato({ accountId: 'int', contatoInterno: true })],
    agora: sp('2026-09-18', '10:00'),
  });
  assert.deepEqual(r.planos.map((p) => [p.elegivel, p.motivo]), [[false, 'renovacao'], [false, 'contato_interno']]);
  assert.equal(r.toques.length, 0);
});

test('planejar: o que passou do prazo vira fora_da_janela (não sai atrasado)', () => {
  const r = planoDe({ aulas: [aula({ status: 'Realizada' })], agora: sp('2026-10-10', '10:00') });
  assert.equal(toqueDe(r.planos[0], 2).status, 'fora_da_janela');
  assert.equal(toqueDe(r.planos[0], 2).motivo, 'passou_do_prazo');
  assert.equal(toqueDe(r.planos[0], 1).status, 'fora_da_janela', 'boas-vindas também: a 1ª aula já aconteceu há mais de 1 dia');
});

test('planejar R6: boas-vindas que espera a agenda vale até a 1ª aula acontecer, e cita a PRÓXIMA aula', () => {
  // Matrícula 18/09, 1ª aula só em 05/10 (duas semanas depois). Em 01/10 a aula aparece na agenda.
  const aulas = [aula({ aula_id: '1', data: '2026-10-05', hora_inicio: '10:00', hora_fim: '11:00' })];
  const semAgenda = planoDe({ aulas: [], agora: sp('2026-09-28', '10:00') });
  assert.equal(toqueDe(semAgenda.planos[0], 1).status, 'bloqueado', '10 dias depois, ainda espera a aula — não vence em 7 dias');
  assert.equal(toqueDe(semAgenda.planos[0], 1).momento, 'devida');
  const comAgenda = planoDe({ aulas, agora: sp('2026-10-01', '10:00') });
  const bv1 = toqueDe(comAgenda.planos[0], 1);
  assert.equal(bv1.status, 'pendente');
  assert.match(bv1.textoFinal, /\* Dia: segunda-feira, 05\/10\n\* Horário: 10h/);
});

test('planejar: mensagem já tratada pela recepção fica como está; pendente com aula remarcada é atualizada', () => {
  const agora = sp('2026-09-18', '10:00');
  const aulas = [aula({ aula_id: '1', data: '2026-09-25' }), aula({ aula_id: '2', data: '2026-10-01' })];   // 1ª aula remarcada p/ sexta
  const existentes = [
    { id: 'x1', account_id: 'acc-1', etapa_id: 'e1', repeticao: 1, status: 'enviado', phone: '5519922220000', due_at: new Date(agora).toISOString(), enviado_em: new Date(agora).toISOString() },
    { id: 'x3', account_id: 'acc-1', etapa_id: 'e3', repeticao: 1, status: 'pendente', phone: '5519922220000', due_at: new Date(sp('2026-09-23', '18:00')).toISOString(), versao: 'responsavel', texto_final: 'velho' },
  ];
  const r = planoDe({ aulas, agora, existentes });
  assert.equal(toqueDe(r.planos[0], 1).acao, 'manter');
  assert.equal(toqueDe(r.planos[0], 1).status, 'enviado');
  const lembrete = toqueDe(r.planos[0], 3, 1);
  assert.equal(lembrete.acao, 'atualizar');
  assert.equal(new Date(lembrete.dueAt).toISOString(), new Date(sp('2026-09-24', '18:00')).toISOString());
});

test('planejar R7: irmãos contratados juntos recebem UMA boas-vindas com os dois nomes', () => {
  const agora = sp('2026-09-18', '10:00');
  const mae = { personId: 'p-mae', nome: 'Carla Souza', telefone: '5519922220000' };
  const contratos = [
    contrato({ accountId: 'acc-a', contratoExt: '1', beneficiario: { personId: 'pa', nome: 'Ana Souza', telefone: null, alunoExt: '1' }, pagador: mae }),
    contrato({ accountId: 'acc-b', contratoExt: '2', beneficiario: { personId: 'pb', nome: 'Bruno Souza', telefone: null, alunoExt: '2' }, pagador: mae }),
  ];
  const r = planoDe({ contratos, aulas: [], agora, fonteAgenda: false });
  const orientA = toqueDe(r.planos[0], 2);
  const orientB = toqueDe(r.planos[1], 2);
  assert.equal(r.planos[0].toques.length > 0, true);
  // Boas-vindas bloqueadas (sem agenda) não entram no R7; as orientações (D+2) ainda são futuras.
  assert.equal(orientA.momento, 'futura');
  const r2 = planoDe({ contratos, aulas: [], agora: sp('2026-09-21', '10:00'), fonteAgenda: false });
  const [a, b] = [toqueDe(r2.planos[0], 2), toqueDe(r2.planos[1], 2)];
  const principal = a.status === 'pendente' ? a : b;
  const agrupada = a.status === 'pendente' ? b : a;
  assert.equal(agrupada.status, 'descartado');
  assert.match(agrupada.motivo, /^agrupada_na_mensagem_de_/);
  assert.equal(principal.valores.cliente, 'Ana e Bruno');
  assert.equal(r2.resumo.agrupadas, 1);
  assert.ok(orientB);
});

test('planejar: sem fonte de agenda, só as etapas do início do contrato existem', () => {
  const r = planoDe({ aulas: [aula()], agora: sp('2026-09-18', '10:00'), fonteAgenda: false });
  assert.deepEqual([...new Set(r.planos[0].toques.map((t) => t.ordem))].sort(), [1, 2]);
  assert.equal(r.planos[0].alertaSemInicio, false, 'sem presença integrada não há alerta');
});

test('planejar: alerta de quem não começou no prazo da unidade', () => {
  const r = planoDe({ aulas: [], agora: sp('2026-10-09', '10:00') });
  assert.equal(r.planos[0].alertaSemInicio, true);
  assert.equal(r.resumo.alertasSemInicio, 1);
});

test('planejar: sem nenhum professor na aula, cai no professor do contrato', () => {
  const r = planoDe({ aulas: [aula({ _prof: null, prof_tag: null })], agora: sp('2026-09-18', '10:00') });
  assert.match(toqueDe(r.planos[0], 1).textoFinal, /\* Professor: Marcos/);
});

test('planejar: ATIVAÇÃO — o que já venceu não vai para a recepção; o futuro segue normal', () => {
  const aulas = [aula({ aula_id: '1', data: '2026-09-24', status: 'Realizada' }), aula({ aula_id: '2', data: '2026-10-01' })];
  const agora = sp('2026-09-29', '10:00');
  const normal = planoDe({ aulas, agora });
  assert.ok(normal.toques.some((x) => x.status === 'pendente' && x.momento === 'devida'), 'sem ativação haveria atraso acumulado');
  const ativ = planejarUnidade({ contratos: [contrato()], etapas: MODELO,
    fatosPorConta: new Map([['acc-1', A.fatosDoContrato(A.aulasDoContrato(aulas, { idContrato: '1154' }), { iniVigencia: '2026-09-18', agora })]]),
    fonteAgenda: true, config: CONFIG, agora, ativacao: true });
  assert.equal(ativ.toques.filter((x) => x.status === 'pendente' && x.momento === 'devida').length, 0);
  assert.ok(ativ.toques.some((x) => x.motivo === 'anterior_a_ativacao'));
  assert.equal(toqueDe(ativ.planos[0], 3, 2).status, 'pendente', 'o lembrete da aula de 01/10 continua');
  assert.equal(toqueDe(ativ.planos[0], 3, 2).momento, 'futura');
});

test('planejar: família com mensagens atrasadas recebe uma por vez', () => {
  const aulas = [aula({ aula_id: '1', data: '2026-09-21', status: 'Realizada' }), aula({ aula_id: '2', data: '2026-09-29' })];
  const r = planoDe({ aulas, agora: sp('2026-09-23', '10:00') });
  const devidas = r.toques.filter((x) => x.status === 'pendente' && x.momento === 'devida');
  // "Como foi a primeira aula" (presa à aula, vence em 2 dias) sai hoje; boas-vindas e orientações,
  // atrasadas, esperam o dia seguinte e depois mais 48 h entre si.
  assert.deepEqual(devidas.map((x) => x.ordem), [4], 'uma mensagem por família por dia; a presa à aula tem prioridade');
  const adiadas = r.toques.filter((x) => x.motivo === 'adiada_uma_mensagem_por_vez_para_a_familia').sort((a, b) => a.dueAt - b.dueAt);
  assert.deepEqual(adiadas.map((x) => [x.ordem, R.dataSP(x.dueAt)]), [[1, '2026-09-24'], [2, '2026-09-26']]);
});

test('planejar: lembrete da aula previsto para hoje à tarde segura a mensagem comum da manhã', () => {
  // Matrícula 18/09; 1ª aula quinta 24/09 15h. Em 23/09 às 10h: orientações (21/09) ainda devidas,
  // lembrete da aula sai às 18h de hoje → as orientações esperam o dia seguinte.
  const aulas = [aula({ aula_id: '1', data: '2026-09-24' })];
  const existentes = [{ id: 'x1', account_id: 'acc-1', etapa_id: 'e1', repeticao: 1, status: 'enviado', phone: '5519922220000',
    due_at: new Date(sp('2026-09-18', '09:00')).toISOString(), enviado_em: new Date(sp('2026-09-18', '09:05')).toISOString() }];
  const r = planoDe({ aulas, agora: sp('2026-09-23', '10:00'), existentes });
  const orient = toqueDe(r.planos[0], 2);
  assert.equal(orient.momento, 'futura');
  assert.equal(orient.motivo, 'adiada_uma_mensagem_por_vez_para_a_familia');
  assert.equal(R.dataSP(orient.dueAt), '2026-09-24');
  assert.equal(toqueDe(r.planos[0], 3, 1).status, 'pendente');
});
