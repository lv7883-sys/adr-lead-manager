'use strict';

// ============================================================================
// fix/gate-matchkeys-hardening — os DOIS lookups de telefone do gate que ainda
// usavam igualdade EXATA de dígitos passam a casar BR-aware via telBR.matchKeys
// (= ANY($::text[])), IDÊNTICO a _presignalActive / opt-out / _isRelationshipContact:
//   - _lookupRole            (contact_role_member ⋈ contact_role)  — caminho 'hard'
//   - contato interno        (internal_contacts, ADR-018)          — descarte
//
// ITEST contra Postgres real (efêmero — ver run-gate-matchkeys-hardening-itest.sh).
// Cada caso INSERE o fixture numa transação e faz ROLLBACK: NADA é gravado no banco.
// A query exercitada é a RÉPLICA FIEL da corrigida em src/engine.js — mesma SQL
// (regexp_replace('[^0-9]','') = ANY($::text[])) e o MESMO helper (src/telefoneBR.js).
// ============================================================================

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const telBR = require('../src/telefoneBR');

const TENANT = '11111111-1111-1111-1111-111111111111';   // hardcode do bootstrap
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

after(async () => { await pool.end(); });

// Roda `fn` numa transação com contexto de tenant e SEMPRE faz ROLLBACK:
// o fixture inserido nunca persiste (guardrail "nenhuma escrita no banco").
async function inRolledBackTx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_tenant', $1, true)", [TENANT]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

// Réplica FIEL de _lookupRole corrigido (src/engine.js): BR-aware via ANY(matchKeys).
async function lookupRoleSQL(c, inbound) {
  const keys = inbound ? telBR.matchKeys(inbound) : [];
  if (!keys.length) return null;
  const r = await c.query(
    `SELECT cr.id AS role_id, cr.key, cr.suppression
       FROM contact_role_member m
       JOIN contact_role cr ON cr.id = m.role_id
      WHERE m.tenant_id = $1
        AND regexp_replace(m.phone, '[^0-9]', '', 'g') = ANY($2::text[])
      LIMIT 1`,
    [TENANT, keys]);
  return r.rows[0] || null;
}

// Comportamento ANTIGO (igualdade EXATA) — só p/ documentar a regressão fechada.
async function lookupRoleExato(c, inbound) {
  const r = await c.query(
    `SELECT cr.suppression
       FROM contact_role_member m
       JOIN contact_role cr ON cr.id = m.role_id
      WHERE m.tenant_id = $1
        AND regexp_replace(m.phone, '[^0-9]', '', 'g') = regexp_replace($2, '[^0-9]', '', 'g')
      LIMIT 1`,
    [TENANT, inbound]);
  return r.rows[0] || null;
}

// Réplica FIEL do lookup de internal_contacts corrigido (src/engine.js): BR-aware.
async function internalMatchSQL(c, inbound) {
  const keys = inbound ? telBR.matchKeys(inbound) : [];
  if (!keys.length) return false;
  const r = await c.query(
    `SELECT 1 FROM internal_contacts
      WHERE tenant_id = $1
        AND regexp_replace(phone, '[^0-9]', '', 'g') = ANY($2::text[])
      LIMIT 1`,
    [TENANT, keys]);
  return r.rowCount > 0;
}

async function seedRole(c, storedPhone) {
  const roleId = (await c.query(
    `INSERT INTO contact_role (tenant_id, key, label, axis, suppression)
     VALUES ($1, 'professor', 'Professor', 'internal', 'hard') RETURNING id`, [TENANT])).rows[0].id;
  await c.query(
    `INSERT INTO contact_role_member (tenant_id, phone, role_id) VALUES ($1, $2, $3)`,
    [TENANT, storedPhone, roleId]);
  return roleId;
}

// ---- _lookupRole (caminho 'hard' por papel) --------------------------------

test('_lookupRole: papel gravado SEM 55 (19994301015) casa com inbound COM 55 (5519994301015)', async () => {
  await inRolledBackTx(async (c) => {
    await seedRole(c, '19994301015');                       // cadastro sem DDI 55 (a raiz do bug)
    const role = await lookupRoleSQL(c, '5519994301015');   // inbound WhatsApp com 55
    assert.ok(role, 'deveria casar BR-aware');
    assert.equal(role.suppression, 'hard');
  });
});

test('_lookupRole: vice-versa — papel gravado COM 55 (5519996673013) casa com inbound SEM 55 (19996673013)', async () => {
  await inRolledBackTx(async (c) => {
    await seedRole(c, '5519996673013');                     // cadastro com DDI 55
    const role = await lookupRoleSQL(c, '19996673013');     // inbound sem 55
    assert.ok(role, 'deveria casar BR-aware na direção inversa');
    assert.equal(role.suppression, 'hard');
  });
});

test('_lookupRole: regressão — a igualdade EXATA (comportamento antigo) NÃO casava esse par', async () => {
  await inRolledBackTx(async (c) => {
    await seedRole(c, '19994301015');
    assert.equal(await lookupRoleExato(c, '5519994301015'), null, 'exato escapava (bug); BR-aware corrige');
    assert.ok(await lookupRoleSQL(c, '5519994301015'), 'a corrigida casa');
  });
});

test('_lookupRole: número NÃO cadastrado como papel não casa', async () => {
  await inRolledBackTx(async (c) => {
    await seedRole(c, '19994301015');
    assert.equal(await lookupRoleSQL(c, '5519911112222'), null, 'não-membro nunca casa');
  });
});

// ---- internal_contacts (descarte de contato interno, ADR-018) --------------

test('internal_contacts: cadastro SEM 55 (19988887777) casa com inbound COM 55 (5519988887777)', async () => {
  await inRolledBackTx(async (c) => {
    await c.query(
      `INSERT INTO internal_contacts (tenant_id, phone, name, type)
       VALUES ($1, '19988887777', 'Equipe X', 'funcionario')`, [TENANT]);
    assert.equal(await internalMatchSQL(c, '5519988887777'), true, 'interno deveria casar BR-aware');
  });
});

test('internal_contacts: não-membro NÃO casa', async () => {
  await inRolledBackTx(async (c) => {
    await c.query(
      `INSERT INTO internal_contacts (tenant_id, phone, name, type)
       VALUES ($1, '19988887777', 'Equipe X', 'funcionario')`, [TENANT]);
    assert.equal(await internalMatchSQL(c, '5519911112222'), false, 'quem não é interno nunca casa');
  });
});
