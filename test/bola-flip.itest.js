'use strict';
// bola-flip.itest.js — FLIP da bola (ADR-030 Fatia 0). Prova o núcleo novo: _aplicarEstadoBola
// (escreve conversation_state RESPEITANDO override manual via proveniência) + gateSaida (veredito
// determinístico). PG descartável. NUNCA toca produção.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, withTenant } = require('../src/db');
const { _aplicarEstadoBola } = require('../src/engine');
const { gateSaida } = require('../src/bolaGate');

const A = process.env.RESOURCES_TENANT_A, B = process.env.RESOURCES_TENANT_B;
const novoLead = (t) => withTenant(t, async (c) => (await c.query(
  `INSERT INTO lead_manager.leads (tenant_id) VALUES ($1) RETURNING id`, [t])).rows[0].id);
const estado = (t, id) => withTenant(t, async (c) => (await c.query(
  `SELECT conversation_state, state_reasoning, bola_nossa_desde, adiamentos FROM lead_manager.leads WHERE id=$1`, [id])).rows[0]);
const travar = (t, id, valor) => withTenant(t, (c) => c.query(
  `SELECT lead_manager.marcar_edicao_humana('lead',$1,'conversation_state',$2,'recep')`, [id, valor]));
const divergAtiva = (t, id) => withTenant(t, async (c) => (await c.query(
  `SELECT 1 FROM lead_manager.field_divergence WHERE entity_kind='lead' AND entity_id=$1 AND field='conversation_state'
      AND dismissed_value IS DISTINCT FROM source_value`, [id])).rowCount > 0);

before(async () => {}); after(async () => { await pool.end(); });

test('(a) on + passou_bola → grava AGUARDANDO_CLIENTE (ESCREVE)', async () => {
  const id = await novoLead(A);
  const v = await _aplicarEstadoBola(A, id, 'AGUARDANDO_CLIENTE', 'gate:passou_bola', null, 0);
  assert.equal(v, 'ESCREVE');
  assert.equal((await estado(A, id)).conversation_state, 'AGUARDANDO_CLIENTE');
});

test('(b) on + enrolou → grava AGUARDANDO_RECEPCAO + marco/contador', async () => {
  const id = await novoLead(A);
  const ts = new Date().toISOString();
  const v = await _aplicarEstadoBola(A, id, 'AGUARDANDO_RECEPCAO', 'ia:AGUARDANDO_RECEPCAO', ts, 1);
  assert.equal(v, 'ESCREVE');
  const e = await estado(A, id);
  assert.equal(e.conversation_state, 'AGUARDANDO_RECEPCAO');
  assert.equal(e.adiamentos, 1);
  assert.notEqual(e.bola_nossa_desde, null);
});

test('(c) REVERTER (trava humana) → a bola RESPEITA o override (DIVERGE, não sobrescreve) + alerta', async () => {
  const id = await novoLead(A);
  await _aplicarEstadoBola(A, id, 'AGUARDANDO_CLIENTE', 'gate:passou_bola', null, 0);   // bola marcou cliente
  // revert: restaura p/ AGUARDANDO_RECEPCAO + trava
  await withTenant(A, (c) => c.query(`UPDATE lead_manager.leads SET conversation_state='AGUARDANDO_RECEPCAO' WHERE id=$1`, [id]));
  await travar(A, id, 'AGUARDANDO_RECEPCAO');
  // a bola tenta de novo marcar cliente → deve ser BLOQUEADA
  const v = await _aplicarEstadoBola(A, id, 'AGUARDANDO_CLIENTE', 'gate:passou_bola', null, 0);
  assert.equal(v, 'DIVERGE');
  assert.equal((await estado(A, id)).conversation_state, 'AGUARDANDO_RECEPCAO', 'override respeitado');
  assert.equal(await divergAtiva(A, id), true, 'divergência auditável');
});

test('(d) gateSaida — veredito determinístico', () => {
  assert.equal(gateSaida('Quer que eu te mande a apresentação?'), 'passou_bola');   // pergunta limpa
  assert.equal(gateSaida('vou ver'), 'enrolou');                                    // enrolação curta
  assert.equal(gateSaida('Segue a apresentação da escola em anexo.'), 'ambiguo');   // afirmação sem "?"
});

test('(e) CROSS-TENANT = 0: trava de A não afeta B', async () => {
  const idB = await novoLead(B);
  const v = await _aplicarEstadoBola(B, idB, 'AGUARDANDO_CLIENTE', 'gate:passou_bola', null, 0);
  assert.equal(v, 'ESCREVE');   // B não vê trava de A → escreve normal
  assert.equal((await estado(B, idB)).conversation_state, 'AGUARDANDO_CLIENTE');
});
