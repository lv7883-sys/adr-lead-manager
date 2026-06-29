'use strict';

// Teste de INTEGRAÇÃO da FRONTEIRA do Sincronizador (fix/sync-preserva-vocacao-sala): o sync
// NUNCA toca os vínculos de vocação de SALA (resource_capability de ROOM) — dado HUMANO,
// atribuído na tela, que a Extranet não fornece (parseSala devolve sem capabilityRefs).
// Roda o CORE real (syncResources) contra um Postgres DESCARTÁVEL (migration 046) com um
// snapshot sintético. NUNCA toca produção.
//
// Provisão: test/run-resources-sync-vocacao-itest.sh.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { pool, withTenant } = require('../src/db');
const { syncResources } = require('../src/resources/sync');

const TENANT_ID = process.env.RESOURCES_TENANT_ID;
const q = (sql, params, tid = TENANT_ID) => withTenant(tid, (c) => c.query(sql, params)).then((r) => r.rows);

let bindingId;

// Snapshot sintético: ROOM exatamente como parseSala devolve (SEM capabilityRefs) +
// TEACHER com competência da fonte (capabilityRefs array).
const SNAPSHOT = {
  capabilities: [
    { ref: 'cap:canto', name: 'Canto' },
    { ref: 'cap:piano', name: 'Piano' },
    { ref: 'cap:guitarra', name: 'Guitarra' },
    { ref: 'cap:violao', name: 'Violão' },
  ],
  resources: [
    // SALA — vocação é dado humano; a fonte NÃO traz capabilityRefs (campo ausente = undefined).
    { ref: '1', type: 'ROOM', name: 'Sala 1', attributes: { apelido: 'Rita Lee', vocacao: 'Canto e Teclas' } },
    // PROFESSOR — competência vem da fonte.
    { ref: 'T1', type: 'TEACHER', name: 'Prof Teste', capabilityRefs: ['cap:guitarra', 'cap:violao'],
      availability: [{ weekday: 1, start: '08:00', end: '12:00' }] },
  ],
};

const roomLinks = () => q(
  `SELECT cap.external_ref FROM resources.resource_capability rc
     JOIN resources.resource r ON r.id=rc.resource_id AND r.type='ROOM'
     JOIN resources.capability cap ON cap.id=rc.capability_id
    ORDER BY cap.external_ref`).then((rows) => rows.map((x) => x.external_ref));
const teacherLinks = () => q(
  `SELECT cap.external_ref FROM resources.resource_capability rc
     JOIN resources.resource r ON r.id=rc.resource_id AND r.type='TEACHER'
     JOIN resources.capability cap ON cap.id=rc.capability_id
    ORDER BY cap.external_ref`).then((rows) => rows.map((x) => x.external_ref));

before(async () => {
  bindingId = (await q(
    `INSERT INTO resources.resource_source_binding (tenant_id, kind, name, status)
     VALUES ($1, 'SCRAPE_EXTRANET', 'fixture', 'ACTIVE') RETURNING id`, [TENANT_ID]))[0].id;
});
after(async () => { await pool.end(); });

// ---------------------------------------------------------------------------
test('1. sync inicial cria recursos; ROOM nasce SEM vínculo (fonte não fornece vocação)', async () => {
  const stats = await withTenant(TENANT_ID, (c) =>
    syncResources(c, { tenantId: TENANT_ID, sourceBindingId: bindingId, snapshot: SNAPSHOT }));
  assert.equal(stats.resources.inserted, 2, '1 sala + 1 prof');
  assert.equal(stats.links.inserted, 2, 'só os 2 vínculos do professor');
  assert.deepEqual(await roomLinks(), [], 'sala sem vínculo (sync não inventa vocação)');
  assert.deepEqual(await teacherLinks(), ['cap:guitarra', 'cap:violao']);
});

test('2. recepção atribui vocação à SALA na tela (2 vínculos de ROOM)', async () => {
  const roomId = (await q(`SELECT id FROM resources.resource WHERE type='ROOM' AND external_ref='1'`))[0].id;
  for (const ref of ['cap:canto', 'cap:piano']) {
    await q(`INSERT INTO resources.resource_capability (tenant_id, resource_id, capability_id)
             SELECT $1, $2, id FROM resources.capability WHERE external_ref=$3`, [TENANT_ID, roomId, ref]);
  }
  assert.deepEqual(await roomLinks(), ['cap:canto', 'cap:piano']);
});

test('3. ASSERT CRÍTICO: rodada do sync (ROOM sem caps) PRESERVA os vínculos da sala', async () => {
  const stats = await withTenant(TENANT_ID, (c) =>
    syncResources(c, { tenantId: TENANT_ID, sourceBindingId: bindingId, snapshot: SNAPSHOT }));

  // ROOM é PULADO (capabilityRefs undefined) → 0 deleções; vínculos da sala intactos.
  assert.equal(stats.links.deleted, 0, 'nenhum vínculo deletado (ROOM nem entra na reconciliação)');
  assert.deepEqual(await roomLinks(), ['cap:canto', 'cap:piano'], 'vocação da SALA preservada após o sync');
  assert.deepEqual(await teacherLinks(), ['cap:guitarra', 'cap:violao'], 'vínculos do professor intactos');
});

test('4. idempotência da fronteira: 2ª rodada seguida também não toca a sala', async () => {
  const stats = await withTenant(TENANT_ID, (c) =>
    syncResources(c, { tenantId: TENANT_ID, sourceBindingId: bindingId, snapshot: SNAPSHOT }));
  assert.equal(stats.links.deleted, 0);
  assert.equal(stats.links.inserted, 0);
  assert.deepEqual(await roomLinks(), ['cap:canto', 'cap:piano']);
});

test('5. REGRESSÃO: professor que perde uma capability na fonte TEM o vínculo removido (ROOM intacto)', async () => {
  // mesmo snapshot, mas o professor agora só tem guitarra (perdeu violão na fonte).
  const semViolao = {
    ...SNAPSHOT,
    resources: SNAPSHOT.resources.map((r) =>
      r.type === 'TEACHER' ? { ...r, capabilityRefs: ['cap:guitarra'] } : r),
  };
  const stats = await withTenant(TENANT_ID, (c) =>
    syncResources(c, { tenantId: TENANT_ID, sourceBindingId: bindingId, snapshot: semViolao }));

  assert.equal(stats.links.deleted, 1, 'o vínculo do PROFESSOR (violão) é removido normalmente');
  assert.deepEqual(await teacherLinks(), ['cap:guitarra'], 'professor reconciliado');
  assert.deepEqual(await roomLinks(), ['cap:canto', 'cap:piano'], 'vocação da SALA segue intacta');
});

test('6. distinção undefined vs []: TEACHER com capabilityRefs=[] É gerenciado (vínculos removidos)', async () => {
  // []  (lista vazia explícita) ≠ undefined: a regra Array.isArray cobre o []. Um TEACHER que
  // zerou as caps na fonte deve perder os vínculos — diferente da SALA (sem o campo), que é pulada.
  const profZerado = {
    ...SNAPSHOT,
    resources: SNAPSHOT.resources.map((r) =>
      r.type === 'TEACHER' ? { ...r, capabilityRefs: [] } : r),
  };
  const stats = await withTenant(TENANT_ID, (c) =>
    syncResources(c, { tenantId: TENANT_ID, sourceBindingId: bindingId, snapshot: profZerado }));

  assert.equal(stats.links.deleted, 1, 'TEACHER com [] perde o vínculo restante (guitarra)');
  assert.deepEqual(await teacherLinks(), [], 'professor sem vínculos');
  assert.deepEqual(await roomLinks(), ['cap:canto', 'cap:piano'], 'SALA (undefined) continua intocada');
});
