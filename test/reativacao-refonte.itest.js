'use strict';
// reativacao-refonte.itest.js — EMENDA #8 (Opção B): a derivação do ciclo de reativação
// (retomada_enviado_em / retomada_reengajou) passa a vir do LOG REAL DE ENVIO
// (staff_outbound_samples), não de reabordagem_tentativas. Testa a EXPRESSÃO SQL real
// (mirror fiel do tenant.js) + a réplica do estadoReativacao do dashboard. PG descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

let c;

// MIRROR fiel do tenant.js (LATERAL rtm + reengajou). $1=phone, $2=dormancy_days.
const MIRROR = `
  SELECT rtm.retomada_em AS retomada_enviado_em,
         (rtm.retomada_em IS NOT NULL AND EXISTS (
            SELECT 1 FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
             WHERE cv.external_id = l.phone AND m.role = 'USER'
               AND m.received_at > rtm.retomada_em)) AS retomada_reengajou
    FROM leads l
    LEFT JOIN LATERAL (
      SELECT max(s.received_at) AS retomada_em
        FROM staff_outbound_samples s
       WHERE regexp_replace(s.external_id, '[^0-9]', '', 'g')
           = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
         AND (SELECT max(m.received_at) FROM messages m
                JOIN conversations cv ON cv.id = m.conversation_id
               WHERE cv.external_id = l.phone AND m.role = 'USER'
                 AND m.received_at < s.received_at)
             <= s.received_at - make_interval(days => $2::int)
    ) rtm ON true
   WHERE l.phone = $1`;

// Réplica FIEL do dashboard (routes/leads.js:136-149). classificarLead reduzido ao ramo
// 'historico' (todos os leads de teste são dormentes) — o que decide candidato vs fora.
function estadoReativacao(l, dormancyN, expiryDays) {
  const status = String(l.status || '').toUpperCase();
  const convertido = status === 'CONVERTED' || status === 'WON' || l.desfecho === 'matriculado';
  const lastSend = l.retomada_enviado_em ? new Date(l.retomada_enviado_em).getTime() : null;
  const hasAttempt = lastSend != null && !isNaN(lastSend);
  if (convertido) return hasAttempt ? 'recuperado' : 'fora';
  if (l.desfecho) return 'resolvido';
  if (hasAttempt) {
    if (l.retomada_reengajou === true) return 'reengajou';
    const exp = (Number.isInteger(expiryDays) && expiryDays > 0) ? expiryDays : 45;
    if (Date.now() - lastSend > exp * 86400000) return 'perdido';
    return 'em_reativacao';
  }
  const dorMs = ((Number.isInteger(dormancyN) && dormancyN > 0) ? dormancyN : 7) * 86400000;
  const historico = l._lastTs == null || (Date.now() - l._lastTs) > dorMs;
  return historico ? 'candidato' : 'fora';
}

// ---- seed helpers (timestamps em "dias atrás", fracionário via minutos) --------------
async function lead(phone, over = {}) {
  const o = { status: 'QUALIFYING', desfecho: null, ...over };
  await c.query(`INSERT INTO leads (phone, status, desfecho) VALUES ($1,$2,$3)`, [phone, o.status, o.desfecho]);
  await c.query(`INSERT INTO conversations (external_id) VALUES ($1) ON CONFLICT DO NOTHING`, [phone]);
}
const msg = (phone, diasAtras) => c.query(
  `INSERT INTO messages (conversation_id, role, body, received_at)
     SELECT id, 'USER', 'oi', now() - make_interval(mins => ($2*1440)::int) FROM conversations WHERE external_id=$1`,
  [phone, diasAtras]);
const out = (phone, diasAtras) => c.query(
  `INSERT INTO staff_outbound_samples (external_id, received_at) VALUES ($1, now() - make_interval(mins => ($2*1440)::int))`,
  [phone, diasAtras]);

// deriva os campos + calcula o chip como o dashboard faria
async function derivar(phone, dormancy = 7) {
  const r = (await c.query(MIRROR, [phone, dormancy])).rows[0];
  const lt = (await c.query(
    `SELECT GREATEST(
        COALESCE((SELECT max(m.received_at) FROM messages m JOIN conversations cv ON cv.id=m.conversation_id WHERE cv.external_id=$1),'epoch'::timestamptz),
        COALESCE((SELECT max(s.received_at) FROM staff_outbound_samples s WHERE regexp_replace(s.external_id,'[^0-9]','','g')=regexp_replace($1,'[^0-9]','','g')),'epoch'::timestamptz)
     ) AS lt`, [phone])).rows[0].lt;
  return { ...r, _lastTs: lt ? new Date(lt).getTime() : null };
}
async function chip(phone, dormancy = 7, expiry = 45) {
  const d = await derivar(phone, dormancy);
  const lead = (await c.query(`SELECT status, desfecho FROM leads WHERE phone=$1`, [phone])).rows[0];
  return estadoReativacao({ ...lead, retomada_enviado_em: d.retomada_enviado_em, retomada_reengajou: d.retomada_reengajou, _lastTs: d._lastTs }, dormancy, expiry);
}

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query(`
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text UNIQUE);
    CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone text, meta_psid text, status text, desfecho text);
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, role text, body text, received_at timestamptz);
    CREATE TABLE staff_outbound_samples (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text, received_at timestamptz);`);
});
after(async () => { await c.end(); });

test('(1) dormente + saída após gap>=7d, sem resposta → em_reativacao (hoje dava candidato)', async () => {
  const p = '111';
  await lead(p);
  await msg(p, 30);        // inbound 30d atrás
  await out(p, 20);        // retomada 20d atrás (gap 10d >= 7)
  const d = await derivar(p);
  assert.ok(d.retomada_enviado_em != null, 'retomada_enviado_em deve estar setado');
  assert.equal(d.retomada_reengajou, false);
  assert.equal(await chip(p), 'em_reativacao');
});

test('(2) idem + inbound APÓS a retomada → reengajou', async () => {
  const p = '222';
  await lead(p);
  await msg(p, 30);        // inbound
  await out(p, 20);        // retomada (gap 10d)
  await msg(p, 15);        // inbound depois da retomada
  const d = await derivar(p);
  assert.ok(d.retomada_enviado_em != null);
  assert.equal(d.retomada_reengajou, true);
  assert.equal(await chip(p), 'reengajou');
});

test('(3) dormente sem retomada (só resposta same-day antes de silenciar) → candidato (não falso-positivo)', async () => {
  const p = '333';
  await lead(p);
  await msg(p, 20);        // inbound 20d atrás
  await out(p, 20);        // resposta no MESMO dia (gap 0) — NÃO é retomada
  const d = await derivar(p);
  assert.equal(d.retomada_enviado_em, null, 'saída same-day não conta como retomada');
  assert.equal(d.retomada_reengajou, false);
  assert.equal(await chip(p), 'candidato');
});

test('(4) retomada > expiry (45d) sem resposta → perdido', async () => {
  const p = '444';
  await lead(p);
  await msg(p, 60);        // inbound 60d atrás
  await out(p, 50);        // retomada 50d atrás (gap 10d), > expiry 45
  const d = await derivar(p);
  assert.ok(d.retomada_enviado_em != null);
  assert.equal(await chip(p, 7, 45), 'perdido');
});

test('(5) os 6 leads reais (lag 7–16d) SAEM de candidato', async () => {
  const reais = [['Luciana', 16], ['Gabriela', 9], ['Liria', 9], ['France', 9], ['bruno', 7], ['Alessandra', 7]];
  for (const [nome, lag] of reais) {
    const p = 'r_' + nome;
    await lead(p);
    await msg(p, 40);            // inbound 40d atrás
    await out(p, 40 - lag);      // retomada lag dias depois do inbound (gap = lag >= 7)
    const d = await derivar(p);
    assert.ok(d.retomada_enviado_em != null, `${nome}: deveria ter retomada`);
    const ch = await chip(p);
    assert.notEqual(ch, 'candidato', `${nome}: saiu de candidato (=${ch})`);
    assert.equal(ch, 'em_reativacao', `${nome}: em_reativacao`);
  }
});

test('(6) multi-tenant: dormancy_days diferente move o corte (gap 5d)', async () => {
  const p = '666';
  await lead(p);
  await msg(p, 20);        // inbound
  await out(p, 15);        // saída 5d depois (gap 5)
  const d3 = await derivar(p, 3);   // corte 3 → 5>=3 conta como retomada
  const d7 = await derivar(p, 7);   // corte 7 → 5<7 NÃO conta
  assert.ok(d3.retomada_enviado_em != null, 'dormancy=3: gap 5 conta como retomada');
  assert.equal(d7.retomada_enviado_em, null, 'dormancy=7: gap 5 não conta');
  assert.equal(await chip(p, 3), 'em_reativacao');
  assert.equal(await chip(p, 7), 'candidato');
});
