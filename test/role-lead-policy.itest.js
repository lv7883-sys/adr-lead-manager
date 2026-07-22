'use strict';
// role-lead-policy.itest.js — ADR-036 E1.4/E1.5 (rescue questions = config por tenant).
// Prova ISOLADA (PG descartável) do motor getRescuePolicy + seed por-tenant. Sem HTTP.
// NUNCA toca produção.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, withTenant } = require('../src/db');
const { getRescuePolicy, SAFE_DEFAULT } = require('../src/roleLeadPolicy');

const A = process.env.RESOURCES_TENANT_A;   // faz o papel de "Valinhos" (vertical escolas)
const B = process.env.RESOURCES_TENANT_B;   // tenant FICTÍCIO de OUTRA vertical (perguntas diferentes)

before(async () => {
  // A = template da vertical "escolas" (o mesmo que o seed do Valinhos)
  await withTenant(A, (c) => c.query('SELECT lead_manager.seed_role_lead_policy_escolas($1)', [A]));
  // B = outra vertical (ex.: academia), perguntas PRÓPRIAS e ação default diferente
  await withTenant(B, (c) => c.query(
    `INSERT INTO lead_manager.role_lead_policy (tenant_id, role, default_action, rescue_prompt, rescue_scope) VALUES
       ($1,'beneficiario','vigia','VERTICAL ACADEMIA: o cliente da academia está trazendo pessoa nova ou novo plano?','estreito'),
       ($1,'prestador','descarta','VERTICAL ACADEMIA: o personal quer virar aluno pagante?','amplo')
     ON CONFLICT (tenant_id, role) DO NOTHING`, [B]));
});
after(async () => { await pool.end(); });

test('(a) Valinhos/escolas: motor devolve as perguntas SEMEADAS (nada regride)', async () => {
  const ben = await getRescuePolicy(A, 'beneficiario');
  assert.equal(ben.seeded, true);
  assert.equal(ben.default_action, 'descarta');
  assert.match(ben.rescue_prompt, /EXPANS[ÃA]O/);        // conteúdo da escola preservado
  assert.match(ben.rescue_prompt, /PESSOA NOVA/);
  const prest = await getRescuePolicy(A, 'prestador');
  assert.match(prest.rescue_prompt, /PR[ÓO]PRIA FAM[ÍI]LIA/);
  const resp = await getRescuePolicy(A, 'responsavel_financeiro');
  assert.match(resp.rescue_prompt, /PESSOA NOVA/);
});

test('(b) tenant fictício de OUTRA vertical → motor usa as perguntas DELE (multi-tenant real)', async () => {
  const ben = await getRescuePolicy(B, 'beneficiario');
  assert.equal(ben.seeded, true);
  assert.equal(ben.default_action, 'vigia');            // ação default própria da vertical
  assert.match(ben.rescue_prompt, /ACADEMIA/);
  assert.doesNotMatch(ben.rescue_prompt, /EXPANS[ÃA]O/); // NÃO é a pergunta da escola
});

test('(c) CROSS-TENANT = 0: A nunca vê a política de B e vice-versa', async () => {
  const aBen = await getRescuePolicy(A, 'beneficiario');
  const bBen = await getRescuePolicy(B, 'beneficiario');
  assert.notEqual(aBen.rescue_prompt, bBen.rescue_prompt);       // textos distintos por tenant
  // papel que só B tem semeado com ação 'amplo' — A tem o SEU 'prestador' (escola, estreito)
  const aPrest = await getRescuePolicy(A, 'prestador');
  const bPrest = await getRescuePolicy(B, 'prestador');
  assert.equal(aPrest.rescue_scope, 'estreito');
  assert.equal(bPrest.rescue_scope, 'amplo');
  assert.notEqual(aPrest.rescue_prompt, bPrest.rescue_prompt);
});

test('(d) papel sem política no tenant → DEFAULT SEGURO (vigia, sem resgate), logado', async () => {
  const semPolitica = await getRescuePolicy(A, 'papel_inexistente');
  assert.equal(semPolitica.seeded, false);
  assert.equal(semPolitica.default_action, 'vigia');     // nunca descarta cego
  assert.equal(semPolitica.rescue_prompt, null);
  assert.deepEqual({ ...semPolitica }, { ...SAFE_DEFAULT });
});

test('(e) entradas vazias → default seguro (não quebra)', async () => {
  assert.equal((await getRescuePolicy(null, 'beneficiario')).default_action, 'vigia');
  assert.equal((await getRescuePolicy(A, null)).rescue_prompt, null);
});
