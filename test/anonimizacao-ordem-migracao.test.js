'use strict';
// anonimizacao-ordem-migracao.test.js — a exclusão de dados (LGPD) não pode depender da
// ordem entre publicar código e aplicar migração.
//
// Sem isto, publicar antes de aplicar a 171 quebraria /forget e a retenção INTEIRAS, por
// causa de uma tabela que ainda não existe. A ordem correta continua sendo migração
// primeiro — a guarda existe para o dia em que alguém inverter, ou em que um rollback
// deixar código novo com banco antigo.
//
// Sem banco: o `client` é injetado, então dá para simular o Postgres respondendo
// "relation does not exist" (SQLSTATE 42P01) e conferir o que a função faz.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { anonymizeLead } = require('../src/anonymize');

const ARGS = {
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leadId: '11111111-1111-4111-8111-111111111111',
  phone: '5519990000001',
  actor: 'teste',
};

// Um Postgres de mentira: registra o que foi pedido e deixa o teste escolher o que falha.
function clienteFalso({ falharEm = null, erro = null } = {}) {
  const sqls = [];
  return {
    sqls,
    query: async (sql) => {
      sqls.push(sql);
      if (falharEm && sql.includes(falharEm)) throw erro;
      return { rowCount: 1, rows: [] };
    },
  };
}

const erroPg = (code, message) => Object.assign(new Error(message), { code });

test('migração 171 ausente: a exclusão do resto ACONTECE e avisa no log', async () => {
  const c = clienteFalso({
    falharEm: 'UPDATE origem_lead',
    erro: erroPg('42P01', 'relation "origem_lead" does not exist'),
  });
  await anonymizeLead(c, ARGS);   // não pode lançar

  // o essencial foi feito mesmo sem a tabela nova
  assert.ok(c.sqls.some((s) => s.includes('UPDATE messages')), 'mensagens não foram anonimizadas');
  assert.ok(c.sqls.some((s) => s.includes('UPDATE conversations')), 'conversa não foi anonimizada');
  assert.ok(c.sqls.some((s) => s.includes('UPDATE leads')), 'o lead não foi anonimizado');
  assert.ok(c.sqls.some((s) => s.includes('audit_log')), 'a trilha de auditoria não foi gravada');
});

test('qualquer OUTRO erro na origem PROPAGA — dado pessoal não pode ficar para trás calado', async () => {
  for (const [code, msg] of [
    ['42501', 'permission denied for table origem_lead'],
    ['P0001', 'origem_lead é imutável'],
    ['23505', 'duplicate key'],
    [undefined, 'conexão caiu'],
  ]) {
    const c = clienteFalso({ falharEm: 'UPDATE origem_lead', erro: erroPg(code, msg) });
    await assert.rejects(() => anonymizeLead(c, ARGS), new RegExp(msg.split(' ')[0]),
      `erro ${code} deveria propagar: se a origem não foi apagada, alguém precisa saber`);
  }
});

test('caminho normal: a origem é apagada junto com o resto', async () => {
  const c = clienteFalso();
  await anonymizeLead(c, ARGS);
  const sqlOrigem = c.sqls.find((s) => s.includes('UPDATE origem_lead'));
  assert.ok(sqlOrigem, 'a origem do lead não foi tocada');
  // os cinco campos que carregam pessoa, e nenhum dos nove que sobrevivem
  for (const campo of ['telefone', 'payload_bruto', 'anuncio_url', 'anuncio_titulo', 'anuncio_texto']) {
    assert.ok(sqlOrigem.includes(campo), `${campo} deveria ser apagado`);
  }
  for (const campo of ['campanha_ref', 'anuncio_id', 'codigo_campanha', 'motor', 'metodo']) {
    assert.ok(!new RegExp(`${campo}\\s*=`).test(sqlOrigem), `${campo} NÃO pode ser reescrito na exclusão`);
  }
});
