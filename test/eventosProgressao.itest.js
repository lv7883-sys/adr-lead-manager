'use strict';

// ============================================================================
// Teste de INTEGRAÇÃO do consumidor Surface A (ADR-022) contra Postgres REAL.
// Aplica a migration 044 num DB de teste e exercita matcher + idempotência +
// escopo por tenant + dedupe canônico do walk-in — não só mock.
//
// Roda só com ITEST_DATABASE_URL apontando p/ um banco DESCARTÁVEL (guard de
// segurança exige 'itest'/'test' no nome do DB — nunca prod). Sem a env, a suíte
// é PULADA (o `node --test test/` segue verde no CI/local sem Postgres).
//
//   docker run -d --rm --name lm-itest-pg -e POSTGRES_PASSWORD=itest \
//     -e POSTGRES_DB=lm_itest -p 55444:5432 postgres:16-alpine
//   ITEST_DATABASE_URL=postgres://postgres:itest@localhost:55444/lm_itest \
//     node --test test/eventosProgressao.itest.js
// ============================================================================

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const URL = process.env.ITEST_DATABASE_URL;
const dbName = URL ? (URL.split('/').pop() || '').split('?')[0] : '';
const SAFE = URL && /(itest|test)/i.test(dbName);

// Sem DB de teste → suíte pulada inteira (não falha o `npm test` sem Postgres).
describe('integração Surface A (Postgres real)', { skip: SAFE ? false : 'defina ITEST_DATABASE_URL p/ um DB de teste descartável' }, () => {
  const { Pool } = require('pg');
  const { processarEvento } = require('../src/eventosProgressao');

  const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  let pool;

  // Espelha db.js::withTenant + search_path do lead_manager_user (RLS + tabelas
  // sem schema-qualify, igual ao runtime).
  async function withTenant(tenantId, fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL search_path = lead_manager, public');
      await c.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  const run = (tenantId, evento) => withTenant(tenantId, (c) => processarEvento(c, { tenantId, evento }));
  async function q(sql, params) {
    const c = await pool.connect();
    try { await c.query('SET search_path = lead_manager, public'); return await c.query(sql, params); }
    finally { c.release(); }
  }
  const base = { source_adapter: 'extranet', situacao: 'ativo' };

  before(async () => {
    pool = new Pool({ connectionString: URL, max: 4 });
    // Bootstrap: schema + tabelas-base (forma PRÉ-044) + role/tenants, depois a 044.
    await q(`
      CREATE SCHEMA IF NOT EXISTS lead_manager;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='lead_manager_user')
        THEN CREATE ROLE lead_manager_user; END IF; END $$;
      CREATE TABLE IF NOT EXISTS lead_manager.tenants (id uuid PRIMARY KEY, nome text);
      CREATE TABLE IF NOT EXISTS lead_manager.leads (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        name text, phone text,
        status text NOT NULL DEFAULT 'NEW',
        desfecho text, desfecho_em timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_tenant_phone
        ON lead_manager.leads (tenant_id, phone) WHERE phone IS NOT NULL;
      CREATE TABLE IF NOT EXISTS lead_manager.lead_eventos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL, lead_id uuid, tipo text, autor text,
        conteudo text, etapa_key text, created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO lead_manager.tenants (id, nome) VALUES
        ('${A}','Tenant A'), ('${B}','Tenant B'),
        ('ed731a58-62e5-45ad-acba-a5502ff39e92','Valinhos')
      ON CONFLICT (id) DO NOTHING;
    `);
    const mig = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '044_surface_a_progressao.sql'), 'utf8');
    await q(mig); // idempotente; cria ledger (UNIQUE CONSTRAINT), label, unit_map, colunas
  });

  after(async () => { if (pool) await pool.end(); });

  beforeEach(async () => {
    await q('TRUNCATE lead_manager.leads, lead_manager.lead_eventos, lead_manager.lead_eval_label, lead_manager.progressao_event_ledger');
  });

  const seedLead = (tenant, { name, phone = null, status = 'QUALIFYING' }) =>
    q(`INSERT INTO lead_manager.leads (tenant_id, name, phone, status) VALUES ($1,$2,$3,$4) RETURNING id`,
      [tenant, name, phone, status]).then((r) => r.rows[0].id);
  const leadsOf = (tenant) =>
    q('SELECT id, phone, status, student_name FROM lead_manager.leads WHERE tenant_id=$1', [tenant]).then((r) => r.rows);

  // ── DESTAQUE 1: dois formatos BR do MESMO número casam o MESMO lead ──────────
  test('telefone: com/sem 9º dígito e com/sem +55 → MESMO lead (sem duplicar)', async () => {
    // Lead gravado com 9º dígito + DDI: "+55 19 99999-1234".
    const id = await seedLead(A, { name: 'Cliente Existente', phone: '+5519999991234' });
    // Evento traz o MESMO número SEM o 9º dígito e com 55: "55 19 9999-1234".
    const out = await run(A, { ...base, tipo: 'experimental_realizada', source_record_id: 'aula-tel', telefone: '551999991234' });
    assert.equal(out.match, 'phone', 'casou por telefone canônico');
    assert.equal(out.lead_id, id, 'casou o lead já existente');
    assert.equal(out.resultado, 'advanced');
    assert.equal((await leadsOf(A)).length, 1, 'NÃO criou segundo registro');
  });

  // ── DESTAQUE 2: enriquecimento do walk-in entre adapters ────────────────────
  test('enriquecimento: experimental SEM telefone + matrícula COM telefone = 1 registro', async () => {
    // 1) Experimental só com nome → cria walk-in sem telefone.
    const e1 = await run(A, { ...base, tipo: 'experimental_realizada', source_record_id: 'aula-pedro', student_name: 'Pedro Henrique Souza' });
    assert.equal(e1.resultado, 'walk_in');
    let leads = await leadsOf(A);
    assert.equal(leads.length, 1);
    assert.equal(leads[0].phone, null, 'walk-in nasceu sem telefone');

    // 2) Matrícula do mesmo aluno, agora COM telefone (registro/situação diferentes).
    const e2 = await run(A, { ...base, situacao: 'matriculado', tipo: 'matricula_confirmada', source_record_id: 'mat-pedro', student_name: 'Pedro Henrique Souza', telefone: '5519988887777' });
    assert.equal(e2.resultado, 'concluded', 'concluiu o MESMO lead');
    assert.equal(e2.lead_id, leads[0].id, 'mesmo lead, não um novo');

    leads = await leadsOf(A);
    assert.equal(leads.length, 1, 'continua 1 registro (não duplicou entre adapters)');
    assert.equal(leads[0].phone, '+5519988887777', 'walk-in foi ENRIQUECIDO com o telefone canônico');
    assert.equal(leads[0].status, 'CONVERTED');
    const led = await q('SELECT count(*)::int n FROM lead_manager.progressao_event_ledger WHERE tenant_id=$1', [A]);
    assert.equal(led.rows[0].n, 2, 'dois eventos no ledger (experimental + matrícula)');
  });

  // ── DESTAQUE 3: dedupe do walk-in pela chave CANÔNICA (não cru) ──────────────
  test('walk-in: dois eventos do mesmo número (formatos diferentes) → 1 lead, phone canônico', async () => {
    // 1º experimental sem nome casável → cria walk-in com phone canônico.
    const e1 = await run(A, { ...base, tipo: 'experimental_realizada', source_record_id: 'aula-rua-1', telefone: '19999990000' });
    assert.equal(e1.resultado, 'walk_in');
    // 2º experimental, MESMO número noutro formato (com 55, sem 9º) → matcher acha o 1º.
    const e2 = await run(A, { ...base, tipo: 'experimental_realizada', source_record_id: 'aula-rua-2', telefone: '551999990000' });
    assert.equal(e2.lead_id, e1.lead_id, 'casou o walk-in anterior pela chave canônica');
    const leads = await leadsOf(A);
    assert.equal(leads.length, 1, 'um único lead (dedupe canônico, não cru)');
    assert.ok(leads[0].phone.startsWith('+55'), 'gravado no formato canônico, não cru');
  });

  test('walk-in ON CONFLICT: INSERT bruto do mesmo phone canônico não duplica', async () => {
    await q(`INSERT INTO lead_manager.leads (tenant_id, name, phone, status, origem)
             VALUES ($1,'Rua','+5519977776666','EXPERIMENTAL_AGENDADA','walk_in')`, [A]);
    // Re-insert do MESMO phone canônico → ON CONFLICT (tenant, phone) faz upsert, não 2ª linha.
    await q(`INSERT INTO lead_manager.leads (tenant_id, name, phone, status, origem)
             VALUES ($1,'Rua','+5519977776666','CONVERTED','walk_in')
             ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL
             DO UPDATE SET status = EXCLUDED.status`, [A]);
    assert.equal((await leadsOf(A)).length, 1, 'ON CONFLICT pela chave canônica evitou duplicata');
  });

  // ── Idempotência no banco (UNIQUE CONSTRAINT do ledger) ─────────────────────
  test('idempotência: mesmo (tenant,adapter,registro,situação) → 2ª vez é no-op', async () => {
    await seedLead(A, { name: 'Idem', phone: '+5519944443333' });
    const ev = { ...base, tipo: 'experimental_realizada', source_record_id: 'aula-idem', telefone: '5519944443333' };
    const o1 = await run(A, ev);
    assert.equal(o1.resultado, 'advanced');
    const o2 = await run(A, ev);
    assert.equal(o2.status, 'duplicate', '2ª vez detectada como duplicada');
    const n = await q('SELECT count(*)::int n FROM lead_manager.progressao_event_ledger WHERE tenant_id=$1', [A]);
    assert.equal(n.rows[0].n, 1, 'uma única linha no ledger');
  });

  test('idempotência: UNIQUE CONSTRAINT existe e barra INSERT bruto duplicado', async () => {
    const con = await q(`SELECT 1 FROM pg_constraint WHERE conname='progressao_ledger_uq' AND contype='u'`);
    assert.equal(con.rowCount, 1, 'a chave de idempotência é UNIQUE CONSTRAINT (não só índice)');
    const ins = () => q(`INSERT INTO lead_manager.progressao_event_ledger
        (tenant_id, source_adapter, source_record_id, situacao, tipo, resultado)
        VALUES ($1,'extranet','rec-x','ativo','experimental_realizada','advanced')`, [A]);
    await ins();
    await assert.rejects(ins(), /duplicate key|progressao_ledger_uq/, 'constraint barra o duplicado');
  });

  // ── Escopo por tenant (matcher na aplicação, não só RLS) ────────────────────
  test('escopo por tenant: telefone do tenant B NÃO casa evento do tenant A', async () => {
    const idB = await seedLead(B, { name: 'Do Tenant B', phone: '+5511955554444' });
    // Evento p/ A com o MESMO telefone que existe em B, e nome sem match em A.
    const out = await run(A, { ...base, tipo: 'experimental_realizada', source_record_id: 'aula-cross', student_name: 'Alguem De Rua', telefone: '5511955554444' });
    assert.equal(out.resultado, 'walk_in', 'não cruzou tenant: virou walk-in em A');
    assert.notEqual(out.lead_id, idB, 'não tocou o lead do tenant B');
    const a = await leadsOf(A), b = await leadsOf(B);
    assert.equal(a.length, 1, 'A ganhou só o walk-in novo');
    assert.equal(b.length, 1, 'B intacto');
  });
});
