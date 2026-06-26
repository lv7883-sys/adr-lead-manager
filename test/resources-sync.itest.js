'use strict';

// Testes de INTEGRAÇÃO do Sincronizador de Recursos (ADR-026, Parte 1).
// Roda o PARSE do adapter Valinhos contra HTML salvo (RESOURCES_FIXTURES) e prova
// upsert/idempotência/soft-delete/RLS do CORE contra um Postgres DESCARTÁVEL com a
// migration 046 aplicada. NUNCA toca produção (DATABASE_URL = PG efêmero do harness).
//
// Provisão: test/run-resources-sync-itest.sh (sobe PG, bootstrap + 046, exporta envs).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { pool, withTenant } = require('../src/db');
const { syncResources } = require('../src/resources/sync');
const valinhos = require('../src/resources/adapters/valinhos');
const { validateSnapshot } = require('../src/resources/snapshot');

const TENANT_ID = process.env.RESOURCES_TENANT_ID;
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
const FIX = process.env.RESOURCES_FIXTURES;

const dirs = {
  salasDir: path.join(FIX, 'raw'),
  cursosDir: path.join(FIX, 'raw'),
  cadastroDirs: [path.join(FIX, 'raw-cad'), path.join(FIX, 'raw-cad28')],
};

let snapshot;
let bindingId;
const q = (sql, params, tid = TENANT_ID) => withTenant(tid, (c) => c.query(sql, params)).then((r) => r.rows);

before(async () => {
  // fixture de binding no PG efêmero (NÃO é binding real/prod; sem credencial).
  const r = await withTenant(TENANT_ID, (c) => c.query(
    `INSERT INTO resources.resource_source_binding (tenant_id, kind, name, status)
     VALUES ($1, 'SCRAPE_EXTRANET', 'fixture', 'ACTIVE') RETURNING id`, [TENANT_ID]));
  bindingId = r.rows[0].id;
});

after(async () => { await pool.end(); });

// ---------------------------------------------------------------------------
test('1. parse dos HTMLs salvos → ResourceSnapshot com as contagens consolidadas', () => {
  snapshot = valinhos.parse(dirs);
  validateSnapshot(snapshot);

  const rooms = snapshot.resources.filter((r) => r.type === 'ROOM');
  const teachers = snapshot.resources.filter((r) => r.type === 'TEACHER');
  const vinculos = teachers.reduce((n, t) => n + (t.capabilityRefs?.length || 0), 0);
  const avail = teachers.reduce((n, t) => n + (t.availability?.length || 0), 0);
  const capsUsadas = new Set(teachers.flatMap((t) => t.capabilityRefs || []));

  assert.equal(rooms.length, 9, 'salas');
  assert.equal(teachers.length, 24, 'professores ativos');
  assert.equal(snapshot.capabilities.length, 22, 'capabilities no catálogo');
  assert.equal(capsUsadas.size, 10, 'capabilities instanciadas');
  assert.equal(vinculos, 72, 'vínculos professor↔capability (dedup)');
  assert.equal(avail, 136, 'linhas de disponibilidade');
});

test('2. 1ª execução do core (banco vazio) cria tudo; contagens batem com o snapshot', async () => {
  const stats = await withTenant(TENANT_ID, (c) =>
    syncResources(c, { tenantId: TENANT_ID, sourceBindingId: bindingId, snapshot }));
  assert.equal(stats.resources.inserted, 33);
  assert.equal(stats.capabilities.inserted, 22);

  const [{ n: nres }] = await q(`SELECT count(*)::int n FROM resources.resource WHERE active`);
  const [{ n: ncap }] = await q(`SELECT count(*)::int n FROM resources.capability`);
  const [{ n: nlink }] = await q(`SELECT count(*)::int n FROM resources.resource_capability`);
  const [{ n: navail }] = await q(`SELECT count(*)::int n FROM resources.resource_availability`);
  assert.equal(nres, 33, 'recursos ativos (9 salas + 24 profs)');
  assert.equal(ncap, 22, 'capabilities');
  assert.equal(nlink, 72, 'vínculos');
  assert.equal(navail, 136, 'disponibilidades');
});

test('3. IDEMPOTÊNCIA: 2ª execução com o mesmo snapshot não duplica nem altera', async () => {
  const before = await q(
    `SELECT (SELECT count(*) FROM resources.resource)             r,
            (SELECT count(*) FROM resources.capability)           c,
            (SELECT count(*) FROM resources.resource_capability)  l,
            (SELECT count(*) FROM resources.resource_availability) a`);
  const stats = await withTenant(TENANT_ID, (c) =>
    syncResources(c, { tenantId: TENANT_ID, sourceBindingId: bindingId, snapshot }));

  assert.equal(stats.resources.inserted, 0, 'nada inserido');
  assert.equal(stats.capabilities.inserted, 0);
  assert.equal(stats.links.inserted, 0);
  assert.equal(stats.links.deleted, 0);
  assert.equal(stats.availability.inserted, 0);
  assert.equal(stats.availability.deleted, 0);
  assert.equal(stats.resources.softDeleted, 0);

  const after = await q(
    `SELECT (SELECT count(*) FROM resources.resource)             r,
            (SELECT count(*) FROM resources.capability)           c,
            (SELECT count(*) FROM resources.resource_capability)  l,
            (SELECT count(*) FROM resources.resource_availability) a`);
  assert.deepEqual(after[0], before[0], 'contagens idênticas após 2ª rodada');
});

test('4. SOFT-DELETE: prof some do snapshot → active=false e sai da busca; reaparece → reativa', async () => {
  const ALVO = '17'; // Giovanni (external_ref do cadastro)
  const encaixeSql =
    `SELECT count(*)::int n FROM resources.resource r
       JOIN resources.resource_availability a ON a.resource_id = r.id
      WHERE r.type = 'TEACHER' AND r.active`;

  const [{ n: antes }] = await q(encaixeSql);
  const semAlvo = { ...snapshot, resources: snapshot.resources.filter((r) => !(r.type === 'TEACHER' && r.ref === ALVO)) };

  const s1 = await withTenant(TENANT_ID, (c) =>
    syncResources(c, { tenantId: TENANT_ID, sourceBindingId: bindingId, snapshot: semAlvo }));
  assert.equal(s1.resources.softDeleted, 1, 'um soft-delete');

  const [alvo] = await q(`SELECT active FROM resources.resource WHERE type='TEACHER' AND external_ref=$1`, [ALVO]);
  assert.equal(alvo.active, false, 'alvo inativo');

  const [{ n: depois }] = await q(encaixeSql);
  const [{ n: linhasAlvo }] = await q(
    `SELECT count(*)::int n FROM resources.resource_availability a
       JOIN resources.resource r ON r.id=a.resource_id
      WHERE r.external_ref=$1 AND r.type='TEACHER'`, [ALVO]);
  assert.ok(linhasAlvo > 0, 'disponibilidade do alvo preservada (histórico)');
  assert.equal(depois, antes - linhasAlvo, 'busca de encaixe perde exatamente as linhas do alvo');

  const [{ n: outros }] = await q(`SELECT count(*)::int n FROM resources.resource WHERE active AND type='TEACHER'`);
  assert.equal(outros, 23, 'os outros professores intactos');

  // reaparece → reativa pelo MESMO external_ref
  const s2 = await withTenant(TENANT_ID, (c) =>
    syncResources(c, { tenantId: TENANT_ID, sourceBindingId: bindingId, snapshot }));
  assert.equal(s2.resources.reactivated, 1, 'reativado');
  const [alvo2] = await q(`SELECT active FROM resources.resource WHERE type='TEACHER' AND external_ref=$1`, [ALVO]);
  assert.equal(alvo2.active, true, 'alvo reativado');
  const [{ n: voltou }] = await q(encaixeSql);
  assert.equal(voltou, antes, 'busca de encaixe volta ao total original');
});

test('5. FRONTEIRA: o core não contém nenhuma string específica do adapter', () => {
  const blocklist = [
    'extranet', 'buscar_lista', 'update.php', 'monta_lista', 'disponibilidade_salas',
    'id_sala', 'scrape_extranet', 'valinhos', 'depara', 'cursos[', 'guitarra', 'bateria', 'violino',
  ];
  for (const file of ['../src/resources/sync.js', '../src/resources/snapshot.js']) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8').toLowerCase();
    for (const tok of blocklist) {
      assert.ok(!src.includes(tok), `vazou "${tok}" no core (${file})`);
    }
  }
});

test('6. RLS: as escritas são confinadas ao tenant (outro tenant não enxerga nada)', async () => {
  const [{ n: meu }] = await q(`SELECT count(*)::int n FROM resources.resource`);
  assert.ok(meu >= 33, 'meu tenant enxerga seus recursos');
  const [{ n: alheio }] = await q(`SELECT count(*)::int n FROM resources.resource`, [], OTHER_TENANT);
  assert.equal(alheio, 0, 'outro tenant enxerga ZERO (RLS isola)');
});
