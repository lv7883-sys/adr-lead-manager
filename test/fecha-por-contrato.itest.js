'use strict';
// fecha-por-contrato.itest.js — FECHAMENTO AUTOMÁTICO POR CONTRATO (decisão do Leo 23-25/09).
// PG descartável, cadastro sintético (sem Extranet). Prova as quatro guardas e a régua do ">=",
// que é o que separa conversão de quem já era cliente. NUNCA toca produção.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, withTenant } = require('../src/db');
const { simular, run } = require('../src/cadastro/fechaPorContrato');

const A = process.env.RESOURCES_TENANT_A;

// --- helpers de cenário -------------------------------------------------------------------------
const mkLead = (over = {}) => withTenant(A, async (c) => (await c.query(
  `INSERT INTO lead_manager.leads (tenant_id, name, phone, status, desfecho, created_at, suggested_stage_dismissed)
   VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
  [A, over.name || 'Lead', over.phone, over.status || 'EXPERIMENTAL_AGENDADA',
   over.desfecho || null, over.created_at || '2026-07-01', over.dismissed || null])).rows[0].id);

// pessoa + telefone + contrato (beneficiário pode ser OUTRA pessoa: o caso mãe→filho)
const mkContrato = (over = {}) => withTenant(A, async (c) => {
  const p = (await c.query(
    `INSERT INTO lead_manager.person (tenant_id, display_name) VALUES ($1,$2) RETURNING id`,
    [A, over.beneficiario || 'Aluno'])).rows[0].id;
  await c.query(
    `INSERT INTO lead_manager.contact_point (tenant_id, person_id, kind, value_raw, source, confidence)
     VALUES ($1,$2,'phone',$3,'extranet','alegado')`, [A, p, over.phone]);
  const sa = (await c.query(
    `INSERT INTO lead_manager.service_account (tenant_id, servico_label, ini_vigencia, fim_vigencia, status)
     VALUES ($1,$2,$3,$4,'Ativo') RETURNING id`,
    [A, over.curso || 'Piano', over.ini, over.fim || '2027-12-31'])).rows[0].id;
  await c.query(
    `INSERT INTO lead_manager.account_member (tenant_id, account_id, person_id, bond)
     VALUES ($1,$2,$3,'beneficiario')`, [A, sa, p]);
  return sa;
});

const lead = (id) => withTenant(A, async (c) => (await c.query(
  'SELECT status, desfecho, desfecho_source, to_char(desfecho_em,\'YYYY-MM-DD\') d FROM lead_manager.leads WHERE id=$1',
  [id])).rows[0]);
const logs = (id) => withTenant(A, async (c) => (await c.query(
  'SELECT from_stage, to_stage, source, prior_status FROM lead_manager.stage_autoapply_log WHERE lead_id=$1', [id])).rows);

before(async () => {}); after(async () => { await pool.end(); });

test('(a) FECHA quem matriculou DEPOIS do lead — com a data do contrato, e é reversível', async () => {
  const id = await mkLead({ name: 'Rejane', phone: '+5519982062442', created_at: '2026-07-08' });
  await mkContrato({ phone: '(19)98206-2442', beneficiario: 'Catarina (filha)', curso: 'Canto', ini: '2026-08-31' });
  const r = await run(A, { dryRun: false });
  assert.equal(r.fechados, 1);
  const l = await lead(id);
  assert.equal(l.status, 'CONVERTED');
  assert.equal(l.desfecho, 'matriculado');
  assert.equal(l.desfecho_source, 'extranet');
  assert.equal(l.d, '2026-08-31', 'data do CONTRATO, não a de hoje — o funil conta no mês certo');
  const lg = await logs(id);
  assert.equal(lg.length, 1);
  assert.equal(lg[0].source, 'contract_match');
  assert.equal(lg[0].prior_status, 'EXPERIMENTAL_AGENDADA', 'reverter restaura o estado exato');
  // idempotente: segunda execução não refaz nada
  assert.equal((await run(A, { dryRun: false })).fechados, 0);
});

test('(b) A RÉGUA DO ">=": quem JÁ ERA cliente antes do lead não é fechado', async () => {
  const id = await mkLead({ name: 'Ja era cliente', phone: '+5519911110001', created_at: '2026-07-01' });
  await mkContrato({ phone: '(19)91111-0001', beneficiario: 'Filho antigo', ini: '2025-04-15' }); // ANTES
  const r = await run(A, { dryRun: false });
  assert.equal(r.fechados, 0, 'contrato anterior ao lead não é conversão do funil');
  assert.equal((await lead(id)).desfecho, null);
});

test('(c) GUARDA 3 — contato interno nunca é fechado (Kessia/Daniele)', async () => {
  const id = await mkLead({ name: 'Kessia', phone: '+5519922220002', created_at: '2026-07-01' });
  await mkContrato({ phone: '(19)92222-0002', beneficiario: 'Kessia', ini: '2026-08-10' });
  await withTenant(A, (c) => c.query(
    `INSERT INTO lead_manager.internal_contacts (tenant_id, phone, name, type)
     VALUES ($1,'19922220002','Kessia','recepcionista')`, [A]));
  assert.equal((await run(A, { dryRun: false })).fechados, 0);
  assert.equal((await lead(id)).desfecho, null, 'gente da casa fora do funil de conversão');
});

test('(d) GUARDA 1 e 2 — desfecho existente e quem está fora do funil são intocáveis', async () => {
  const comDesfecho = await mkLead({ name: 'Perdido', phone: '+5519933330003', desfecho: 'nao_matriculado_preco', created_at: '2026-07-01' });
  const notLead = await mkLead({ name: 'Descartado', phone: '+5519944440004', status: 'NOT_LEAD', created_at: '2026-07-01' });
  await mkContrato({ phone: '(19)93333-0003', ini: '2026-08-01' });
  await mkContrato({ phone: '(19)94444-0004', ini: '2026-08-01' });
  assert.equal((await run(A, { dryRun: false })).fechados, 0);
  assert.equal((await lead(comDesfecho)).desfecho, 'nao_matriculado_preco', 'decisão registrada preservada');
  assert.equal((await lead(notLead)).status, 'NOT_LEAD', 'os 104 não se tocam');
});

test('(e) GUARDA 4 — quem a recepção reverteu no Monitor não é re-fechado (sem loop)', async () => {
  const id = await mkLead({ name: 'Revertido', phone: '+5519955550005', created_at: '2026-07-01', dismissed: 'convertido' });
  await mkContrato({ phone: '(19)95555-0005', ini: '2026-08-05' });
  assert.equal((await run(A, { dryRun: false })).fechados, 0);
  assert.equal((await lead(id)).desfecho, null, 'a decisão da recepção manda');
});

test('(f) SIMULAÇÃO não escreve nada', async () => {
  const id = await mkLead({ name: 'Simulado', phone: '+5519966660006', created_at: '2026-07-01' });
  await mkContrato({ phone: '(19)96666-0006', ini: '2026-08-20' });
  const sim = await withTenant(A, (c) => simular(c, { tenantId: A }));
  assert.ok(sim.some((x) => x.lead_id === id), 'aparece na simulação');
  assert.equal((await lead(id)).desfecho, null, 'mas nada foi escrito');
  const r = await run(A, { dryRun: true });
  assert.equal(r.dry_run, true);
  assert.equal((await lead(id)).desfecho, null);
});

test('(g) TELEFONE em formatos diferentes casa mesmo assim (br_phone_key nos dois lados)', async () => {
  const id = await mkLead({ name: 'Formato', phone: '+5519977770007', created_at: '2026-07-01' });
  await mkContrato({ phone: '19 9 7777-0007', ini: '2026-08-15' });   // grafia diferente
  assert.equal((await run(A, { dryRun: false })).fechados, 1);
  assert.equal((await lead(id)).desfecho, 'matriculado');
});
