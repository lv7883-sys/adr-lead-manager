'use strict';
// lifecycle-canonico.itest.js — Fatia A: régua canônica lead ativo / convertido / terminal.
// Testa os fragmentos SQL (terminalSql/convertidoSql/statusVivoSql) E os predicados JS
// (isTerminal/isConvertido/isStatusVivo), e prova que SQL≡JS (sem cópia divergente).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { terminalSql, convertidoSql, statusVivoSql, isTerminal, isConvertido, isStatusVivo } = require('../src/lifecycle');

let c;
const N = 7; // dormancy
// "ativo canônico (com dormência)" em SQL — a composição que o tile usa.
const ATIVO_SQL = `
  ${statusVivoSql('l')} AND NOT ${terminalSql('l')} AND (
    EXISTS(SELECT 1 FROM pending_approvals pa WHERE pa.lead_id=l.id AND pa.status='PENDING')
    OR (SELECT max(m.received_at) FROM messages m JOIN conversations cv ON cv.id=m.conversation_id
         WHERE cv.external_id=l.phone) >= now() - make_interval(days => ${N}))`;

async function lead(phone, status, desfecho, lastDiasAtras = null) {
  const id = (await c.query(`INSERT INTO leads (phone, status, desfecho) VALUES ($1,$2,$3) RETURNING id`, [phone, status, desfecho])).rows[0].id;
  await c.query(`INSERT INTO conversations (external_id) VALUES ($1) ON CONFLICT DO NOTHING`, [phone]);
  if (lastDiasAtras != null) await c.query(
    `INSERT INTO messages (conversation_id, role, received_at) SELECT id,'USER', now()-make_interval(days=>$2) FROM conversations WHERE external_id=$1`, [phone, lastDiasAtras]);
  return id;
}
const allRows = () => c.query(`SELECT id, phone, status, desfecho FROM leads`).then(r => r.rows);
const countSql = (frag) => c.query(`SELECT count(*)::int n FROM leads l WHERE l.status NOT IN ('NOT_LEAD','REVIEW_QUEUE') AND ${frag}`).then(r => r.rows[0].n);

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query(`
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text UNIQUE);
    CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone text, meta_psid text, status text, desfecho text);
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, role text, received_at timestamptz);
    CREATE TABLE pending_approvals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid, status text);`);
  // A: vivo recente (ativo)    B: matriculado-sem-CONVERTED   C: não-matriculado (terminal)
  // D: vivo dormente (reativação)   E: CONVERTED   F: NOT_LEAD (fora do universo)
  await lead('101', 'QUALIFYING', null, 1);
  await lead('102', 'QUALIFYING', 'matriculado', 1);
  await lead('103', 'QUALIFYING', 'nao_matriculado_preco', 1);
  await lead('104', 'QUALIFYING', null, 20);
  await lead('105', 'CONVERTED', null, 1);
  await lead('106', 'NOT_LEAD', null, 1);
});
after(async () => { await c.end(); });

test('(1) lead com desfecho terminal → TERMINAL (não ativo)', async () => {
  const rows = await allRows();
  const b = rows.find(r => r.phone === '102'), cc = rows.find(r => r.phone === '103');
  assert.equal(isTerminal(b), true, '102 matriculado é terminal');
  assert.equal(isTerminal(cc), true, '103 não-matriculado é terminal');
  // e não entram em "ativo"
  assert.equal(await countSql(`l.phone='102' AND ${ATIVO_SQL}`), 0);
  assert.equal(await countSql(`l.phone='103' AND ${ATIVO_SQL}`), 0);
});

test('(2) matriculado (desfecho) sem status CONVERTED → CONVERTIDO, não ativo', async () => {
  const b = (await allRows()).find(r => r.phone === '102');
  assert.equal(isConvertido(b), true, '102 é convertido por desfecho');
  assert.equal(await countSql(`l.phone='102' AND ${convertidoSql('l')}`), 1, 'SQL: convertido');
  assert.equal(await countSql(`l.phone='102' AND ${ATIVO_SQL}`), 0, 'não é ativo');
});

test('(3) dormente (vivo, desfecho NULL, >7d) → reativação, não ativo', async () => {
  assert.equal(await countSql(`l.phone='104' AND ${ATIVO_SQL}`), 0, '104 dormente não é ativo');
  // recente equivalente É ativo
  assert.equal(await countSql(`l.phone='101' AND ${ATIVO_SQL}`), 1, '101 recente é ativo');
});

test('(4) SQL ≡ JS: mesma contagem de ativo/terminal/convertido (sem cópia divergente)', async () => {
  const rows = await allRows();
  const universo = rows.filter(r => !['NOT_LEAD', 'REVIEW_QUEUE'].includes(r.status));
  // TERMINAL
  assert.equal(await countSql(terminalSql('l')), universo.filter(isTerminal).length, 'terminal SQL==JS');
  // CONVERTIDO
  assert.equal(await countSql(convertidoSql('l')), universo.filter(isConvertido).length, 'convertido SQL==JS');
  // STATUS VIVO
  assert.equal(await countSql(statusVivoSql('l')), universo.filter(isStatusVivo).length, 'status-vivo SQL==JS');
  // valores concretos: terminal={102,103,105}=3 ; convertido={102,105}=2 ; vivo={101,102,103,104}=4
  assert.equal(await countSql(terminalSql('l')), 3);
  assert.equal(await countSql(convertidoSql('l')), 2);
  assert.equal(await countSql(statusVivoSql('l')), 4);
  assert.equal(await countSql(ATIVO_SQL), 1, 'ativo canônico = só 101');
});

test('(5) multi-tenant: a régua é status/desfecho (sem hardcode de tenant)', async () => {
  // os fragmentos não referenciam tenant — mesma classificação p/ qualquer tenant.
  assert.ok(!/tenant/i.test(terminalSql('l') + convertidoSql('l') + statusVivoSql('l')), 'sem tenant no SQL');
  assert.equal(isTerminal({ status: 'QUALIFYING', desfecho: 'outro' }), true);
  assert.equal(isTerminal({ status: 'QUALIFYING', desfecho: null }), false);
  assert.equal(isConvertido({ status: 'won', desfecho: null }), true, 'WON (case-insensitive)');
});
