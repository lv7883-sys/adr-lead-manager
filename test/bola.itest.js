'use strict';
//
// bola.itest.js — A RÉGUA DE "DE QUEM É A BOLA" RESPONDE IGUAL EM JS E EM SQL.
//
// O defeito que este teste existe para impedir não é um cálculo errado: é a MESMA pergunta
// respondida em lugares diferentes com regras que foram divergindo. Em 22/09/2026 havia quatro
// implementações de "de quem é a bola" no Lead Manager, e uma delas comparava o veredito da IA
// contra a ENTRADA do cliente enquanto as outras comparavam contra a SAÍDA nossa — duas perguntas
// diferentes no mesmo campo. Cada uma tinha um comentário dizendo "mesma régua de antes".
//
// Então o teste central aqui é de PARIDADE: a forma JS e a forma SQL varrem a mesma matriz de
// entradas e precisam devolver a mesma resposta em todas. Se alguém mexer numa e esquecer a outra,
// isto quebra — que é a única defesa real contra a divergência voltar.
//
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const bola = require('../src/bola');

let c;
before(async () => { c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); });
after(async () => { await c.end(); });

const BASE = Date.parse('2026-09-10T12:00:00Z');
const H = (h) => (h == null ? null : new Date(BASE + h * 3600e3));   // horas a partir de uma âncora fixa
const ISO = (d) => (d == null ? null : d.toISOString());

// A mesma régua, rodada pelo Postgres.
async function pelaSql(l) {
  const sql = bola.bolaSql({
    estado: '$1::text', stateAt: '$2::timestamptz',
    lastInTurno: '$3::timestamptz', lastOut: '$4::timestamptz',
  });
  return (await c.query(`SELECT ${sql} AS bola`,
    [l.conversation_state, ISO(l.state_computed_at), ISO(l.last_in_turno), ISO(l.last_out)])).rows[0].bola;
}

test('PARIDADE: JS e SQL respondem igual em toda a matriz de situações', async () => {
  const estados = [null, 'AGUARDANDO_RECEPCAO', 'AGUARDANDO_CLIENTE', 'RESOLVIDO', 'INDEFINIDO', 'COISA_NOVA'];
  const horas = [null, -10, 0, 10];
  const casos = [];
  for (const conversation_state of estados) {
    for (const st of horas) {
      for (const li of horas) {
        for (const lo of horas) {
          casos.push({ conversation_state, state_computed_at: H(st), last_in_turno: H(li), last_out: H(lo) });
        }
      }
    }
  }
  const divergencias = [];
  for (const caso of casos) {
    const js = bola.deQuemEhABola(caso).bola;
    const sql = await pelaSql(caso);
    if (js !== sql) {
      divergencias.push(`${caso.conversation_state}|st=${ISO(caso.state_computed_at)}|in=${ISO(caso.last_in_turno)}|out=${ISO(caso.last_out)} → js=${js} sql=${sql}`);
    }
  }
  assert.deepEqual(divergencias, [], `${divergencias.length} de ${casos.length} divergiram:\n` + divergencias.slice(0, 8).join('\n'));
});

test('o cliente falar DEPOIS do veredito vence o veredito', () => {
  // a IA disse "aguardando cliente" e ele voltou: a bola é nossa, mesmo com o estado dizendo o contrário.
  const r = bola.deQuemEhABola({
    conversation_state: 'AGUARDANDO_CLIENTE', state_computed_at: H(0), last_in_turno: H(5), last_out: H(-2),
  });
  assert.equal(r.bola, bola.NOSSA);
  assert.equal(r.via, 'fatos', 'o veredito foi descartado e quem decidiu foram os fatos');
  assert.equal(r.desde, H(5).getTime(), 'o relógio conta desde a mensagem dele, não desde o carimbo');
});

test('nós respondermos depois derruba "devemos resposta" — e SÓ ele', () => {
  const pago = bola.deQuemEhABola({
    conversation_state: 'AGUARDANDO_RECEPCAO', state_computed_at: H(0), last_in_turno: H(-1), last_out: H(3),
  });
  assert.equal(pago.bola, bola.CLIENTE, 'respondemos: a dívida foi paga');
  // insistir com quem já tem a bola NÃO devolve a bola para nós
  const insistiu = bola.deQuemEhABola({
    conversation_state: 'AGUARDANDO_CLIENTE', state_computed_at: H(0), last_in_turno: H(-1), last_out: H(3),
  });
  assert.equal(insistiu.bola, bola.CLIENTE);
  assert.equal(insistiu.via, 'estado');
});

test('empate conta como "nada aconteceu depois" (viés conservador)', () => {
  const r = bola.deQuemEhABola({
    conversation_state: 'AGUARDANDO_RECEPCAO', state_computed_at: H(0), last_in_turno: H(0), last_out: H(0),
  });
  assert.equal(r.bola, bola.NOSSA, 'na dúvida, a bola fica onde o veredito disse');
});

test('sem veredito nenhum, decide quem falou por último', () => {
  assert.equal(bola.deQuemEhABola({ last_in_turno: H(2), last_out: H(1) }).bola, bola.NOSSA);
  assert.equal(bola.deQuemEhABola({ last_in_turno: H(1), last_out: H(2) }).bola, bola.CLIENTE);
});

test('quem nunca trocou mensagem é INDEFINIDA — nunca "devemos resposta"', () => {
  const r = bola.deQuemEhABola({ created_at: H(-100) });
  assert.equal(r.bola, bola.INDEFINIDA);
  assert.equal(r.desde, H(-100).getTime(), 'o relógio começa no cadastro');
  assert.equal(bola.devemosResposta({ created_at: H(-100) }), false);
});

test('estado desconhecido não vira "nossa" por acidente — cai nos fatos', async () => {
  const caso = { conversation_state: 'COISA_NOVA', state_computed_at: H(0), last_in_turno: H(-1), last_out: H(5) };
  assert.equal(bola.deQuemEhABola(caso).bola, bola.CLIENTE);
  assert.equal(await pelaSql(caso), bola.CLIENTE);
});

test('o veredito RESOLVIDO sobrevive a insistirmos, e morre quando o cliente volta', () => {
  assert.equal(bola.deQuemEhABola({
    conversation_state: 'RESOLVIDO', state_computed_at: H(0), last_in_turno: H(-3), last_out: H(4),
  }).bola, bola.RESOLVIDO);
  assert.equal(bola.deQuemEhABola({
    conversation_state: 'RESOLVIDO', state_computed_at: H(0), last_in_turno: H(4), last_out: H(-3),
  }).bola, bola.NOSSA, 'cliente reabriu a conversa');
});

test('bolaSql exige os agregados do chamador (não inventa nome de coluna)', () => {
  assert.throws(() => bola.bolaSql({}), /lastInTurno e lastOut/);
});

test('GUARDA: ninguém reimplementa a régua por fora', () => {
  // A defesa que faltava. Cada uma das quatro cópias nasceu de alguém escrevendo "a condição" de
  // novo, no arquivo onde estava trabalhando — e sempre com a melhor das intenções, inclusive
  // comentando que era "a mesma régua". Este teste procura a ASSINATURA dessa reimplementação.
  const fs = require('node:fs');
  const path = require('node:path');
  const raiz = path.join(__dirname, '..', 'src');
  const arquivos = [];
  (function varrer(dir) {
    for (const nome of fs.readdirSync(dir)) {
      const p = path.join(dir, nome);
      if (fs.statSync(p).isDirectory()) varrer(p);
      else if (nome.endsWith('.js')) arquivos.push(p);
    }
  })(raiz);

  const assinaturas = [
    // comparar o carimbo do veredito com a saída/entrada fora da régua
    /conversation_state\s*(===?|=)\s*'AGUARDANDO_RECEPCAO'[\s\S]{0,200}?state_computed_at/,
    /state_computed_at[\s\S]{0,120}?(last_out|lastOut|lout)\s*>/,
    /saidaPosteriorAoEstado|stateFresh|esperandoNos\s*=\s*\(/,
  ];
  const culpados = [];
  for (const f of arquivos) {
    const rel = path.relative(raiz, f).replace(/\\/g, '/');
    if (rel === 'bola.js') continue;                       // a régua pode falar dela mesma
    const linhas = fs.readFileSync(f, 'utf8').split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));       // comentário citando o histórico é permitido
    const corpo = linhas.join('\n');
    for (const re of assinaturas) if (re.test(corpo)) { culpados.push(rel); break; }
  }
  assert.deepEqual([...new Set(culpados)], [],
    'a régua de "de quem é a bola" tem que vir de src/bola.js: ' + culpados.join(', '));
});
