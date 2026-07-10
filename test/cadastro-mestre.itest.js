'use strict';

// ============================================================================
// ADR-037 037.1 — prova da migration 060_cadastro_mestre contra Postgres real efêmero.
//  (a) migration aplica sem erro (feito no harness .sh);
//  (b) ISOLAMENTO (D12): 2 tenants; withTenant(A) NÃO vê linhas de B em CADA tabela nova (=0);
//      e SEM contexto de tenant → 0 (a policy esconde tudo);
//  (c) FORCE: relforcerowsecurity=true nas 5 tabelas novas.
// Conecta como lead_manager_user (NÃO superuser, NÃO bypassrls) — fiel à produção (D9).
// ============================================================================

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const NEW_TABLES = ['person', 'contact_point', 'service_account', 'account_member', 'external_ref'];

// withTenant fiel ao src/db.js: BEGIN + SET LOCAL app.current_tenant + COMMIT.
async function withTenant(tid, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_tenant', $1, true)", [tid]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

// Semeia 1 linha em CADA tabela nova para um tenant (sob o contexto desse tenant).
async function seed(tid) {
  await withTenant(tid, async (c) => {
    const personId = (await c.query(
      `INSERT INTO person (tenant_id, display_name) VALUES ($1,$2) RETURNING id`, [tid, 'P-' + tid.slice(0, 4)])).rows[0].id;
    await c.query(
      `INSERT INTO contact_point (tenant_id, person_id, kind, value_raw, source, confidence)
       VALUES ($1,$2,'phone','5519999990000','extranet','alegado')`, [tid, personId]);
    const acctId = (await c.query(
      `INSERT INTO service_account (tenant_id, status, servico_label, periodicidade)
       VALUES ($1,'ativo','Baixo','mensal') RETURNING id`, [tid])).rows[0].id;
    await c.query(
      `INSERT INTO account_member (tenant_id, account_id, person_id, bond)
       VALUES ($1,$2,$3,'beneficiario')`, [tid, acctId, personId]);
    await c.query(
      `INSERT INTO external_ref (tenant_id, entity_kind, entity_id, source, external_type, external_id)
       VALUES ($1,'account',$2,'extranet','contrato','1096')`, [tid, acctId]);
  });
}

before(async () => { await seed(A); await seed(B); });
after(async () => { await pool.end(); });

for (const t of NEW_TABLES) {
  test(`isolamento D12: ${t} — A vê só as suas (1), não vê as de B`, async () => {
    const nA = await withTenant(A, (c) => c.query(`SELECT count(*)::int n FROM ${t}`).then(r => r.rows[0].n));
    const nB = await withTenant(B, (c) => c.query(`SELECT count(*)::int n FROM ${t}`).then(r => r.rows[0].n));
    assert.equal(nA, 1, `A deveria ver só a própria linha em ${t}`);
    assert.equal(nB, 1, `B deveria ver só a própria linha em ${t}`);
    // cruzado explícito: com contexto A, filtrar tenant_id=B → 0
    const cross = await withTenant(A, (c) => c.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id=$1`, [B]).then(r => r.rows[0].n));
    assert.equal(cross, 0, `A NUNCA pode ver linha de B em ${t}`);
  });

  test(`sem contexto de tenant: ${t} → 0 (policy esconde tudo)`, async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); // sem set_config → current_setting('app.current_tenant',true)='' → NULL
      const n = (await c.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
      assert.equal(n, 0, `${t} sem contexto deve retornar 0`);
      await c.query('ROLLBACK');
    } finally { c.release(); }
  });
}

test('FORCE: as 5 tabelas novas têm relforcerowsecurity = true', async () => {
  const rows = (await pool.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='lead_manager' AND c.relname = ANY($1) ORDER BY c.relname`, [NEW_TABLES])).rows;
  console.log('RLS/owner das tabelas novas:', JSON.stringify(rows));
  assert.equal(rows.length, 5, 'as 5 tabelas devem existir');
  for (const r of rows) {
    assert.equal(r.relrowsecurity, true, `${r.relname}: RLS deve estar ENABLE`);
    assert.equal(r.relforcerowsecurity, true, `${r.relname}: RLS deve estar FORCE`);
    assert.equal(r.owner, 'lead_manager_user', `${r.relname}: dono deve ser lead_manager_user`);
  }
});

test('seed dos papéis: aluno/responsavel existem (eixo known, suppression hard) e member segue VAZIA', async () => {
  const roles = (await withTenant('ed731a58-62e5-45ad-acba-a5502ff39e92', (c) => c.query(
    `SELECT key, axis, suppression FROM contact_role WHERE key IN ('aluno','responsavel') ORDER BY key`))).rows;
  console.log('papéis novos:', JSON.stringify(roles));
  assert.equal(roles.length, 2);
  for (const r of roles) { assert.equal(r.axis, 'known'); assert.equal(r.suppression, 'hard'); }
  // contact_role_member NÃO foi populada por esta migration
  const members = (await pool.query(`SELECT count(*)::int n FROM lead_manager.contact_role_member`)).rows[0].n;
  console.log('contact_role_member linhas:', members);
  assert.equal(members, 0, 'a migration não pode popular contact_role_member');
  // e a coluna person_id foi adicionada
  const hasCol = (await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='lead_manager' AND table_name='contact_role_member' AND column_name='person_id'`)).rowCount;
  assert.equal(hasCol, 1, 'contact_role_member.person_id deve existir');
});
