'use strict';

// Testes UNIT (sem rede/sem PG) da evolução MULTI-SLOT da leitura ao vivo. Exercita os
// helpers puros do adapter (parseSlotsInput, distinctSlotDates, matchOcupacao) e o orquestrador
// readSlotsMulti com IO MOCKADO — NUNCA bate na Extranet real. Prova: retrocompat (1 slot),
// agrupamento de datas (terça 14h+15h = 3 datas), limite de 3, e duração (intervalo 90 vs 60).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/resources/adapters/valinhos');

// HTML mínimo que o parseGradeOcupacao entende: âncora aula_edit + title com linhas
// "HH:MM - HH:MM", "Sala N", "Curso X", status.
const aulaHtml = (id, ini, fim, sala, curso, status) =>
  `<a href="#" onclick="aula_edit('${id}')" title="${ini} - ${fim}&#10;Sala ${sala}&#10;Curso ${curso}&#10;${status}">Prof. Fulano</a>`;

// ---------------------------------------------------------------------------
test('parseSlotsInput: forma slots= (1..3) + fim default +60', () => {
  const r = v.parseSlotsInput({ slots: '2026-06-30@14:00,2026-07-02@15:00@16:30' });
  assert.equal(r.error, undefined);
  assert.equal(r.slots.length, 2);
  assert.deepEqual(r.slots[0], { key: '2026-06-30T14:00', anchorDate: '2026-06-30', inicio: '14:00', fim: '15:00' }); // default +60
  assert.deepEqual(r.slots[1], { key: '2026-07-02T15:00', anchorDate: '2026-07-02', inicio: '15:00', fim: '16:30' }); // fim explícito
});

test('parseSlotsInput: forma legada anchor+time+fim → 1 slot', () => {
  const r = v.parseSlotsInput({ anchor: '2026-06-30', time: '14:00', fim: '15:30' });
  assert.equal(r.slots.length, 1);
  assert.equal(r.slots[0].fim, '15:30');
});

test('parseSlotsInput: 4 slots → erro (limite 3)', () => {
  const r = v.parseSlotsInput({ slots: '2026-06-30@08:00,2026-06-30@09:00,2026-06-30@10:00,2026-06-30@11:00' });
  assert.match(r.error, /máximo de 3/i);
});

test('parseSlotsInput: data/hora malformada → erro', () => {
  assert.match(v.parseSlotsInput({ slots: '30-06-2026@14:00' }).error, /inválido/i);
  assert.match(v.parseSlotsInput({ slots: '2026-06-30@14h' }).error, /inválido/i);
});

test('distinctSlotDates: 1 slot → 3 datas (regra das 3 semanas)', () => {
  const d = v.distinctSlotDates([{ anchorDate: '2026-06-30' }]); // terça
  assert.deepEqual(d, ['2026-06-30', '2026-07-07', '2026-07-14']);
});

test('distinctSlotDates: 2 slots MESMO weekday colapsam → 3 datas (não 6)', () => {
  const d = v.distinctSlotDates([{ anchorDate: '2026-06-30' }, { anchorDate: '2026-06-30' }]); // terça 14h + terça 15h
  assert.equal(d.length, 3);
});

test('distinctSlotDates: 2 slots weekdays DIFERENTES → 6 datas', () => {
  const d = v.distinctSlotDates([{ anchorDate: '2026-06-30' }, { anchorDate: '2026-07-02' }]); // terça + quinta
  assert.equal(d.length, 6);
});

test('matchOcupacao: usa o INTERVALO (90 pega a aula das 15:00; 60 não)', () => {
  // aula 15:00–16:00; slot começa 14:00.
  assert.equal(v.matchOcupacao('14:00', '15:00', '15:00', '16:00'), false); // 60min: encosta, não sobrepõe
  assert.equal(v.matchOcupacao('14:00', '15:30', '15:00', '16:00'), true);  // 90min: sobrepõe 15:00–15:30
});

// --- orquestrador com IO mockado ---------------------------------------------
function mockIo(htmlByDate, { isExceptionDates = [] } = {}) {
  const calls = { fetch: [], throttle: 0 };
  return {
    io: {
      getGradeHtml: async (d) => { calls.fetch.push(d); return htmlByDate[d] ?? ''; },
      isException: async (d) => isExceptionDates.includes(d),
      throttle: async () => { calls.throttle++; },
      onOccurrence: async () => {},
    },
    calls,
  };
}

test('readSlotsMulti: 1 slot vazio → 3 livres, 3 fetches, 2 throttles, com slotKey', async () => {
  const { io, calls } = mockIo({});
  const slots = v.parseSlotsInput({ slots: '2026-06-30@14:00' }).slots;
  const r = await v.readSlotsMulti({ slots }, io);
  assert.equal(r.occurrences.length, 3);
  assert.ok(r.occurrences.every((o) => o.state === 'livre'));
  assert.ok(r.occurrences.every((o) => o.slotKey === '2026-06-30T14:00')); // campo NOVO presente
  assert.deepEqual(r.occurrences.map((o) => o.occurrence), [1, 2, 3]);
  assert.equal(calls.fetch.length, 3, '3 GETs (1 por data)');
  assert.equal(calls.throttle, 2, 'gap só ENTRE GETs reais');
});

test('readSlotsMulti: 2 slots MESMO weekday → 1 GET por data (3), 6 ocorrências', async () => {
  const { io, calls } = mockIo({});
  const slots = v.parseSlotsInput({ slots: '2026-06-30@14:00,2026-06-30@15:00' }).slots;
  const r = await v.readSlotsMulti({ slots }, io);
  assert.equal(calls.fetch.length, 3, 'agrupou: 3 datas distintas, 3 GETs (não 6)');
  assert.equal(r.occurrences.length, 6, '2 slots × 3 semanas');
});

test('readSlotsMulti: 2 slots weekdays DIFERENTES → 6 GETs', async () => {
  const { io, calls } = mockIo({});
  const slots = v.parseSlotsInput({ slots: '2026-06-30@14:00,2026-07-02@14:00' }).slots;
  await v.readSlotsMulti({ slots }, io);
  assert.equal(calls.fetch.length, 6, '6 datas distintas');
});

test('readSlotsMulti: data em exceção NÃO faz fetch; vira bloqueada_por_excecao', async () => {
  const { io, calls } = mockIo({}, { isExceptionDates: ['2026-06-30'] });
  const slots = v.parseSlotsInput({ slots: '2026-06-30@14:00' }).slots;
  const r = await v.readSlotsMulti({ slots }, io);
  assert.equal(calls.fetch.length, 2, 'pulou a data em exceção');
  assert.equal(r.occurrences[0].state, 'bloqueada_por_excecao');
});

test('readSlotsMulti: DURAÇÃO — slot de 90min detecta a aula das 15:00; o de 60min não', async () => {
  const html = { '2026-06-30': aulaHtml('1', '15:00', '16:00', '1', 'Guitarra', 'Prevista') };
  // 90min (14:00–15:30) → ocupada
  const r90 = await v.readSlotsMulti({ slots: v.parseSlotsInput({ slots: '2026-06-30@14:00@15:30' }).slots }, mockIo(html).io);
  assert.equal(r90.occurrences[0].state, 'ocupada_por_aula');
  assert.equal(r90.occurrences[0].ocupadas[0].curso, 'Curso Guitarra');
  // 60min (14:00–15:00) → livre (só encosta na aula)
  const r60 = await v.readSlotsMulti({ slots: v.parseSlotsInput({ slots: '2026-06-30@14:00@15:00' }).slots }, mockIo(html).io);
  assert.equal(r60.occurrences[0].state, 'livre');
});

test('retrocompat: readSlot3Weeks (caminho legado) segue com shape SEM slotKey', async () => {
  const { io } = mockIo({});
  const r = await v.readSlot3Weeks({ anchorDate: '2026-06-30', time: '14:00' }, io);
  assert.equal(r.occurrences.length, 3);
  assert.deepEqual(Object.keys(r.occurrences[0]).sort(), ['date', 'occurrence', 'ocupadas', 'state', 'weekday']);
  assert.equal('slotKey' in r.occurrences[0], false, 'legado NÃO ganha slotKey');
});
