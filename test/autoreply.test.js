'use strict';
// autoreply.test.js — lógica de horário (fuso fixo -03 São Paulo). Sem DB. Datas em UTC:
// horário LOCAL T equivale a UTC T+3h (ex.: 14:00 local = 17:00 UTC).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { businessState, formatNextOpen } = require('../src/autoReply');

// Todos os dias 09:00-18:00 (weekday-agnóstico p/ os testes de horário).
const BH = { mon: '09:00-18:00', tue: '09:00-18:00', wed: '09:00-18:00', thu: '09:00-18:00', fri: '09:00-18:00', sat: '09:00-18:00', sun: '09:00-18:00' };
const U = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo, d, h, mi, 0, 0));

test('(1) dentro do horário -> open', () => {
  const st = businessState(BH, U(2026, 7, 5, 17)); // 14:00 local
  assert.equal(st.open, true);
  assert.equal(st.closedSince, null); assert.equal(st.nextOpen, null);
});

test('(2) à noite -> fechado; closedSince=18h hoje; nextOpen=9h amanhã', () => {
  const now = U(2026, 7, 5, 23); // 20:00 local
  const st = businessState(BH, now);
  assert.equal(st.open, false);
  assert.equal(st.closedSince.getTime(), U(2026, 7, 5, 21).getTime()); // 18:00 local
  assert.equal(st.nextOpen.getTime(), U(2026, 7, 6, 12).getTime());    // 09:00 local amanhã
  assert.equal(formatNextOpen(st.nextOpen, now), 'amanhã às 9h');
});

test('(3) de manhã cedo -> fechado; nextOpen=hoje 9h', () => {
  const now = U(2026, 7, 5, 10); // 07:00 local
  const st = businessState(BH, now);
  assert.equal(st.open, false);
  assert.equal(st.nextOpen.getTime(), U(2026, 7, 5, 12).getTime()); // hoje 09:00 local
  assert.equal(st.closedSince.getTime(), U(2026, 7, 4, 21).getTime()); // ontem 18:00
  assert.equal(formatNextOpen(st.nextOpen, now), 'hoje às 9h');
});

test('(4) dia fechado (sun=closed) pula p/ próximo dia aberto', () => {
  const bh = { ...BH, sun: 'closed' };
  // acha um domingo: varre até getUTCDay()-3h == 0
  let now = U(2026, 7, 2, 15); // vamos procurar
  for (let i = 0; i < 7; i++) { const d = new Date(now.getTime() - 3 * 3600000); if (d.getUTCDay() === 0) break; now = new Date(now.getTime() + 86400000); }
  const st = businessState(bh, now);
  assert.equal(st.open, false, 'domingo fechado');
  assert.ok(st.nextOpen, 'tem próxima abertura');
  // a próxima abertura NÃO é no mesmo domingo
  assert.notEqual(new Date(st.nextOpen.getTime() - 3 * 3600000).getUTCDay(), 0);
});

test('(5) formatNextOpen com minutos', () => {
  const bh = { ...BH, wed: '09:30-18:00', thu: '09:30-18:00' };
  const now = U(2026, 7, 5, 23);
  const st = businessState(bh, now);
  const s = formatNextOpen(st.nextOpen, now);
  assert.match(s, /9h30/);
});

test('(6) tudo fechado -> nextOpen null, formatNextOpen null', () => {
  const bh = { mon: 'closed', tue: 'closed', wed: 'closed', thu: 'closed', fri: 'closed', sat: 'closed', sun: 'closed' };
  const st = businessState(bh, U(2026, 7, 5, 23));
  assert.equal(st.open, false); assert.equal(st.nextOpen, null);
  assert.equal(formatNextOpen(null, U(2026, 7, 5, 23)), null);
});
