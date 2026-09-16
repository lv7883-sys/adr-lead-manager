'use strict';
//
// ADR-050 (E17-01) — régua de boas-vindas: validação, cálculo das datas e travas R1–R10.
// Testes puros (sem banco). Calendário de referência (SP = UTC-3):
//   2026-09-18 = SEXTA (matrícula) · 2026-09-20 = DOMINGO · 2026-09-24 = QUINTA (1ª aula, 15h–16h)
//
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../src/boasVindasRegua');

// Horário de atendimento de referência: seg–sex 09–21, sáb 09–13, domingo fechado.
const HORARIO = {
  1: [{ inicio: '09:00', fim: '21:00' }], 2: [{ inicio: '09:00', fim: '21:00' }], 3: [{ inicio: '09:00', fim: '21:00' }],
  4: [{ inicio: '09:00', fim: '21:00' }], 5: [{ inicio: '09:00', fim: '21:00' }], 6: [{ inicio: '09:00', fim: '13:00' }],
};
const sp = (data, hhmm) => Date.parse(`${data}T${hhmm}:00-03:00`);
const iso = (ms) => new Date(ms).toISOString();

// ── O modelo da Academia do Rock, lido da própria migration de seed (garante paridade código ↔ banco).
const SEED = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '125_boas_vindas_modelo_escola_musica.sql'), 'utf8');
function modeloDoSeed() {
  const valores = SEED.slice(SEED.indexOf('INSERT INTO lead_manager.boas_vindas_modelo_etapa'));
  const blocos = valores.split(/\n-- \d ─/).slice(1);
  return blocos.map((b) => {
    const h = b.match(/\('escola-de-musica-academia-do-rock', (\d+), '([^']+)', '(\w+)', '(\{[^']+\})', (\d), (true|false),/);
    const textos = [...b.matchAll(/\$t\$([\s\S]*?)\$t\$/g)].map((m) => m[1]);
    const entregue = b.match(/'(regente|externo)'\)/)[1];
    return {
      id: `etapa-${h[1]}`, ordem: Number(h[1]), nome: h[2], ancora: h[3], quando: JSON.parse(h[4]),
      repeticoes: Number(h[5]), contrato_curto: h[6] === 'true',
      texto_titular: textos[0] || null, texto_responsavel: textos[1] || null,
      entregue_por: entregue, ativo: true, anexo_id: null,
    };
  });
}
const MODELO = modeloDoSeed();
const porOrdem = (lista, ordem, rep = 1) => lista.find((m) => m.etapa.ordem === ordem && m.repeticao === rep);

const ANUAL = { iniVigencia: '2026-09-18', fimVigencia: '2027-09-17' };
const AULAS = {
  atendimentos: [
    { inicio: sp('2026-10-01', '15:00'), fim: sp('2026-10-01', '16:00') },   // fora de ordem de propósito
    { inicio: sp('2026-09-24', '15:00'), fim: sp('2026-09-24', '16:00') },
  ],
  primeiroAtendimento: { inicio: sp('2026-09-24', '15:00'), fim: sp('2026-09-24', '16:00') },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
test('seed: o modelo tem as 7 etapas da planilha, na ordem e com as âncoras decididas', () => {
  assert.equal(MODELO.length, 7);
  assert.deepEqual(MODELO.map((e) => e.nome), [
    'Boas-vindas', 'Orientações iniciais', 'Lembrete da aula', 'Como foi a primeira aula',
    'Guia do Aluno', 'Projetos e eventos', 'Pesquisa de satisfação',
  ]);
  assert.deepEqual(MODELO.map((e) => e.ancora), [
    'inicio_contrato', 'inicio_contrato', 'atendimento_agendado', 'primeiro_atendimento',
    'primeiro_atendimento', 'primeiro_atendimento', 'inicio_contrato',
  ]);
  assert.equal(MODELO[2].repeticoes, 2, 'lembrete das DUAS primeiras aulas');
  assert.deepEqual(MODELO.filter((e) => e.contrato_curto).map((e) => e.ordem), [1, 2, 4, 5], 'mensal: 1, 2, 4 e 5');
  assert.equal(MODELO[6].entregue_por, 'externo', 'a pesquisa é do Diapasão');
});

test('seed: passa em todas as travas e só usa variáveis conhecidas', () => {
  const r = R.validarRegua(MODELO, { variaveisLivres: ['link_ead', 'link_pesquisa'] });
  assert.deepEqual(r.erros, []);
  assert.equal(r.ok, true);
  for (const e of MODELO) {
    for (const t of [e.texto_titular, e.texto_responsavel]) {
      assert.doesNotMatch(String(t || ''), /\[[^\]]+\]/, `etapa ${e.ordem} ainda tem [campo] da planilha`);
    }
  }
});

test('seed: sem as variáveis da unidade, a tela acusa {link_ead} e {link_pesquisa}', () => {
  const r = R.validarRegua(MODELO);
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((m) => m.includes('{link_ead}')));
  assert.ok(r.erros.some((m) => m.includes('{link_pesquisa}')));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
test('cálculo: contrato anual da Academia do Rock cai nos dias e horários certos', () => {
  const ms = R.calcularMensagens({ conta: ANUAL, etapas: MODELO, fatos: AULAS, horario: HORARIO });
  const esperado = {
    '1/1': ['2026-09-18', '09:00'],   // sexta, abertura
    '2/1': ['2026-09-21', '09:00'],   // D+2 é domingo → segunda
    '3/1': ['2026-09-23', '18:00'],   // véspera da 1ª aula, fim do expediente
    '3/2': ['2026-09-30', '18:00'],   // véspera da 2ª aula
    '4/1': ['2026-09-24', '16:00'],   // assim que a 1ª aula termina (dentro do expediente)
    '5/1': ['2026-09-29', '09:00'],   // 1ª aula + 5
    '6/1': ['2026-10-19', '09:00'],   // 1ª aula + 25 (segunda)
  };
  for (const [k, [data, hora]] of Object.entries(esperado)) {
    const [ordem, rep] = k.split('/').map(Number);
    const m = porOrdem(ms, ordem, rep);
    assert.equal(m.situacao, 'agendada', `etapa ${k}`);
    assert.equal(iso(m.dueAt), iso(sp(data, hora)), `etapa ${k}`);
  }
  const nps = porOrdem(ms, 7);
  assert.equal(nps.situacao, 'externa', 'o Regente não envia a pesquisa');
  assert.equal(R.dataSP(nps.dueAt), '2026-10-18', 'D+30 só para a linha do tempo');
});

test('cálculo: sem agenda ainda, as etapas presas às aulas ficam aguardando', () => {
  const ms = R.calcularMensagens({ conta: ANUAL, etapas: MODELO, fatos: {}, horario: HORARIO });
  assert.equal(porOrdem(ms, 1).situacao, 'agendada');
  for (const [o, rep] of [[3, 1], [3, 2], [4, 1], [5, 1], [6, 1]]) {
    assert.equal(porOrdem(ms, o, rep).situacao, 'aguardando_ancora', `etapa ${o}/${rep}`);
  }
});

test('cálculo: aula anterior ao início do contrato não conta como 1ª aula agendada', () => {
  const fatos = { atendimentos: [{ inicio: sp('2026-09-10', '15:00'), fim: sp('2026-09-10', '16:00') }, ...AULAS.atendimentos] };
  const ms = R.calcularMensagens({ conta: ANUAL, etapas: MODELO, fatos, horario: HORARIO });
  assert.equal(R.dataSP(porOrdem(ms, 3, 1).dueAt), '2026-09-23');
});

test('R5: unidade sem horário de atendimento configurado não agenda nada', () => {
  const ms = R.calcularMensagens({ conta: ANUAL, etapas: MODELO, fatos: AULAS, horario: null });
  for (const m of ms.filter((x) => x.etapa.entregue_por !== 'externo')) {
    assert.equal(m.situacao, 'sem_horario_atendimento');
  }
});

test('R5: feriado é pulado', () => {
  const ms = R.calcularMensagens({ conta: ANUAL, etapas: MODELO, fatos: AULAS, horario: HORARIO, feriados: ['2026-09-18'] });
  assert.equal(iso(porOrdem(ms, 1).dueAt), iso(sp('2026-09-19', '09:00')), 'sexta feriado → sábado');
});

test('R5: véspera em dia fechado recua; almoço e abertura só à noite', () => {
  // Aula na segunda → domingo fechado → sábado, que fecha às 13h → 12h30.
  assert.equal(iso(R.momentoVespera(HORARIO, '2026-09-21')), iso(sp('2026-09-19', '12:30')));
  // Segunda com almoço (09–12, 14–17): aula na terça → segunda 16h30 (30 min antes de fechar).
  assert.equal(iso(R.momentoVespera({ 1: [{ inicio: '09:00', fim: '12:00' }, { inicio: '14:00', fim: '17:00' }] }, '2026-09-22')),
    iso(sp('2026-09-21', '16:30')));
  // Unidade que só abre às 19h: aula na quarta → terça 19h.
  assert.equal(iso(R.momentoVespera({ 2: [{ inicio: '19:00', fim: '22:00' }] }, '2026-09-23')), iso(sp('2026-09-22', '19:00')));
  // Nada aberto nos 3 dias anteriores → sem véspera.
  assert.equal(R.momentoVespera({ 5: [{ inicio: '09:00', fim: '18:00' }] }, '2026-09-22'), null);
});

test('R5: próxima abertura nunca antecipa e atravessa a noite', () => {
  assert.equal(iso(R.proximaAbertura(HORARIO, sp('2026-09-24', '20:59'))), iso(sp('2026-09-24', '20:59')));
  assert.equal(iso(R.proximaAbertura(HORARIO, sp('2026-09-24', '21:00'))), iso(sp('2026-09-25', '09:00')));
  assert.equal(iso(R.proximaAbertura(HORARIO, sp('2026-09-19', '13:00'))), iso(sp('2026-09-21', '09:00')), 'sábado 13h → segunda');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
test('R2: teto = 60 dias, metade do contrato ou véspera da renovação — o que vier antes', () => {
  assert.equal(R.tetoDaRegua(ANUAL), '2026-11-17', 'anual: 60 dias');
  assert.equal(R.tetoDaRegua({ iniVigencia: '2026-09-18', fimVigencia: '2026-12-17' }), '2026-11-02', 'trimestral: metade');
  assert.equal(R.tetoDaRegua({ iniVigencia: '2026-09-18', fimVigencia: '2026-12-17', inicioRenovacao: '2026-11-02' }), '2026-11-01');
  assert.equal(R.tetoDaRegua({ iniVigencia: '2026-09-18' }), '2026-11-17', 'sem fim de vigência: só os 60 dias');
});

test('R2: contrato curto ignora o início da renovação (senão o mensal nunca teria boas-vindas)', () => {
  const mensal = { iniVigencia: '2026-09-18', fimVigencia: '2026-10-17', inicioRenovacao: '2026-09-02' };
  assert.equal(R.tetoDaRegua(mensal), '2026-10-02', 'metade de 29 dias');
});

test('R2: trimestral com 1ª aula tardia — a etapa 6 passa do teto e não sai', () => {
  const tri = { iniVigencia: '2026-09-18', fimVigencia: '2026-12-17', inicioRenovacao: '2026-11-02' };
  const fatos = { primeiroAtendimento: { inicio: sp('2026-10-08', '15:00'), fim: sp('2026-10-08', '16:00') } };
  const ms = R.calcularMensagens({ conta: tri, etapas: MODELO, fatos, horario: HORARIO });
  assert.equal(porOrdem(ms, 5).situacao, 'agendada');
  assert.equal(porOrdem(ms, 6).situacao, 'fora_da_janela', '08/10 + 25 = 02/11, depois do teto 01/11');
});

test('contrato curto: só as etapas 1, 2, 4 e 5 — e a 5 respeita a metade do contrato', () => {
  const mensal = { iniVigencia: '2026-09-18', fimVigencia: '2026-10-17' };
  const ms = R.calcularMensagens({ conta: mensal, etapas: MODELO, fatos: AULAS, horario: HORARIO });
  assert.deepEqual([...new Set(ms.map((m) => m.etapa.ordem))].sort(), [1, 2, 4, 5]);
  assert.equal(porOrdem(ms, 5).situacao, 'agendada');
  const tarde = { primeiroAtendimento: { inicio: sp('2026-09-30', '15:00'), fim: sp('2026-09-30', '16:00') } };
  const ms2 = R.calcularMensagens({ conta: mensal, etapas: MODELO, fatos: tarde, horario: HORARIO });
  assert.equal(porOrdem(ms2, 5).situacao, 'fora_da_janela', '30/09 + 5 = 05/10, depois de 02/10');
});

test('R3: duas mensagens a menos de 48 h — a posterior é empurrada, a presa à aula não', () => {
  const etapas = [
    { id: 'a', ordem: 1, nome: 'A', ancora: 'inicio_contrato', quando: { tipo: 'dias', valor: 3 }, texto_titular: 'a' },
    { id: 'b', ordem: 2, nome: 'B', ancora: 'primeiro_atendimento', quando: { tipo: 'dias', valor: 0 }, texto_titular: 'b' },
    { id: 'c', ordem: 3, nome: 'C', ancora: 'primeiro_atendimento', quando: { tipo: 'proximo_expediente' }, texto_titular: 'c' },
  ];
  const fatos = { primeiroAtendimento: { inicio: sp('2026-09-21', '10:00'), fim: sp('2026-09-21', '11:00') } };
  const ms = R.calcularMensagens({ conta: ANUAL, etapas, fatos, horario: HORARIO });
  assert.equal(iso(porOrdem(ms, 1).dueAt), iso(sp('2026-09-21', '09:00')));
  assert.equal(iso(porOrdem(ms, 2).dueAt), iso(sp('2026-09-23', '09:00')), 'empurrada 48 h');
  assert.equal(iso(porOrdem(ms, 3).dueAt), iso(sp('2026-09-21', '11:00')), 'presa à aula: não se move');
});

test('R6: tolerância de 7 dias; véspera vence à meia-noite do dia da aula', () => {
  const ms = R.calcularMensagens({ conta: ANUAL, etapas: MODELO, fatos: AULAS, horario: HORARIO });
  const bv2 = porOrdem(ms, 2);
  assert.equal(R.situacaoAgora(bv2, sp('2026-09-21', '08:59')), 'futura');
  assert.equal(R.situacaoAgora(bv2, sp('2026-09-25', '10:00')), 'devida');
  assert.equal(R.situacaoAgora(bv2, sp('2026-09-28', '09:00')), 'vencida');
  const vespera = porOrdem(ms, 3, 1);
  assert.equal(R.situacaoAgora(vespera, sp('2026-09-23', '20:00')), 'devida');
  assert.equal(R.situacaoAgora(vespera, sp('2026-09-24', '00:00')), 'vencida', '"amanhã" já não seria verdade');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
test('validação: R4, R1, R3 e âncoras indisponíveis', () => {
  const um = [MODELO[0]];
  assert.ok(R.validarRegua(um, { variaveisLivres: ['link_ead'] }).erros.some((m) => m.includes('pelo menos 2')));

  // Tira as DUAS do início (a etapa 2, no dia 2, sozinha já cumpriria R1).
  const semAbertura = MODELO.map((e) => (e.ordem === 1 ? { ...e, quando: { tipo: 'dias', valor: 3 } }
    : e.ordem === 2 ? { ...e, quando: { tipo: 'dias', valor: 5 } } : e));
  assert.ok(R.validarRegua(semAbertura, { variaveisLivres: ['link_ead', 'link_pesquisa'] }).erros
    .some((m) => m.includes('em até 2 dias')));

  const colada = MODELO.map((e) => (e.ordem === 2 ? { ...e, quando: { tipo: 'dias', valor: 1 } } : e));
  assert.ok(R.validarRegua(colada, { variaveisLivres: ['link_ead', 'link_pesquisa'] }).erros
    .some((m) => m.includes('"Boas-vindas" e "Orientações iniciais"')));

  const semAgenda = R.validarRegua(MODELO, { ancorasDisponiveis: ['inicio_contrato'], variaveisLivres: ['link_ead', 'link_pesquisa'] });
  assert.ok(semAgenda.erros.some((m) => m.includes('"Lembrete da aula"') && m.includes('agenda')));
  assert.ok(semAgenda.erros.some((m) => m.includes('"Guia do Aluno"') && m.includes('presença')));

  const onze = Array.from({ length: 11 }, (_, i) => ({ ...MODELO[0], ordem: i + 1, nome: `E${i}`, quando: { tipo: 'dias', valor: i * 3 } }));
  assert.ok(R.validarRegua(onze, { variaveisLivres: ['link_ead'] }).erros.some((m) => m.includes('no máximo 10')));
});

test('validação: estrutura da etapa espelha os CHECKs da migration 123', () => {
  const base = { ordem: 1, nome: 'X', texto_titular: 'oi' };
  assert.ok(R.validarEtapa({ ...base, ancora: 'inicio_contrato', quando: { tipo: 'vespera' } })[0].includes('véspera'));
  assert.ok(R.validarEtapa({ ...base, ancora: 'inicio_contrato', quando: { tipo: 'proximo_expediente' } })[0].includes('depois de um atendimento'));
  assert.ok(R.validarEtapa({ ...base, ancora: 'primeiro_atendimento', quando: { tipo: 'dias', valor: 1 }, repeticoes: 2 })[0].includes('se repetir'));
  assert.ok(R.validarEtapa({ ...base, ancora: 'inicio_contrato', quando: { tipo: 'dias', valor: 61 } })[0].includes('entre 0 e 60'));
  assert.ok(R.validarEtapa({ ...base, texto_titular: '  ', ancora: 'inicio_contrato', quando: { tipo: 'dias', valor: 1 } })[0].includes('texto ou de um arquivo'));
  assert.deepEqual(R.validarEtapa({ ...base, texto_titular: null, anexo_id: 'arq', ancora: 'inicio_contrato', quando: { tipo: 'dias', valor: 1 } }), []);
  assert.deepEqual(R.validarEtapa({ ...base, texto_titular: null, entregue_por: 'externo', ancora: 'inicio_contrato', quando: { tipo: 'dias', valor: 30 } }), []);
});

test('validação: variáveis da unidade, alerta e anexo', () => {
  assert.deepEqual(R.validarVariaveisLivres({ link_ead: 'https://ead.exemplo.com' }), []);
  assert.ok(R.validarVariaveisLivres({ cliente: 'x' })[0].includes('preenchida pelo sistema'));
  assert.ok(R.validarVariaveisLivres({ 'Link EAD': 'x' })[0].includes('Nome de variável inválido'));

  assert.deepEqual(R.validarAlertaDias(21), []);
  assert.equal(R.validarAlertaDias(6).length, 1);
  assert.equal(R.validarAlertaDias(31).length, 1);

  assert.deepEqual(R.validarAnexo({ tipo: 'imagem', mime: 'image/png', tamanhoBytes: 300000 }), []);
  assert.deepEqual(R.validarAnexo({ tipo: 'documento', mime: 'application/pdf', tamanhoBytes: 2 * 1024 * 1024 }), []);
  assert.ok(R.validarAnexo({ tipo: 'imagem', mime: 'image/png', tamanhoBytes: 6 * 1024 * 1024 })[0].includes('limite do WhatsApp para imagem é 5 MB'));
  assert.ok(R.validarAnexo({ tipo: 'video', mime: 'video/quicktime', tamanhoBytes: 1000 })[0].includes('não é aceito'));
  assert.ok(R.validarAnexo({ tipo: 'gif', mime: 'image/gif', tamanhoBytes: 1 })[0].includes('Tipo de arquivo não aceito'));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
test('textos: interpolação da versão do responsável, com dia e horário da aula', () => {
  const lembrete = MODELO[2];
  const texto = R.interpolar(R.textoDaVersao(lembrete, 'responsavel'), {
    responsavel: 'Carla', cliente: 'Pedro', dia: R.formatarDia('2026-09-24'),
    horario: R.formatarHorario(sp('2026-09-24', '15:00')), profissional: 'Rafael',
  });
  assert.equal(texto.split('\n')[0],
    'Oi, Carla! 😊 Passando para lembrar que a aula do(a) Pedro será amanhã, quinta-feira, 24/09, às 15h, com o professor Rafael. 🎸');
  assert.equal(R.formatarHorario(sp('2026-09-24', '15:30')), '15h30');
  assert.equal(R.textoDaVersao(MODELO[1], 'responsavel'), MODELO[1].texto_titular, 'texto único vale para os dois');
});

test('textos: variável sem valor some, nunca vaza {chave} para o cliente', () => {
  assert.equal(R.interpolar('Oi, {cliente}!\nProfessor: {profissional}\nFim', { cliente: 'Ana' }), 'Oi, Ana!\nProfessor:\nFim');
});

test('R8: mensagem com dia, horário ou profissional não sai sem o dado', () => {
  const boasVindas = MODELO[0];
  const completo = { dia: 'quinta-feira, 24/09', horario: '15h', profissional: 'Rafael' };
  assert.equal(R.bloqueioDaMensagem({ etapa: boasVindas, versao: 'titular', valores: completo, telefone: '5519999990000' }), null);
  assert.equal(R.bloqueioDaMensagem({ etapa: boasVindas, versao: 'titular', valores: { ...completo, horario: '' }, telefone: '55' }), 'sem_horario');
  assert.equal(R.bloqueioDaMensagem({ etapa: boasVindas, versao: 'titular', valores: { ...completo, profissional: null }, telefone: '55' }), 'sem_profissional');
  assert.equal(R.bloqueioDaMensagem({ etapa: boasVindas, versao: 'titular', valores: completo, telefone: null }), 'sem_telefone');
  assert.equal(R.bloqueioDaMensagem({ etapa: MODELO[1], versao: 'titular', valores: {}, telefone: '55' }), null, 'orientações não citam aula');
  assert.equal(R.bloqueioDaMensagem({ etapa: { ...MODELO[4], anexo_id: 'pdf' }, versao: 'titular', telefone: '55', anexoDisponivel: false }), 'sem_anexo');
});

test('R10: como texto e anexo saem no WhatsApp', () => {
  assert.deepEqual(R.planoDeEnvio({ texto: 'oi' }), [{ kind: 'texto', texto: 'oi' }]);
  assert.deepEqual(R.planoDeEnvio({ texto: 'veja', anexo: { id: 'i', tipo: 'imagem' } }),
    [{ kind: 'arquivo', tipo: 'imagem', anexoId: 'i', legenda: 'veja' }]);
  const longo = 'x'.repeat(R.LIMITE_LEGENDA + 1);
  assert.deepEqual(R.planoDeEnvio({ texto: longo, anexo: { id: 'd', tipo: 'documento' } }).map((p) => p.kind), ['arquivo', 'texto']);
  assert.deepEqual(R.planoDeEnvio({ texto: 'ouça', anexo: { id: 'a', tipo: 'audio' } }),
    [{ kind: 'arquivo', tipo: 'audio', anexoId: 'a' }, { kind: 'texto', texto: 'ouça' }], 'áudio: arquivo primeiro, texto depois');
  assert.deepEqual(R.planoDeEnvio({ texto: '', anexo: { id: 'v', tipo: 'video' } }), [{ kind: 'arquivo', tipo: 'video', anexoId: 'v' }]);
});

test('destinatário: responsável quando outra pessoa paga; aluno quando ele mesmo paga', () => {
  const pedro = { personId: 'p1', nome: 'Pedro', telefone: '5519911110000' };
  const carla = { personId: 'p2', nome: 'Carla', telefone: '5519922220000' };
  assert.deepEqual(
    (({ versao, personId, telefone }) => ({ versao, personId, telefone }))(R.escolherDestinatario({ beneficiario: pedro, pagador: carla })),
    { versao: 'responsavel', personId: 'p2', telefone: '5519922220000' });
  assert.equal(R.escolherDestinatario({ beneficiario: pedro, pagador: pedro }).versao, 'titular');
  assert.equal(R.escolherDestinatario({ beneficiario: pedro }).telefone, '5519911110000');
  const semTelPagador = R.escolherDestinatario({ beneficiario: pedro, pagador: { ...carla, telefone: null } });
  assert.equal(semTelPagador.versao, 'responsavel', 'continua falando com a família');
  assert.equal(semTelPagador.telefone, '5519911110000', 'mas usa o telefone que existe');
  assert.equal(R.escolherDestinatario({ beneficiario: { ...pedro, telefone: null } }).telefone, null);
});

test('R7: irmãos na mesma etapa viram uma mensagem; etapas diferentes no mesmo dia, a outra espera', () => {
  const tel = '+55 (19) 99999-0000';
  const mesmaEtapa = [
    { chave: 'ana', telefone: tel, dueAt: sp('2026-09-18', '09:00'), etapaId: 'e1', ordem: 1 },
    { chave: 'bia', telefone: '5519999990000', dueAt: sp('2026-09-18', '10:00'), etapaId: 'e1', ordem: 1 },
  ];
  const r1 = R.umaPorFamilia(mesmaEtapa, { horario: HORARIO });
  assert.deepEqual(r1.manter.map((m) => m.chave), ['ana']);
  assert.deepEqual(r1.agrupadas.map((a) => [a.mensagem.chave, a.com]), [['bia', 'ana']]);

  const dias = [
    { chave: 'orient', telefone: tel, dueAt: sp('2026-09-23', '09:00'), etapaId: 'e2', ordem: 2 },
    { chave: 'lembrete', telefone: tel, dueAt: sp('2026-09-23', '18:00'), etapaId: 'e3', ordem: 3, presaAoAtendimento: true },
  ];
  const r2 = R.umaPorFamilia(dias, { horario: HORARIO });
  assert.deepEqual(r2.manter.map((m) => m.chave), ['lembrete'], 'o lembrete da aula não pode esperar');
  assert.equal(r2.adiadas[0].mensagem.chave, 'orient');
  assert.equal(iso(r2.adiadas[0].novoDueAt), iso(sp('2026-09-24', '09:00')));
});

test('R9 e alerta: só contratação nova; alerta de quem não começou no prazo da unidade', () => {
  assert.equal(R.ehContratacaoNova({ iniVigencia: '2026-09-18', outrosContratos: [] }), true);
  assert.equal(R.ehContratacaoNova({ iniVigencia: '2026-09-18', outrosContratos: [{ iniVigencia: '2025-09-18' }] }), false, 'renovação');
  assert.equal(R.ehContratacaoNova({ iniVigencia: '2026-09-18', outrosContratos: [{ iniVigencia: '2026-09-18' }] }), true, 'dois cursos na mesma matrícula');

  assert.equal(R.precisaAlertaSemInicio({ iniVigencia: '2026-09-18', hoje: '2026-10-08' }), false, '20 dias');
  assert.equal(R.precisaAlertaSemInicio({ iniVigencia: '2026-09-18', hoje: '2026-10-09' }), true, '21 dias (padrão)');
  assert.equal(R.precisaAlertaSemInicio({ iniVigencia: '2026-09-18', hoje: '2026-10-09', alertaDias: 30 }), false, 'unidade configurou 30');
  assert.equal(R.precisaAlertaSemInicio({ iniVigencia: '2026-09-18', hoje: '2026-12-01', primeiroAtendimento: { inicio: 1 } }), false);
});
