'use strict';

// ============================================================================
// fix/relationship-franquia-filter — _isRelationshipContact (src/engine.js) passa a
// filtrar franquia_id=1 (Valinhos), mantendo o match BR-aware (telBR.matchKeys).
// Fecha o vazamento: professor de Cambuí (franquia 5) mandando msg pra Valinhos era
// tratado como contato-de-relacionamento de Valinhos.
//
// ITEST contra Postgres real efêmero (ver run-relationship-franquia-filter-itest.sh).
// Exercita a RÉPLICA FIEL da query corrigida (engine.js:412) — mesma SQL
// (regexp_replace = ANY($::text[]) AND franquia_id=1) + o MESMO helper matchKeys.
// _isRelationshipContact não é exportado; por isso a query roda aqui verbatim.
// ============================================================================

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const telBR = require('../src/telefoneBR');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
after(async () => { await pool.end(); });

// RÉPLICA FIEL da query CORRIGIDA de _isRelationshipContact (com AND franquia_id = 1).
async function isRelationship(inbound) {
  const keys = telBR.matchKeys(inbound);
  if (!keys.length) return false;
  const r = await pool.query(
    `SELECT 1 FROM app.professor_notificacao
      WHERE regexp_replace(coalesce(telefone_override, telefone), '[^0-9]', '', 'g') = ANY($1::text[])
        AND franquia_id = 1
      LIMIT 1`, [keys]);
  return r.rowCount > 0;
}
// Comportamento ANTIGO (sem filtro) — só p/ documentar o vazamento fechado.
async function isRelationshipOld(inbound) {
  const keys = telBR.matchKeys(inbound);
  if (!keys.length) return false;
  const r = await pool.query(
    `SELECT 1 FROM app.professor_notificacao
      WHERE regexp_replace(coalesce(telefone_override, telefone), '[^0-9]', '', 'g') = ANY($1::text[])
      LIMIT 1`, [keys]);
  return r.rowCount > 0;
}

// Fixtures (ver harness): cadastro guarda SEM 55; inbound chega COM 55 (testa BR-aware junto).
const VALINHOS = '5519994301015'; // franquia 1 (só Valinhos)
const CAMBUI   = '5519955556666'; // franquia 5 (só Cambuí)
const DUAL     = '5519977778888'; // franquia 1 E 5 (dual-unidade)

test('professor de Valinhos (franquia 1) → AINDA casa (relationship=true)', async () => {
  assert.equal(await isRelationship(VALINHOS), true);
});

test('professor SÓ de Cambuí (franquia 5) → NÃO casa mais (relationship=false)', async () => {
  assert.equal(await isRelationship(CAMBUI), false);
});

test('professor dual-unidade (franquia 1 e 5) → AINDA casa (tem linha franquia 1)', async () => {
  assert.equal(await isRelationship(DUAL), true);
});

test('regressão: sem o filtro (comportamento antigo), o de Cambuí VAZAVA (casava)', async () => {
  assert.equal(await isRelationshipOld(CAMBUI), true, 'prova que o filtro é o que fecha o vazamento');
  assert.equal(await isRelationship(CAMBUI), false, 'a corrigida não casa');
});
