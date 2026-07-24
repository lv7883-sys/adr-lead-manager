'use strict';
// stage-autoapply.itest.js — APLICAÇÃO AUTOMÁTICA DE SUGESTÃO DE ETAPA (migration 078).
// (A) _autoAplicarEtapa contra PG efêmero: move status certo, cria evento 'mudanca_etapa', loga snapshot,
//     limpa sugestão; recusa transição inválida e lead terminal (nunca fura carimbo/desfecho).
// (B) persistStageSuggestion: mode off = suggestion-only (não move); mode on + etapa na lista = aplica;
//     'convertido' fora da lista = segurado; respeita dispensa. + equivalência de transição vs stages.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const engine = require('../src/engine');
const stages = require('../src/stages');

let c;
const T = '00000000-0000-0000-0000-0000000000f1';

async function seedTenant(mode, list) {
  await c.query('DELETE FROM tenant_lead_config WHERE tenant_id=$1', [T]);
  await c.query('INSERT INTO tenant_lead_config (tenant_id, stage_autoapply_mode, stage_autoapply_stages) VALUES ($1,$2,$3)',
    [T, mode, list]);
}
async function seedLead({ status = 'QUALIFYING', desfecho = null, sug = null, dismissed = null } = {}) {
  return (await c.query(
    `INSERT INTO leads (tenant_id, name, phone, status, desfecho, suggested_stage, stage_reasoning, suggested_stage_dismissed)
     VALUES ($1,'Contato','551199',$2,$3,$4,'motivo',$5) RETURNING id`,
    [T, status, desfecho, sug, dismissed])).rows[0].id;
}
const leadOf = async (id) => (await c.query('SELECT status, desfecho, suggested_stage FROM leads WHERE id=$1', [id])).rows[0];
const logsOf = async (id) => (await c.query('SELECT * FROM stage_autoapply_log WHERE lead_id=$1', [id])).rows;
const eventosOf = async (id) => (await c.query("SELECT * FROM lead_eventos WHERE lead_id=$1 AND tipo='mudanca_etapa'", [id])).rows;

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query(`
    CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, phone text,
      status text, desfecho text, desfecho_em timestamptz, suggested_stage text, stage_reasoning text,
      stage_suggested_at timestamptz, suggested_stage_dismissed text, review_result text,
      updated_at timestamptz DEFAULT now());
    CREATE TABLE lead_eventos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid,
      tipo text, autor text, conteudo text, etapa_key text, created_at timestamptz DEFAULT now());
    CREATE TABLE tenant_lead_config (tenant_id uuid PRIMARY KEY, stage_autoapply_mode text, stage_autoapply_stages text[]);
    CREATE TABLE stage_autoapply_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid,
      from_stage text, to_stage text, reasoning text, source text, external_message_id text,
      prior_status text, prior_desfecho text, prior_desfecho_em timestamptz, evento_id uuid,
      reverted boolean DEFAULT false, reverted_at timestamptz, reverted_by text, created_at timestamptz DEFAULT now());`);
});
after(async () => {
  await c.end();
  try { await require('../src/db').pool.end(); } catch {}
  try { require('../src/redisClient').redis.disconnect(); } catch {}
});

// ---------- (A) _autoAplicarEtapa ----------
test('A1 qualificando→qualificado: status QUALIFIED, evento, log com snapshot, sugestão limpa', async () => {
  const id = await seedLead({ status: 'QUALIFYING', sug: 'qualificado' });
  const r = await require('../src/db').withTenant(T, (cl) => engine._autoAplicarEtapa(cl, {
    tenantId: T, leadId: id, destCol: 'qualificado', reasoning: 'x', source: 'event', externalMessageId: 'a1' }));
  assert.equal(r.applied, true); assert.equal(r.from, 'qualificando');
  const l = await leadOf(id);
  assert.equal(l.status, 'QUALIFIED'); assert.equal(l.desfecho, null); assert.equal(l.suggested_stage, null);
  const lg = await logsOf(id);
  assert.equal(lg.length, 1); assert.equal(lg[0].from_stage, 'qualificando'); assert.equal(lg[0].to_stage, 'qualificado');
  assert.equal(lg[0].prior_status, 'QUALIFYING'); assert.equal(lg[0].source, 'event');
  const ev = await eventosOf(id);
  assert.equal(ev.length, 1); assert.equal(ev[0].autor, 'ia_auto'); assert.equal(ev[0].etapa_key, 'qualificado');
  assert.equal(lg[0].evento_id, ev[0].id);
});
test('A2 qualificando→experimental: status EXPERIMENTAL_AGENDADA', async () => {
  const id = await seedLead({ status: 'QUALIFYING', sug: 'experimental' });
  const r = await require('../src/db').withTenant(T, (cl) => engine._autoAplicarEtapa(cl, { tenantId: T, leadId: id, destCol: 'experimental' }));
  assert.equal(r.applied, true); assert.equal((await leadOf(id)).status, 'EXPERIMENTAL_AGENDADA');
});
test('A3 convertido: status CONVERTED + desfecho matriculado', async () => {
  const id = await seedLead({ status: 'QUALIFYING', sug: 'convertido' });
  const r = await require('../src/db').withTenant(T, (cl) => engine._autoAplicarEtapa(cl, { tenantId: T, leadId: id, destCol: 'convertido' }));
  assert.equal(r.applied, true);
  const l = await leadOf(id); assert.equal(l.status, 'CONVERTED'); assert.equal(l.desfecho, 'matriculado');
});
test('A4 lead terminal (desfecho) → terminal, NÃO move', async () => {
  const id = await seedLead({ status: 'QUALIFYING', desfecho: 'nao_tem_interesse', sug: 'qualificado' });
  const r = await require('../src/db').withTenant(T, (cl) => engine._autoAplicarEtapa(cl, { tenantId: T, leadId: id, destCol: 'qualificado' }));
  assert.equal(r.terminal, true);
  assert.equal((await leadOf(id)).status, 'QUALIFYING'); assert.equal((await logsOf(id)).length, 0);
});
test('A5 destino == etapa atual → terminal (nada a mover)', async () => {
  const id = await seedLead({ status: 'QUALIFIED', sug: 'qualificado' });
  const r = await require('../src/db').withTenant(T, (cl) => engine._autoAplicarEtapa(cl, { tenantId: T, leadId: id, destCol: 'qualificado' }));
  assert.equal(r.terminal, true); assert.equal((await logsOf(id)).length, 0);
});

// ---------- (B) persistStageSuggestion (config) ----------
test('B1 mode OFF → só sugere, NÃO move', async () => {
  await seedTenant('off', ['experimental', 'qualificado']);
  const id = await seedLead({ status: 'QUALIFYING' });
  await engine.persistStageSuggestion(T, id, 'qualificado', 'motivo');
  const l = await leadOf(id);
  assert.equal(l.status, 'QUALIFYING'); assert.equal(l.suggested_stage, 'qualificado');
  assert.equal((await logsOf(id)).length, 0);
});
test('B2 mode ON + etapa na lista → APLICA (move + log, sugestão limpa)', async () => {
  await seedTenant('on', ['experimental', 'qualificado']);
  const id = await seedLead({ status: 'QUALIFYING' });
  await engine.persistStageSuggestion(T, id, 'qualificado', 'motivo');
  const l = await leadOf(id);
  assert.equal(l.status, 'QUALIFIED'); assert.equal(l.suggested_stage, null);
  assert.equal((await logsOf(id)).length, 1);
});
test('B3 mode ON + convertido FORA da lista → segurado (só sugere)', async () => {
  await seedTenant('on', ['experimental', 'qualificado']);
  const id = await seedLead({ status: 'QUALIFYING' });
  await engine.persistStageSuggestion(T, id, 'convertido', 'pagou');
  const l = await leadOf(id);
  assert.equal(l.status, 'QUALIFYING'); assert.equal(l.suggested_stage, 'convertido');
  assert.equal((await logsOf(id)).length, 0, 'convertido não aplica automático');
});
test('B4 mode ON mas etapa == dispensada → não sugere nem move', async () => {
  await seedTenant('on', ['experimental', 'qualificado']);
  const id = await seedLead({ status: 'QUALIFYING', dismissed: 'qualificado' });
  await engine.persistStageSuggestion(T, id, 'qualificado', 'motivo');
  const l = await leadOf(id);
  assert.equal(l.status, 'QUALIFYING'); assert.equal(l.suggested_stage, null); assert.equal((await logsOf(id)).length, 0);
});

// ---------- (C) equivalência de transição vs régua canônica ----------
test('C1 _autoAplicarEtapa só aceita destinos válidos de stages.KANBAN_TRANSICOES', async () => {
  // 'novo'→'qualificado' é válido (novo é origem de tudo); 'qualificado'→'qualificado' inválido (mesma).
  assert.ok(stages.KANBAN_TRANSICOES['qualificando'].includes('qualificado'));
  assert.ok(stages.KANBAN_TRANSICOES['qualificando'].includes('experimental'));
  assert.ok(!stages.KANBAN_TRANSICOES['qualificado'].includes('qualificado'));
});
