'use strict';
//
// Prompt padrão — testes puros (sem DB). Garante que o horário do prompt vem de
// config.horario_texto (FONTE ÚNICA tenants.horario_comercial), nunca mais de
// tenant_lead_config.business_hours.
//
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderDefaultPrompt, resolveSystemPrompt } = require('../src/templates');
const { textoHorario } = require('../src/horario');

const baseConfig = (over = {}) => ({
  school_name: 'ADR Valinhos',
  available_instruments: ['guitarra', 'bateria'],
  system_prompt_override: null,
  ...over,
});

test('renderDefaultPrompt usa config.horario_texto (fonte única)', () => {
  const p = renderDefaultPrompt(baseConfig({
    horario_texto: textoHorario({ '1': [{ inicio: '08:00', fim: '18:00' }], '6': [{ inicio: '09:00', fim: '13:00' }] }),
  }));
  assert.match(p, /Horário de atendimento: Seg: 08:00-18:00, Sáb: 09:00-13:00\./);
  assert.match(p, /ADR Valinhos/);
  assert.match(p, /guitarra, bateria/);
});

test('business_hours no config é IGNORADO (não vaza pro prompt)', () => {
  // Mesmo passando o campo legado, sem horario_texto o prompt não o usa.
  const p = renderDefaultPrompt(baseConfig({ business_hours: { mon: '20:00-23:00' } }));
  assert.doesNotMatch(p, /20:00-23:00/);
  assert.match(p, /Horário de atendimento: não informado\./);
});

test('sem horário configurado => "não informado"', () => {
  const p = renderDefaultPrompt(baseConfig({ horario_texto: textoHorario(null) }));
  assert.match(p, /Horário de atendimento: não informado\./);
});

test('override tem prioridade e ignora horário', () => {
  const p = resolveSystemPrompt(baseConfig({ system_prompt_override: 'PROMPT X', horario_texto: 'Seg: 08:00-18:00' }));
  assert.equal(p, 'PROMPT X');
});

test('template não contém mais o token {{business_hours}}', () => {
  const { DEFAULT_SYSTEM_PROMPT } = require('../src/templates');
  assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /business_hours/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /\{\{horario_atendimento\}\}/);
});
