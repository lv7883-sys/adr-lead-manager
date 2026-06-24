'use strict';

// Testes MOCKADOS do consumidor do evento canônico (Surface A / ADR-022).
// Sem banco, sem servidor: client fake roteado por SQL. Cobre match forte
// (telefone), match fraco (nome+janela), sem-match→walk-in, idempotência,
// trava manual respeitada, e matrícula furando a trava com alerta.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { processarEvento, normName } = require('../src/eventosProgressao');

const TENANT = '11111111-1111-1111-1111-111111111111';

// Client fake: roteia por regex no SQL e registra as chamadas de escrita.
function makeClient({ leads = [], ledger = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM progressao_event_ledger/.test(sql) && /SELECT/.test(sql)) {
        return ledger ? { rowCount: 1, rows: [ledger] } : { rowCount: 0, rows: [] };
      }
      if (/FROM leads WHERE tenant_id/.test(sql)) {
        return { rowCount: leads.length, rows: leads };
      }
      if (/INSERT INTO leads/.test(sql)) {
        return { rowCount: 1, rows: [{ id: 'walkin-id' }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
}
const wrote = (c, re) => c.calls.some((k) => re.test(k.sql));
const recent = () => new Date().toISOString();

const base = { source_adapter: 'extranet', situacao: 'ativo' };

test('match forte por telefone → experimental_realizada AVANÇA o card', async () => {
  const c = makeClient({ leads: [
    { id: 'L1', name: 'Contato', student_name: null, phone: '+55 19 99999-1234', status: 'QUALIFYING', auto_progress_locked: false, created_at: recent() },
  ] });
  const out = await processarEvento(c, { tenantId: TENANT, evento: {
    ...base, tipo: 'experimental_realizada', source_record_id: 'aula-1', telefone: '1999991234',
  } });
  assert.equal(out.status, 'ok');
  assert.equal(out.resultado, 'advanced');
  assert.equal(out.match, 'phone');
  assert.equal(out.lead_id, 'L1');
  assert.ok(wrote(c, /UPDATE leads SET status = \$2/), 'moveu o card');
  assert.ok(wrote(c, /INSERT INTO lead_eval_label/), 'gravou ground-truth');
  assert.ok(wrote(c, /INSERT INTO progressao_event_ledger/), 'gravou ledger');
});

test('match fraco por nome + janela → AVANÇA', async () => {
  const c = makeClient({ leads: [
    { id: 'L2', name: 'João da Silva', student_name: null, phone: null, status: 'NEW', auto_progress_locked: false, created_at: recent() },
  ] });
  const out = await processarEvento(c, { tenantId: TENANT, evento: {
    ...base, tipo: 'experimental_realizada', source_record_id: 'aula-2', student_name: 'JOAO DA SILVA',
  } });
  assert.equal(out.resultado, 'advanced');
  assert.equal(out.match, 'name');
});

test('nome fora da janela temporal → NÃO casa, vira walk-in', async () => {
  const old = new Date(Date.now() - 200 * 864e5).toISOString();
  const c = makeClient({ leads: [
    { id: 'L3', name: 'Maria', student_name: null, phone: null, status: 'NEW', auto_progress_locked: false, created_at: old },
  ] });
  const out = await processarEvento(c, { tenantId: TENANT, evento: {
    ...base, tipo: 'experimental_realizada', source_record_id: 'aula-3', student_name: 'Maria',
  } });
  assert.equal(out.resultado, 'walk_in');
  assert.equal(out.match, 'none');
});

test('sem match → cria lead de rua (walk_in) em experimental', async () => {
  const c = makeClient({ leads: [] });
  const out = await processarEvento(c, { tenantId: TENANT, evento: {
    ...base, tipo: 'experimental_realizada', source_record_id: 'aula-4', student_name: 'Novo Aluno', telefone: '1933334444',
  } });
  assert.equal(out.resultado, 'walk_in');
  assert.equal(out.lead_id, 'walkin-id');
  assert.ok(wrote(c, /INSERT INTO leads[\s\S]*'walk_in'/), 'criou com origem walk_in');
});

test('idempotência: registro+situação já no ledger → duplicate, sem escrita', async () => {
  const c = makeClient({ ledger: { lead_id: 'L9', resultado: 'advanced' } });
  const out = await processarEvento(c, { tenantId: TENANT, evento: {
    ...base, tipo: 'experimental_realizada', source_record_id: 'aula-1', telefone: '1999991234',
  } });
  assert.equal(out.status, 'duplicate');
  assert.equal(out.lead_id, 'L9');
  assert.ok(!wrote(c, /UPDATE leads/), 'não re-progrediu');
  assert.ok(!wrote(c, /INSERT INTO progressao_event_ledger/), 'não duplicou ledger');
});

test('trava manual RESPEITADA em experimental_realizada (locked_skip)', async () => {
  const c = makeClient({ leads: [
    { id: 'LK', name: 'Travado', student_name: null, phone: '1999991234', status: 'QUALIFYING', auto_progress_locked: true, created_at: recent() },
  ] });
  const out = await processarEvento(c, { tenantId: TENANT, evento: {
    ...base, tipo: 'experimental_realizada', source_record_id: 'aula-5', telefone: '1999991234',
  } });
  assert.equal(out.resultado, 'locked_skip');
  assert.ok(!wrote(c, /UPDATE leads SET status/), 'não moveu (trava)');
  assert.ok(wrote(c, /INSERT INTO lead_eventos[\s\S]*'nota'/), 'registrou nota');
});

test('matrícula FURA a trava manual e conclui, com alerta', async () => {
  const c = makeClient({ leads: [
    { id: 'LM', name: 'Travado', student_name: null, phone: '1999991234', status: 'QUALIFYING', auto_progress_locked: true, created_at: recent() },
  ] });
  const out = await processarEvento(c, { tenantId: TENANT, evento: {
    ...base, tipo: 'matricula_confirmada', source_record_id: 'mat-1', telefone: '1999991234',
  } });
  assert.equal(out.resultado, 'concluded');
  assert.equal(out.alerta, true);
  assert.ok(wrote(c, /UPDATE leads SET status = \$2, desfecho = 'matriculado'/), 'concluiu como ganho');
  assert.ok(c.calls.some((k) => /INSERT INTO lead_eventos/.test(k.sql) && /\[ALERTA\]/.test(String(k.params))), 'alertou a recepção (furou a trava)');
});

test('avanço só pra frente: experimental sobre lead já CONVERTED → noop', async () => {
  const c = makeClient({ leads: [
    { id: 'LC', name: 'Convertido', student_name: null, phone: '1999991234', status: 'CONVERTED', auto_progress_locked: false, created_at: recent() },
  ] });
  const out = await processarEvento(c, { tenantId: TENANT, evento: {
    ...base, tipo: 'experimental_realizada', source_record_id: 'aula-6', telefone: '1999991234',
  } });
  assert.equal(out.resultado, 'noop_ahead');
  assert.ok(!wrote(c, /UPDATE leads SET status/), 'não regrediu');
});

test('evento inválido (tipo / chave faltando)', async () => {
  const c = makeClient({});
  assert.equal((await processarEvento(c, { tenantId: TENANT, evento: { tipo: 'xpto' } })).reason, 'tipo');
  assert.equal((await processarEvento(c, { tenantId: TENANT, evento: { tipo: 'experimental_realizada' } })).reason, 'chave');
});

test('normName normaliza acentos e caixa', () => {
  assert.equal(normName('João  DA Silva'), 'joao da silva');
  assert.equal(normName('JOÃO DA SILVA'), normName('joão da silva'));
});
