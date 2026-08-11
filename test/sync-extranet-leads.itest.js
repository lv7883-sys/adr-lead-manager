'use strict';
// sync-extranet-leads.itest.js — SYNC de leads da Extranet (migr 102). Prova ISOLADA (PG
// descartável) do syncExtranetLeads com snapshot SINTÉTICO (sem Extranet): espelho/soft-delete,
// dedup por br_phone_key (com/sem 55, com/sem 9º dígito), régua FORWARD-ONLY com guardas
// (latch humano, desfecho, terminal), matrícula direta (desfecho_source='extranet'),
// idempotência de re-run, sustainedStageKey (guarda EXTRANET > IA) e isolamento cross-tenant.
// NUNCA toca produção.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, withTenant } = require('../src/db');
const { syncExtranetLeads } = require('../src/cadastro/sync-extranet-leads');
const { mapSituacao, normSituacao, sustainedStageKey } = require('../src/cadastro/extranetLeadStage');

const A = process.env.RESOURCES_TENANT_A;
const B = process.env.RESOURCES_TENANT_B;

const row = (extranetId, over = {}) => ({
  extranetId, nome: 'Lead ' + extranetId, foneRaw: null, curso: 'Bateria', professor: 'Prof X',
  situacao: 'Conexão', dataCadastro: '2026-08-10T15:00:00-03:00', ultContato: '2026-08-10',
  proxContato: null, ...over });
const sync = (t, leads, mode = 'auto') =>
  withTenant(t, (c) => syncExtranetLeads(c, { tenantId: t, snapshot: { leads }, mode }));

const espelho = (t, extId) => withTenant(t, async (c) => (await c.query(
  `SELECT nome, fone_raw, situacao, phone_key, lead_id, fonte_ausente_em
     FROM lead_manager.extranet_lead WHERE extranet_id=$1`, [extId])).rows[0] || null);
const lead = (t, id) => withTenant(t, async (c) => (await c.query(
  `SELECT id, name, phone, status, desfecho, desfecho_source, origem, suggested_stage
     FROM lead_manager.leads WHERE id=$1`, [id])).rows[0] || null);
const leadsPorFone = (t, like) => withTenant(t, async (c) => (await c.query(
  `SELECT id, phone, status, origem FROM lead_manager.leads WHERE phone LIKE $1 ORDER BY created_at`, [like])).rows);
const eventos = (t, leadId) => withTenant(t, async (c) => (await c.query(
  `SELECT tipo, autor, etapa_key FROM lead_manager.lead_eventos WHERE lead_id=$1 ORDER BY created_at`, [leadId])).rows);
const logs = (t, leadId) => withTenant(t, async (c) => (await c.query(
  `SELECT from_stage, to_stage, source, prior_status FROM lead_manager.stage_autoapply_log
    WHERE lead_id=$1 ORDER BY created_at`, [leadId])).rows);
const mkLead = (t, over = {}) => withTenant(t, async (c) => (await c.query(
  `INSERT INTO lead_manager.leads (tenant_id, name, phone, status, desfecho, desfecho_em, origem, review_result, review_by)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
  [t, over.name || 'Pré-existente', over.phone || null, over.status || 'NEW', over.desfecho || null,
   over.desfecho_em || null, over.origem || 'whatsapp', over.review_result || null, over.review_by || null])).rows[0].id);

before(async () => {}); after(async () => { await pool.end(); });

test('(u) unit — normSituacao/mapSituacao', () => {
  assert.equal(normSituacao('Exp. Agendada'), 'exp agendada');
  assert.deepEqual(mapSituacao('Exp. Agendada'), { key: 'experimental', known: true });
  assert.deepEqual(mapSituacao('CONEXÃO'), { key: 'qualificando', known: true });
  assert.deepEqual(mapSituacao('Matriculado'), { key: 'convertido', known: true });
  assert.deepEqual(mapSituacao('Desistiu'), { key: null, known: true });       // mirror-only mapeado
  assert.deepEqual(mapSituacao('Situação Nova Qualquer'), { key: null, known: false });
});

test('(a) NOVO → espelho + lead criado (origem extranet, +55, NEW) + régua move no MESMO run', async () => {
  const st = await sync(A, [row('X1', { foneRaw: '(19)99630-7558' })]);
  assert.equal(st.espelho_novos, 1); assert.equal(st.leads_criados, 1); assert.equal(st.movidos, 1);
  const e = await espelho(A, 'X1');
  assert.notEqual(e.lead_id, null); assert.notEqual(e.phone_key, '');
  const l = await lead(A, e.lead_id);
  assert.equal(l.origem, 'extranet');
  assert.equal(l.phone, '+5519996307558');                  // toE164BR na escrita
  assert.equal(l.status, 'QUALIFYING');                     // Conexão → qualificando (auto)
  const ev = await eventos(A, e.lead_id);
  assert.equal(ev.length, 1); assert.equal(ev[0].autor, 'extranet_auto'); assert.equal(ev[0].etapa_key, 'qualificando');
  const lg = await logs(A, e.lead_id);
  assert.equal(lg.length, 1); assert.equal(lg[0].source, 'extranet_lead'); assert.equal(lg[0].prior_status, 'NEW');
});

test('(b) DEDUP por br_phone_key: variante sem 9º dígito casa lead existente — NÃO cria', async () => {
  const preId = await mkLead(A, { phone: '+5519999990001', status: 'NEW' });
  // Extranet grava sem o 9º dígito e sem 55: (19)9999-0001 → mesma chave canônica
  const st = await sync(A, [row('X1', { foneRaw: '(19)99630-7558' }), row('X2', { foneRaw: '(19)9999-0001', situacao: 'Exp. Agendada' })]);
  assert.equal(st.leads_criados, 0); assert.equal(st.linkados, 1);
  const e = await espelho(A, 'X2');
  assert.equal(e.lead_id, preId, 'linkou no lead pré-existente');
  assert.equal((await leadsPorFone(A, '%99990001')).length, 1, 'não criou segundo lead');
  assert.equal((await lead(A, preId)).status, 'EXPERIMENTAL_AGENDADA', 'Exp. Agendada → experimental');
});

test('(c) FORWARD-ONLY: situação atrás da etapa atual = no-op; re-run idempotente', async () => {
  const e = await espelho(A, 'X2');
  // X2 está em experimental; situação Conexão (ordinal menor) não rebaixa
  const st = await sync(A, [row('X1', { foneRaw: '(19)99630-7558' }), row('X2', { foneRaw: '(19)9999-0001', situacao: 'Conexão' })]);
  assert.equal(st.movidos, 0);
  assert.equal((await lead(A, e.lead_id)).status, 'EXPERIMENTAL_AGENDADA');
  // re-run com o MESMO snapshot: nada novo (X1 já está em qualificando)
  const st2 = await sync(A, [row('X1', { foneRaw: '(19)99630-7558' }), row('X2', { foneRaw: '(19)9999-0001', situacao: 'Conexão' })]);
  assert.equal(st2.movidos + st2.leads_criados + st2.espelho_novos, 0);
  assert.equal((await eventos(A, e.lead_id)).length, 1, 'sem evento duplicado');
});

test('(d) MATRÍCULA direta: CONVERTED + desfecho matriculado + desfecho_source=extranet + log', async () => {
  const e = await espelho(A, 'X2');
  const st = await sync(A, [row('X1', { foneRaw: '(19)99630-7558' }), row('X2', { foneRaw: '(19)9999-0001', situacao: 'Matriculado' })]);
  assert.equal(st.movidos, 1);
  const l = await lead(A, e.lead_id);
  assert.equal(l.status, 'CONVERTED'); assert.equal(l.desfecho, 'matriculado'); assert.equal(l.desfecho_source, 'extranet');
  const lg = await logs(A, e.lead_id);
  assert.equal(lg[lg.length - 1].to_stage, 'convertido');
  // re-run: terminal (desfecho existe) → intocável, sem novo evento
  const st2 = await sync(A, [row('X1', { foneRaw: '(19)99630-7558' }), row('X2', { foneRaw: '(19)9999-0001', situacao: 'Matriculado' })]);
  assert.equal(st2.movidos, 0);
});

test('(e) GUARDAS: latch humano e desfecho humano são intocáveis', async () => {
  const latched = await mkLead(A, { phone: '+5519999990002', status: 'NOT_LEAD', review_result: 'confirmed_not_lead', review_by: 'kessia' });
  const matric = await mkLead(A, { phone: '+5519999990003', status: 'CONVERTED', desfecho: 'matriculado', desfecho_em: new Date() });
  const st = await sync(A, [
    row('X1', { foneRaw: '(19)99630-7558' }), row('X2', { foneRaw: '(19)9999-0001', situacao: 'Matriculado' }),
    row('X3', { foneRaw: '19 99999-0002', situacao: 'Exp. Agendada' }),
    row('X4', { foneRaw: '19 99999-0003', situacao: 'Conexão' }),
  ]);
  assert.equal(st.movidos, 0);
  assert.equal((await lead(A, latched)).status, 'NOT_LEAD', 'latch humano intocado');
  const m = await lead(A, matric);
  assert.equal(m.desfecho, 'matriculado'); assert.equal(m.desfecho_source, null, 'decisão humana preservada');
});

test('(e2) DISPENSA HUMANA (reverter no Monitor): AUTO não re-aplica etapa dispensada', async () => {
  const dism = await mkLead(A, { phone: '+5519999990005', status: 'NEW' });
  await withTenant(A, (c) => c.query(
    "UPDATE lead_manager.leads SET suggested_stage_dismissed='experimental' WHERE id=$1", [dism]));
  const st = await sync(A, [
    row('X1', { foneRaw: '(19)99630-7558' }), row('X2', { foneRaw: '(19)9999-0001', situacao: 'Matriculado' }),
    row('X3', { foneRaw: '19 99999-0002', situacao: 'Exp. Agendada' }), row('X4', { foneRaw: '19 99999-0003', situacao: 'Conexão' }),
    row('XD', { foneRaw: '19 99999-0005', situacao: 'Exp. Agendada' }),
  ]);
  assert.equal(st.movidos, 0, 'etapa dispensada por humano não é re-aplicada');
  assert.equal((await lead(A, dism)).status, 'NEW');
  // situação NOVA (outra etapa) volta a valer: Conexão → qualificando move normalmente
  const st2 = await sync(A, [
    row('X1', { foneRaw: '(19)99630-7558' }), row('X2', { foneRaw: '(19)9999-0001', situacao: 'Matriculado' }),
    row('X3', { foneRaw: '19 99999-0002', situacao: 'Exp. Agendada' }), row('X4', { foneRaw: '19 99999-0003', situacao: 'Conexão' }),
    row('XD', { foneRaw: '19 99999-0005', situacao: 'Conexão' }),
  ]);
  assert.equal(st2.movidos, 1);
  assert.equal((await lead(A, dism)).status, 'QUALIFYING');
});

test('(f) SUGGESTION mode: só suggested_stage, não move', async () => {
  const sugId = await mkLead(A, { phone: '+5519999990004', status: 'NEW' });
  const st = await sync(A, [
    row('X1', { foneRaw: '(19)99630-7558' }), row('X2', { foneRaw: '(19)9999-0001', situacao: 'Matriculado' }),
    row('X3', { foneRaw: '19 99999-0002', situacao: 'Exp. Agendada' }), row('X4', { foneRaw: '19 99999-0003', situacao: 'Conexão' }),
    row('X5', { foneRaw: '19 99999-0004', situacao: 'Exp. Agendada' }),
  ], 'suggestion');
  assert.equal(st.movidos, 0); assert.equal(st.sugeridos, 1);
  const l = await lead(A, sugId);
  assert.equal(l.status, 'NEW', 'não moveu');
  assert.equal(l.suggested_stage, 'experimental');
});

test('(g) DESCONHECIDA → mirror-only + stats; SEM TELEFONE → mirror-only', async () => {
  const st = await sync(A, [
    row('X1', { foneRaw: '(19)99630-7558' }), row('X2', { foneRaw: '(19)9999-0001', situacao: 'Matriculado' }),
    row('X3', { foneRaw: '19 99999-0002', situacao: 'Exp. Agendada' }), row('X4', { foneRaw: '19 99999-0003', situacao: 'Conexão' }),
    row('X5', { foneRaw: '19 99999-0004', situacao: 'Exp. Agendada' }),
    row('X6', { foneRaw: '19 99999-0006', situacao: 'Aguardando Retorno Zap' }),
    row('X7', { foneRaw: null, situacao: 'Conexão' }),
  ]);
  assert.deepEqual(st.situacao_desconhecida, ['Aguardando Retorno Zap']);
  assert.equal(st.sem_telefone, 1);
  const x6 = await espelho(A, 'X6');
  assert.notEqual(x6.lead_id, null, 'desconhecida ainda cria/linka lead (só não move)');
  assert.equal((await lead(A, x6.lead_id)).status, 'NEW');
  assert.equal((await espelho(A, 'X7')).lead_id, null, 'sem telefone não cria lead');
});

test('(h) SOFT-DELETE ao sumir + REAPARECER limpa + sustainedStageKey acompanha', async () => {
  const e2 = await espelho(A, 'X2');
  // X2 (Matriculado→convertido) some do snapshot
  const st = await sync(A, [row('X1', { foneRaw: '(19)99630-7558' })]);
  assert.ok(st.soft_deleted >= 1);
  assert.notEqual((await espelho(A, 'X2')).fonte_ausente_em, null, 'marcado ausente, não apagado');
  // sustained: X1 (Conexão → qualificando) presente; X2 ausente não sustenta nada
  const e1 = await espelho(A, 'X1');
  const s1 = await withTenant(A, (c) => sustainedStageKey(c, { tenantId: A, leadId: e1.lead_id }));
  assert.equal(s1, 'qualificando');
  const s2 = await withTenant(A, (c) => sustainedStageKey(c, { tenantId: A, leadId: e2.lead_id }));
  assert.equal(s2, null, 'link soft-deletado não sustenta etapa');
  // reaparece com situação nova
  await sync(A, [row('X1', { foneRaw: '(19)99630-7558' }), row('X2', { foneRaw: '(19)9999-0001', situacao: 'Exp. Agendada' })]);
  assert.equal((await espelho(A, 'X2')).fonte_ausente_em, null);
  const s2b = await withTenant(A, (c) => sustainedStageKey(c, { tenantId: A, leadId: e2.lead_id }));
  assert.equal(s2b, 'experimental');
});

test('(h2) JANELA: ausente do snapshot mas MAIS VELHO que windowStart NÃO é soft-deletado', async () => {
  // X8 é histórico (maio); entra no espelho num sync sem janela
  await sync(A, [row('X1', { foneRaw: '(19)99630-7558' }), row('X2', { foneRaw: '(19)9999-0001', situacao: 'Exp. Agendada' }),
    row('X8', { foneRaw: '19 99999-0008', dataCadastro: '2026-05-01T10:00:00-03:00' })]);
  // snapshot em janela (>= 01/08) sem X8 (envelheceu) e sem X2 (sumiu DE FATO dentro da janela)
  const st = await withTenant(A, (c) => syncExtranetLeads(c, {
    tenantId: A, snapshot: { leads: [row('X1', { foneRaw: '(19)99630-7558' })], windowStart: '2026-08-01' }, mode: 'auto' }));
  assert.equal(st.soft_deleted, 1, 'só o X2 (dentro da janela) foi marcado');
  assert.equal((await espelho(A, 'X8')).fonte_ausente_em, null, 'X8 envelheceu p/ fora da janela — intocado');
  assert.notEqual((await espelho(A, 'X2')).fonte_ausente_em, null, 'X2 sumiu dentro da janela — marcado');
});

test('(i) CROSS-TENANT = 0: espelho e leads de A invisíveis a B', async () => {
  await sync(B, [row('X1', { foneRaw: '(19)98888-0001' })]);
  const eB = await espelho(B, 'X2');
  assert.equal(eB, null, 'X2 (só de A) invisível a B');
  assert.equal((await leadsPorFone(B, '%99630755%')).length, 0, 'lead de A invisível a B');
});
