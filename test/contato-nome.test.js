'use strict';
//
// contato-nome.test.js — a ORDEM do nome exibido, e o badge do aluno.
//
// O defeito que este teste existe para impedir tem nome e data: em 05/10/2026 o Leo descobriu que a
// Caixa de Entrada mostrava o nome que a PRÓPRIA PESSOA pôs no WhatsApp dela (pushName), e a unidade
// não tinha onde dizer como ELA chama aquele contato. A correção foi um degrau NOVO no topo (a
// agenda, migr 184) — não a inversão dos degraus que já existiam.
//
// ⚠ O caso (b) é o que protege a decisão antiga: pushName ACIMA do cadastro é de propósito, porque o
// cadastro traz o nome do ALUNO e quem fala no WhatsApp é o pai/responsável. Quem "arrumar" a ordem
// trocando esses dois quebra aqui, e o nome do teste diz por quê.
//
const { test } = require('node:test');
const assert = require('node:assert/strict');
const n = require('../src/contato-nome');

test('(a) a AGENDA da unidade ganha de todo o resto — decisão do Leo: "o nome do Regente manda"', () => {
  const r = n.nomeContato({
    agenda: 'Mãe do Pedro (violão sáb)', push: 'Ju 💜', cadastro: 'Pedro Alves', lead: 'Pedro', numero: '5519999990000',
  });
  assert.equal(r.nome, 'Mãe do Pedro (violão sáb)');
  assert.equal(r.via, 'agenda');
});

test('(b) sem agenda, o pushName ganha do CADASTRO — e isto é deliberado (contato = responsável, cadastro = aluno)', () => {
  const r = n.nomeContato({ push: 'Juliana', cadastro: 'Pedro Alves', lead: 'Pedro', numero: '5519999990000' });
  assert.equal(r.nome, 'Juliana', 'inverter estes dois reintroduz o defeito de mostrar o nome do ALUNO no lugar do responsável');
  assert.equal(r.via, 'push');
});

test('(c) sem agenda e sem pushName, cai no cadastro; sem cadastro, no lead; sem nada, no número', () => {
  assert.equal(n.nomeContato({ cadastro: 'Pedro Alves', lead: 'Pedro', numero: '55199' }).nome, 'Pedro Alves');
  assert.equal(n.nomeContato({ lead: 'Pedro', numero: '55199' }).nome, 'Pedro');
  assert.equal(n.nomeContato({ numero: '5519999990000' }).nome, '5519999990000');
  assert.equal(n.nomeContato({ numero: '5519999990000' }).via, 'numero');
});

test('(d) campo em BRANCO não conta como nome — espaço em branco mostraria uma conversa sem nome', () => {
  const r = n.nomeContato({ agenda: '   ', push: '', cadastro: null, lead: 'Pedro', numero: '55199' });
  assert.equal(r.nome, 'Pedro');
  assert.equal(r.via, 'lead');
});

test('(e) o badge do aluno aparece só quando DIFERE do nome exibido', () => {
  // contato é o responsável (agenda), aluno é o filho → badge aparece
  assert.equal(n.alunoBadge({ agenda: 'Mãe do Pedro', cadastro: 'Pedro Alves', numero: '55199' }), 'Pedro Alves');
  // nome exibido JÁ É o do cadastro → badge seria uma repetição
  assert.equal(n.alunoBadge({ cadastro: 'Pedro Alves', numero: '55199' }), null);
  // diferença só de caixa/espaço não é diferença para quem lê a tela
  assert.equal(n.alunoBadge({ agenda: 'pedro alves ', cadastro: 'Pedro Alves', numero: '55199' }), null);
  // sem cadastro e sem lead não há badge
  assert.equal(n.alunoBadge({ agenda: 'Mãe do Pedro', numero: '55199' }), null);
});

test('(f) nomeContatoSql respeita a ORDEM canônica e omite degrau ausente', () => {
  const sql = n.nomeContatoSql({ agenda: 'ag.nome', push: 'PUSH', cadastro: 'pe.display_name', lead: 'lk.name', numero: 'cv.external_id' });
  assert.equal(sql, 'COALESCE(ag.nome, PUSH, pe.display_name, lk.name, cv.external_id)');
  // a ordem do objeto não manda — a ordem é a da régua
  const fora = n.nomeContatoSql({ numero: 'cv.external_id', agenda: 'ag.nome' });
  assert.equal(fora, 'COALESCE(ag.nome, cv.external_id)');
  // um degrau só não precisa de COALESCE (e COALESCE de 1 argumento é erro de sintaxe no Postgres)
  assert.equal(n.nomeContatoSql({ numero: 'cv.external_id' }), 'cv.external_id');
  assert.throws(() => n.nomeContatoSql({}), /nenhum degrau/);
});

test('(h) BUSCAR olha TODOS os nomes — salvar um nome novo não pode esconder a conversa do nome antigo', () => {
  // O caso que gerou este teste, medido em produção em 05/10/2026: a conversa cujo pushName era
  // "Deborah Maria Oliveira" foi salva na agenda como "Deborah" e desapareceu da busca por "maria".
  // Exibir escolhe UM nome; buscar aceita QUALQUER um. Se alguém trocar o alvo da busca de volta
  // para nomeContatoSql, este teste quebra.
  const alvo = n.todosOsNomesSql({ agenda: 'ag.nome', push: 'PUSH', cadastro: 'pe.display_name', lead: 'lk.name' });
  assert.equal(alvo, "concat_ws(' | ', ag.nome, PUSH, pe.display_name, lk.name)");
  assert.notEqual(alvo, n.nomeContatoSql({ agenda: 'ag.nome', push: 'PUSH', cadastro: 'pe.display_name', lead: 'lk.name' }),
    'o alvo da BUSCA não pode ser o COALESCE da exibição — é o que escondeu a conversa da Deborah');
  // o NÚMERO fica fora: na busca ele tem alvo próprio (só dígitos), e entrar aqui faria o termo
  // casar pedaço de telefone dentro do texto do nome.
  assert.ok(!n.todosOsNomesSql({ agenda: 'ag.nome', numero: 'cv.external_id' }).includes('external_id'));
  assert.throws(() => n.todosOsNomesSql({ numero: 'cv.external_id' }), /nenhum degrau/);
});

test('(g) a ORDEM é a mesma lista para JS e SQL — uma régua, não duas', () => {
  assert.deepEqual(n.ORDEM, ['agenda', 'push', 'cadastro', 'lead', 'numero']);
  // o COALESCE segue exatamente ORDEM: se alguém reordenar a lista, o SQL acompanha sozinho
  const sql = n.nomeContatoSql(Object.fromEntries(n.ORDEM.map((d) => [d, d.toUpperCase()])));
  assert.equal(sql, 'COALESCE(' + n.ORDEM.map((d) => d.toUpperCase()).join(', ') + ')');
});
