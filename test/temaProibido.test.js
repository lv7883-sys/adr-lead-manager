'use strict';
// temaProibido.test.js — assuntos que só a recepção responde (sem DB).
// Os casos de SAÍDA são respostas REAIS que a Janis mandou sozinha em ago–set/2026 e não podia.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectarEntrada, detectarSaida, regrasDoTenant, bloqueio, mensagemEncaminhamento } = require('../src/temaProibido');

const ligado = regrasDoTenant({});   // padrão = todas as travas ligadas
const temaDe = (msg) => { const b = bloqueio(detectarEntrada(msg), ligado); return b && b.tema; };

test('entrada: AGENDA vai para a recepção', () => {
  for (const msg of [
    'Bom dia! Tudo bem? Amanhã a aula da Valentina será às 12:00?',   // o caso de 11/09
    'Preciso remarcar minha aula de guitarra',
    'Quero agendar uma aula experimental',
    'Que horas é a aula do Pedro?',
    'Hoje não vou conseguir ir na aula',
    'Posso repor a aula de ontem?',                                     // reposição
    'Vai ter aula no feriado?',
    'Consegue antecipar pra 17h?',
  ]) assert.equal(temaDe(msg), 'agenda', msg);
});

test('entrada: VALORES vão para a recepção', () => {
  for (const msg of [
    'Quanto custa a aula de bateria?', 'Qual o valor da mensalidade?', 'Me manda o pix por favor',
    'Segue o comprovante', 'Tem desconto pra irmãos?', 'Vocês parcelam no cartão?',
    'Bom dia Renovação paga',
  ]) assert.equal(temaDe(msg), 'valores', msg);
});

test('entrada: CONTRATO, JURÍDICO, RECLAMAÇÃO e CRÍTICO vão para a recepção', () => {
  const casos = [
    ['Quero cancelar o contrato', 'contrato'],
    ['Como faço pra trancar a matrícula?', 'contrato'],
    ['Qual a multa se eu sair antes?', 'contrato'],
    ['Vou falar com meu advogado', 'juridico'],
    ['Isso é contra o código de defesa do consumidor', 'juridico'],
    ['Vou registrar no Procon', 'juridico'],
    ['Estou muito insatisfeita com o atendimento', 'reclamacao'],
    ['Ninguém me responde, que absurdo', 'reclamacao'],
    ['Meu filho se machucou na aula', 'critico'],
    ['É urgente, me liguem', 'critico'],
  ];
  for (const [msg, tema] of casos) assert.equal(temaDe(msg), tema, msg);
});

test('entrada: conversa comum NÃO trava (senão a assistente vira um aviso fixo à toa)', () => {
  for (const msg of [
    'Bom dia, tudo bem?',                               // "dia" sozinho não é agenda
    'Boa noite!',
    'Obrigada!',
    'Quero aprender guitarra, vocês têm professor?',
    'Quero aprender a tocar direito',                   // "direito" de lead não é jurídico
    'Qual o endereço da escola?',
    'Qual marca de guitarra vocês indicam?',            // "marca" não é "marcar"
    'Meu filho tem 8 anos, pode fazer?',
  ]) assert.equal(temaDe(msg), null, msg);
});

test('saída: as respostas reais que a Janis NÃO podia ter mandado são barradas', () => {
  for (const r of [
    'Oii, Eliana! Bom dia, tudo bem por aqui! A aula da Valentina amanhã está confirmada para às 11h, como combinamos. 😊',
    'Perfeito, Fê! Recebemos o comprovante. A aula experimental do Oliver com o Cláudio está confirmada para esta quarta',
    'Bom dia, Rafa! Entendi que você precisa remarcar sua aula de guitarra para hoje, das 19h30 às 20h30.',
    'Perfeito, Juliana! Recebemos os dados. A aula experimental para o Victor, de musicalização, está agendada para o dia 2',
    'Combinado, Luís! As duas aulas experimentais estão confirmadas.',
  ]) assert.equal(bloqueio(detectarSaida(r, { permitidos: ['hoje às 9h'] }), ligado).tema, 'agenda', r);
  // 13/08: a IA reproduziu a mensagem de boleto de uma recepcionista
  assert.equal(bloqueio(detectarSaida('Obrigada, Marcio! Segue o boleto referente ao mês de setembro'), ligado).tema, 'valores');
  assert.equal(bloqueio(detectarSaida('Pode cancelar quando quiser, sem multa!'), ligado).tema, 'contrato');
});

test('saída: a frase de retorno calculada pelo sistema e os desvios corretos PASSAM', () => {
  const casos = [
    ['Oi, Eliana! Recebi sua mensagem 🙌 A recepção te responde hoje às 9h.', 'hoje às 9h'],
    ['Que legal seu interesse em canto! A recepção confirma os detalhes na segunda-feira às 9h.', 'na segunda-feira às 9h'],
    ['A recepção confirma sua aula experimental amanhã às 9h, tá?', 'amanhã às 9h'],
    ['Nosso endereço é Rua das Flores, 123 — Centro.', 'hoje às 9h'],
  ];
  for (const [r, p] of casos) assert.equal(bloqueio(detectarSaida(r, { permitidos: [p] }), ligado), null, r);
});

test('saída: hora de AULA que coincide com a de abertura continua barrada', () => {
  // a IA "encaixando" a aula no horário de abertura: tirar a frase de retorno não pode liberar
  assert.ok(detectarSaida('Sua aula está marcada para amanhã às 9h!', { permitidos: ['amanhã às 9h'] }).agenda);
});

test('travas: agenda/valores são da unidade; as outras valem para todas', () => {
  const det = { agenda: '12:00', valores: 'pix' };
  assert.equal(bloqueio(det, ligado).tema, 'agenda');
  const nulo = regrasDoTenant({ agendamento_sempre_manual: null, proposta_sempre_manual: null });
  assert.equal(nulo.agenda, true, 'nulo = ligado'); assert.equal(nulo.valores, true);
  assert.equal(bloqueio(det, regrasDoTenant({ agendamento_sempre_manual: false })).tema, 'valores');
  const livre = regrasDoTenant({ agendamento_sempre_manual: false, proposta_sempre_manual: false });
  assert.equal(bloqueio(det, livre), null);
  // a unidade desligar agenda/valores NÃO libera jurídico/reclamação/contrato/crítico
  assert.equal(bloqueio(detectarEntrada('Quero cancelar o contrato'), livre).tema, 'contrato');
  assert.equal(bloqueio(detectarEntrada('Vou no Procon'), livre).tema, 'juridico');
});

test('aviso fixo: nome da escola da unidade + hora de retorno, sem afirmar nada', () => {
  const m = mensagemEncaminhamento({ nome: 'Eliana', escola: 'Escola Exemplo', proxima: 'hoje às 9h' });
  assert.equal(m, 'Oi, Eliana! Recebemos sua mensagem 🙌 Isso vai ser avaliado pela equipe da Escola Exemplo durante o horário de atendimento — voltamos hoje às 9h.');
  assert.equal(mensagemEncaminhamento({}), 'Oi! Recebemos sua mensagem 🙌 Isso vai ser avaliado pela nossa equipe durante o horário de atendimento.');
  // o próprio aviso nunca pode tropeçar na trava de saída
  assert.equal(bloqueio(detectarSaida(m, { permitidos: ['hoje às 9h'] }), ligado), null);
});
