'use strict';
// plataforma.test.js — decisões PURAS do núcleo de plataforma e da fila (sem banco):
// licença, cota, rodízio e caminho de mídia. O que aqui passa é regra; o que depende de
// RLS de verdade está em test/isolamento-tenant.itest.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const licenca = require('../src/plataforma/licenca');
const credenciais = require('../src/plataforma/credenciais');
const consumo = require('../src/plataforma/consumo');
const midia = require('../src/marketing/midia');
const fila = require('../src/marketing/fila');

const T_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AGORA = new Date('2026-09-20T12:00:00Z');

// ── licença (o que substitui a flag de ambiente) ───────────────────────────────────────

test('licença: quem tem acesso e quem não tem', () => {
  const d = (linha) => licenca._decidir(linha, AGORA);
  assert.deepEqual(d(null), { permitido: false, motivo: 'sem_contratacao' });
  assert.equal(d({ situacao: 'ativa', expira_em: null }).permitido, true);
  assert.equal(d({ situacao: 'teste', expira_em: '2026-09-30T00:00:00Z' }).permitido, true);
  assert.equal(d({ situacao: 'teste', expira_em: '2026-09-01T00:00:00Z' }).permitido, false);
  assert.equal(d({ situacao: 'suspensa', expira_em: null }).permitido, false);
  assert.equal(d({ situacao: 'cancelada', expira_em: null }).permitido, false);
  // vencimento no instante exato = vencido (a régua é estrita, não "até o fim do dia")
  assert.equal(d({ situacao: 'ativa', expira_em: AGORA }).permitido, false);
  assert.equal(d({ situacao: 'suspensa', expira_em: null }).motivo, 'situacao_suspensa');
  assert.equal(d({ situacao: 'ativa', expira_em: '2026-09-01' }).motivo, 'contratacao_vencida');
});

test('licença: suspender é instantâneo e não depende de redeploy', () => {
  const linha = { situacao: 'ativa', expira_em: null };
  assert.equal(licenca._decidir(linha, AGORA).permitido, true);
  assert.equal(licenca._decidir({ ...linha, situacao: 'suspensa' }, AGORA).permitido, false);
  // a lista de estados com acesso é fechada: inventar um estado não abre a porta
  assert.equal(licenca._decidir({ situacao: 'ativada', expira_em: null }, AGORA).permitido, false);
  assert.equal(licenca._decidir({ situacao: 'ATIVO', expira_em: null }, AGORA).permitido, false);
});

// ── cota ───────────────────────────────────────────────────────────────────────────────

test('cota: ausente é sem limite; alcançar o limite já barra', () => {
  assert.equal(fila._excedeCota({}, { tarefas: 9999 }), null);
  assert.equal(fila._excedeCota(null, { tarefas: 1 }), null);
  assert.equal(fila._excedeCota({ tarefas_mes: 100 }, { tarefas: 99 }), null);
  assert.deepEqual(fila._excedeCota({ tarefas_mes: 100 }, { tarefas: 100 }), { cota: 'tarefas_mes', limite: 100, usado: 100 });
  assert.deepEqual(fila._excedeCota({ tarefas_mes: 100 }, { tarefas: 140 }), { cota: 'tarefas_mes', limite: 100, usado: 140 });
  // cota de consumo casa com o tipo medido
  assert.deepEqual(fila._excedeCota({ ia_visao_mes: 10 }, { ia_visao: 10 }), { cota: 'ia_visao_mes', limite: 10, usado: 10 });
  assert.equal(fila._excedeCota({ ia_visao_mes: 10 }, { ia_texto: 999 }), null);
  // chave desconhecida ou valor sem sentido não vira bloqueio acidental
  assert.equal(fila._excedeCota({ cota_inventada: 1 }, { tarefas: 50 }), null);
  assert.equal(fila._excedeCota({ tarefas_mes: 'muitos' }, { tarefas: 50 }), null);
  assert.equal(fila._excedeCota({ tarefas_mes: 0 }, { tarefas: 0 }).limite, 0, 'plano com zero não processa nada');
});

test('cota: toda cota conhecida aponta para um tipo medido de verdade', () => {
  for (const [chave, tipo] of Object.entries(fila.COTAS)) {
    assert.ok(tipo === 'tarefas' || consumo.TIPOS_VALIDOS.has(tipo), `${chave} aponta para tipo inexistente`);
  }
  // e todo tipo medido tem custo padrão — tipo sem preço vira fatura que não fecha
  for (const tipo of consumo.TIPOS_VALIDOS) {
    assert.equal(typeof consumo.CUSTO_PADRAO_BRL[tipo], 'number', `${tipo} sem custo padrão`);
  }
});

// ── rodízio ────────────────────────────────────────────────────────────────────────────

test('rodízio: quem nunca foi atendido passa na frente de quem acabou de ser', () => {
  const ordem = fila._ordemRodizio([
    { tenant_id: T_A, pendentes: 500, ultima_vez: '2026-09-20T11:59:00Z' },
    { tenant_id: T_B, pendentes: 1, ultima_vez: null },
  ]).map((x) => x.tenant_id);
  assert.deepEqual(ordem, [T_B, T_A], 'a unidade com 1 peça não espera as 500 da outra');
});

test('rodízio: entre atendidas, a mais antiga primeiro (e empate é determinístico)', () => {
  const ordem = fila._ordemRodizio([
    { tenant_id: 'c', ultima_vez: '2026-09-20T10:00:00Z' },
    { tenant_id: 'a', ultima_vez: '2026-09-20T09:00:00Z' },
    { tenant_id: 'b', ultima_vez: '2026-09-20T09:00:00Z' },
  ]).map((x) => x.tenant_id);
  assert.deepEqual(ordem, ['a', 'b', 'c']);
  assert.deepEqual(fila._ordemRodizio([]), []);
  assert.deepEqual(fila._ordemRodizio(null), []);
});

test('rodízio: a fila grande de uma unidade nunca monopoliza o worker', () => {
  // simula 6 atendimentos seguidos: A tem 100 pendentes, B tem 100. Alternam.
  let relogio = Date.parse('2026-09-20T12:00:00Z');
  const estado = { [T_A]: null, [T_B]: null };
  const atendidos = [];
  for (let i = 0; i < 6; i++) {
    const proximo = fila._ordemRodizio([
      { tenant_id: T_A, pendentes: 100, ultima_vez: estado[T_A] },
      { tenant_id: T_B, pendentes: 100, ultima_vez: estado[T_B] },
    ])[0].tenant_id;
    estado[proximo] = new Date((relogio += 1000)).toISOString();
    atendidos.push(proximo);
  }
  assert.deepEqual(atendidos, [T_A, T_B, T_A, T_B, T_A, T_B]);
});

// ── caminho de mídia (travessia de diretório) ──────────────────────────────────────────

test('mídia: o caminho sai do tenant, não do nome que veio de fora', () => {
  const p = midia.caminhoMidia(T_A, 'post.png');
  assert.equal(p, `/srv/adr-media/${T_A}/post.png`);
  assert.ok(midia.dentroDaRaiz(T_A, p));
});

test('mídia: travessia de diretório não escapa da pasta da unidade', () => {
  const ataques = [
    '../../etc/passwd',
    '..\\..\\windows\\system32\\config',
    `../${T_B}/segredo.png`,
    '....//....//etc/shadow',
    '/etc/passwd',
    'subpasta/../../fora.png',
    '.',
    '..',
    '.env',
  ];
  for (const nome of ataques) {
    const p = midia.caminhoMidia(T_A, nome);
    assert.ok(p.startsWith(`/srv/adr-media/${T_A}/`), `escapou: ${nome} -> ${p}`);
    assert.ok(!p.includes('..'), `sobrou travessia: ${nome} -> ${p}`);
    assert.ok(midia.dentroDaRaiz(T_A, p));
    assert.equal(midia.dentroDaRaiz(T_B, p), false, 'o caminho de A nunca é aceito como de B');
  }
});

test('mídia: subpasta também é sanitizada, e tenant inválido não vira caminho', () => {
  const p = midia.caminhoMidia(T_A, 'x.png', { subpasta: '../../..' });
  assert.ok(p.startsWith(`/srv/adr-media/${T_A}/`), p);
  for (const ruim of ['', null, 'nao-e-uuid', '../..', `${T_A}/../${T_B}`]) {
    assert.throws(() => midia.caminhoMidia(ruim, 'x.png'), /tenant inválido/);
    assert.equal(midia.dentroDaRaiz(ruim, `/srv/adr-media/${T_A}/x.png`), false);
  }
});

test('mídia: nome vazio ou exótico vira nome utilizável, nunca vazio', () => {
  assert.match(midia.nomeSeguro(''), /^[a-f0-9]{16}$/);
  assert.match(midia.nomeSeguro('  '), /^_$|^[a-f0-9]{16}$/);
  assert.equal(midia.nomeSeguro('Aula de Violão 2026.png'), 'Aula_de_Viola_o_2026.png');
  assert.equal(midia.nomeSeguro('../../x.png'), 'x.png');
  for (const ruim of ['..', '.', '...', './.']) {
    const n = midia.nomeSeguro(ruim);
    assert.ok(n && !n.includes('..') && n !== '.', `nome inseguro devolvido para ${JSON.stringify(ruim)}: ${n}`);
  }
});

// ── cache de credencial ────────────────────────────────────────────────────────────────

test('credencial: o cache é chaveado por tenant e invalida só o dono', () => {
  credenciais.invalidar();
  credenciais._cache.set(`${T_A}|gemini|api_key`, { valor: 'A', expiraEm: Date.now() + 60_000 });
  credenciais._cache.set(`${T_B}|gemini|api_key`, { valor: 'B', expiraEm: Date.now() + 60_000 });
  credenciais.invalidar(T_A);
  assert.equal(credenciais._cache.has(`${T_A}|gemini|api_key`), false);
  assert.equal(credenciais._cache.get(`${T_B}|gemini|api_key`).valor, 'B', 'invalidar A não pode derrubar B');
  credenciais.invalidar();
  assert.equal(credenciais._cache.size, 0);
});

test('credencial: sem a chave de cifra da infra, falha alto — não devolve vazio', async () => {
  const antes = process.env.LM_ENCRYPTION_KEY;
  delete process.env.LM_ENCRYPTION_KEY;
  credenciais.invalidar();
  try {
    await assert.rejects(() => credenciais.lerCredencial(T_A, 'gemini', 'api_key'),
      /LM_ENCRYPTION_KEY ausente/);
  } finally {
    if (antes !== undefined) process.env.LM_ENCRYPTION_KEY = antes;
  }
});

test('consumo: tipo desconhecido não vira linha de cobrança', async () => {
  assert.equal(await consumo.registrarUso(T_A, 'MARKETING', 'tipo_que_nao_existe', 1), false);
  assert.equal(await consumo.registrarUso(null, 'MARKETING', consumo.TIPOS.IA_TEXTO, 1), false);
  assert.equal(await consumo.registrarUso(T_A, 'MARKETING', consumo.TIPOS.IA_TEXTO, -5), false);
});
