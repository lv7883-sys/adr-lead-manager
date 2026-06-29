'use strict';
//
// H1 — horário de atendimento por-dia + função canônica dentroDoExpediente.
// Testes puros (sem DB): equivalência com a lógica antiga, faixas-por-dia,
// almoço, dia fechado, fallback legado e validação do PUT.
//
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/horario');

// Réplica EXATA da dentroHorario() antiga (pré-049), p/ provar equivalência.
function oldDentroHorario(ts, horario) { // horario = {inicio:min, fim:min, dias:[]}
  if (!ts || !horario) return null;
  const x = new Date(new Date(ts).getTime() - 3 * 3600 * 1000);
  const mins = x.getUTCHours() * 60 + x.getUTCMinutes();
  const isoDow = x.getUTCDay() === 0 ? 7 : x.getUTCDay();
  if (!horario.dias.includes(isoDow)) return false;
  return mins >= horario.inicio && mins < horario.fim;
}

// Datas de referência (SP = UTC-3): 2026-06-27=SÁBADO(6), 2026-06-29=SEGUNDA(1).
const spSab = (h, m = 0) => `2026-06-27T${String(h + 3).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const spSeg = (h, m = 0) => `2026-06-29T${String(h + 3).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

// jsonb que a migration 049 gera pro Valinhos (verificado em PG descartável).
const valinhosJson = { '6': [{ inicio: '09:00', fim: '13:00' }] };
const valinhosLegacyMin = { inicio: 9 * 60, fim: 13 * 60, dias: [6] };

test('equivalência: jsonb migrado dá o MESMO veredito que a dentroHorario() antiga', () => {
  const ts = [spSab(10), spSab(9), spSab(12, 59), spSab(13), spSab(8, 59), spSab(18), spSeg(10), spSeg(9, 30)];
  for (const t of ts) {
    assert.equal(H.dentroDoExpediente(valinhosJson, t), oldDentroHorario(t, valinhosLegacyMin), `ts=${t}`);
  }
});

test('faixa por dia diferente (sáb 09-13, seg 09-22)', () => {
  const c = { '1': [{ inicio: '09:00', fim: '22:00' }], '6': [{ inicio: '09:00', fim: '13:00' }] };
  assert.equal(H.dentroDoExpediente(c, spSab(12)), true);
  assert.equal(H.dentroDoExpediente(c, spSab(14)), false);
  assert.equal(H.dentroDoExpediente(c, spSeg(14)), true);
  assert.equal(H.dentroDoExpediente(c, spSeg(22)), false); // borda fim exclusiva
});

test('almoço: 2 faixas no mesmo dia (seg 09-12 e 14-18)', () => {
  const a = { '1': [{ inicio: '09:00', fim: '12:00' }, { inicio: '14:00', fim: '18:00' }] };
  assert.equal(H.dentroDoExpediente(a, spSeg(13)), false); // intervalo
  assert.equal(H.dentroDoExpediente(a, spSeg(11)), true);
  assert.equal(H.dentroDoExpediente(a, spSeg(15)), true);
  assert.equal(H.dentroDoExpediente(a, spSeg(12)), false); // borda fim manhã
});

test('dia ausente / lista vazia => fora (fechado)', () => {
  assert.equal(H.dentroDoExpediente({ '1': [{ inicio: '09:00', fim: '18:00' }] }, spSab(10)), false);
  assert.equal(H.dentroDoExpediente({ '1': [{ inicio: '09:00', fim: '18:00' }], '6': [] }, spSab(10)), false);
});

test('fallback: tenant só com shape legado (colunas antigas) responde certo', () => {
  const legacy = { inicio: '09:00', fim: '13:00', dias: [6] };
  assert.equal(H.dentroDoExpediente(legacy, spSab(10)), true);
  assert.equal(H.dentroDoExpediente(legacy, spSab(14)), false);
  assert.equal(H.dentroDoExpediente(legacy, spSeg(10)), false);
  // fallback == jsonb migrado
  assert.equal(H.dentroDoExpediente(legacy, spSab(10)), H.dentroDoExpediente(valinhosJson, spSab(10)));
});

test('sem ts ou sem config => null', () => {
  assert.equal(H.dentroDoExpediente(valinhosJson, null), null);
  assert.equal(H.dentroDoExpediente(null, spSab(10)), null);
  assert.equal(H.dentroDoExpediente({}, spSab(10)), null);
});

test('validaHorarioJson: sobreposição no mesmo dia => erro', () => {
  assert.equal(H.validaHorarioJson({ '1': [{ inicio: '09:00', fim: '12:00' }, { inicio: '11:00', fim: '13:00' }] }).ok, false);
  assert.equal(H.validaHorarioJson({ '1': [{ inicio: '09:00', fim: '12:00' }, { inicio: '12:00', fim: '15:00' }] }).ok, true); // encostadas OK
  assert.equal(H.validaHorarioJson({ '1': [{ inicio: '12:00', fim: '09:00' }] }).ok, false); // inicio>=fim
  assert.equal(H.validaHorarioJson({ '1': [{ inicio: '9h', fim: '18:00' }] }).ok, false);     // HH:MM
  assert.equal(H.validaHorarioJson({ '8': [{ inicio: '09:00', fim: '18:00' }] }).ok, false);  // dia fora 1..7
  assert.equal(H.validaHorarioJson({}).ok, true);                                             // tudo fechado
});

test('faixasDoDia: moldura por weekday', () => {
  const a = { '1': [{ inicio: '09:00', fim: '12:00' }, { inicio: '14:00', fim: '18:00' }] };
  assert.deepEqual(H.faixasDoDia(a, 1), [{ inicio: '09:00', fim: '12:00' }, { inicio: '14:00', fim: '18:00' }]);
  assert.deepEqual(H.faixasDoDia(valinhosJson, 6), [{ inicio: '09:00', fim: '13:00' }]);
  assert.deepEqual(H.faixasDoDia(valinhosJson, 1), []);
});

test('canonicaliza: ordena faixas e descarta inválidas', () => {
  assert.deepEqual(
    H.canonicaliza({ '1': [{ inicio: '14:00', fim: '18:00' }, { inicio: '09:00', fim: '12:00' }, { inicio: 'xx', fim: 'yy' }] }),
    { '1': [{ inicio: '09:00', fim: '12:00' }, { inicio: '14:00', fim: '18:00' }] }
  );
});
