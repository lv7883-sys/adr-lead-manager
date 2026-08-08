'use strict';
// retomada-fonte-unica.itest.js — #8 Fatia B: re-fonte de "retomada" (reabordagem_tentativas
// → staff_outbound_samples) em metrics.js e plantao.js, via helper src/reativacao.js.
// Prova: (1) as 3 formas (/leads chip, metrics-período, plantão-hoje) dão o MESMO número;
// (2) sugestão pendente NÃO conta; (3) NOT_LEAD fora do universo; (4) reengajamento; (5) fuso
// SP; (6) corte por dormancy. PG descartável, schema lead_manager (exercita o schema-prefix).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { retomadaCtes, identLateral } = require('../src/reativacao');

let c;
const SP_HOJE = "date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'";
const UTC_HOJE = "date_trunc('day', now())";

// as 3 formas, TODAS construídas do MESMO helper (forma em janela — 2026-08-07):
const JOINS = `${identLateral('l')}
  LEFT JOIN rt_retom rtm ON li.ident <> '' AND rtm.ident = li.ident
  LEFT JOIN rt_in   rin ON li.ident <> '' AND rin.ident = li.ident`;
// (A) /leads chip — retomada_em por lead (reengajou: max > threshold ≡ EXISTS)
const CHIP = `WITH ${retomadaCtes('$2')}
  SELECT rtm.retomada_em, (rtm.retomada_em IS NOT NULL AND rin.last_in > rtm.retomada_em) reeng
    FROM leads l ${JOINS} WHERE l.phone = $1`;
// contagem de leads com retomada (universo do dashboard) — espelha o que o chip enumeraria
const CHIP_COUNT = `WITH ${retomadaCtes('$1')}
  SELECT count(*) FILTER (WHERE rtm.retomada_em IS NOT NULL)::int n
    FROM leads l ${JOINS} WHERE l.status NOT IN ('NOT_LEAD','REVIEW_QUEUE')`;
// (B) metrics — reabordados no período + reengajaram (unqualified)
const METRICS = `WITH ${retomadaCtes('$2')}
  SELECT
  count(*) FILTER (WHERE rtm.retomada_em IS NOT NULL AND rtm.retomada_em >= now()-($1||' days')::interval)::int total,
  count(*) FILTER (WHERE rtm.retomada_em IS NOT NULL AND rtm.retomada_em >= now()-($1||' days')::interval
                    AND rin.last_in > rtm.retomada_em)::int responderam
  FROM leads l ${JOINS} WHERE l.status NOT IN ('NOT_LEAD','REVIEW_QUEUE')`;
// (C) plantão — retomadas HOJE (SP) + reengajaram HOJE (schema-qualified, exercita o prefixo)
const PLANTAO = `WITH ${retomadaCtes('$1', { schema: 'lead_manager.' })}
  SELECT
  count(*) FILTER (WHERE rtm.retomada_em IS NOT NULL AND rtm.retomada_em >= ${SP_HOJE})::int enviadas,
  count(*) FILTER (WHERE rtm.retomada_em IS NOT NULL
                    AND rin.last_in > rtm.retomada_em AND rin.last_in >= ${SP_HOJE})::int reengajaram
  FROM lead_manager.leads l ${JOINS}
 WHERE l.status NOT IN ('NOT_LEAD','REVIEW_QUEUE')`;

const chip = async (phone, dorm = 7) => (await c.query(CHIP, [phone, dorm])).rows[0];
const chipCount = async (dorm = 7) => (await c.query(CHIP_COUNT, [dorm])).rows[0].n;
const metrics = async (days = 30, dorm = 7) => (await c.query(METRICS, [days, dorm])).rows[0];
const plantao = async (dorm = 7) => (await c.query(PLANTAO, [dorm])).rows[0];

async function lead(phone, over = {}) {
  const o = { status: 'QUALIFYING', ...over };
  await c.query(`INSERT INTO leads (phone, status) VALUES ($1,$2)`, [phone, o.status]);
  await c.query(`INSERT INTO conversations (external_id) VALUES ($1) ON CONFLICT DO NOTHING`, [phone]);
}
// eventos com tempo por EXPRESSÃO SQL (p/ ancorar no SP_HOJE, determinístico)
const msgAt = (phone, sql) => c.query(
  `INSERT INTO messages (conversation_id, role, received_at) SELECT id,'USER', ${sql} FROM conversations WHERE external_id=$1`, [phone]);
const outAt = (phone, sql) => c.query(
  `INSERT INTO staff_outbound_samples (external_id, received_at) VALUES ($1, ${sql})`, [phone]);
const pend = (phone) => c.query(
  `INSERT INTO reabordagem_tentativas (lead_id, status, enviado_em) SELECT id,'pendente', now() FROM leads WHERE phone=$1`, [phone]);
// as métricas contam GLOBALMENTE (universo do tenant) → isola cada teste zerando as tabelas.
const reset = () => c.query(`TRUNCATE leads, conversations, messages, staff_outbound_samples, reabordagem_tentativas`);

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query(`CREATE SCHEMA lead_manager; SET search_path = lead_manager, public;`);
  await c.query(`
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text UNIQUE);
    CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone text, meta_psid text, status text);
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, role text, received_at timestamptz);
    CREATE TABLE staff_outbound_samples (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text, received_at timestamptz);
    CREATE TABLE reabordagem_tentativas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid, status text, enviado_em timestamptz);`);
});
after(async () => { await c.end(); });

test('(1) retomada via staff_outbound (gap>=dorm) HOJE → contada em metrics E plantão', async () => {
  await reset();
  const p = '190000001'; await lead(p);
  await msgAt(p, `${SP_HOJE} - interval '10 days'`);   // inbound antigo
  await outAt(p, `${SP_HOJE} + interval '6 hours'`);    // retomada HOJE (gap 10d)
  assert.ok((await chip(p)).retomada_em != null, 'chip: retomada setada');
  assert.equal((await metrics()).total, 1, 'metrics conta 1 reabordado');
  assert.equal((await plantao()).enviadas, 1, 'plantão conta 1 retomada hoje');
});

test('(2) sugestão pendente em reabordagem_tentativas → NÃO conta como retomada', async () => {
  await reset();
  const p = '190000002'; await lead(p);
  await msgAt(p, `${SP_HOJE} - interval '10 days'`);
  await pend(p);   // fila de sugestão (fonte ANTIGA) — sem staff_outbound de retomada
  assert.equal((await chip(p)).retomada_em, null, 'sem retomada real');
  assert.equal((await metrics()).total, 0, 'metrics ignora pendente');
  assert.equal((await plantao()).enviadas, 0, 'plantão ignora pendente');
});

test('(3) lead NOT_LEAD/REVIEW_QUEUE → fora do universo (gate suprimido)', async () => {
  await reset();
  for (const st of ['NOT_LEAD', 'REVIEW_QUEUE']) {
    const p = '1900003' + (st === 'NOT_LEAD' ? '1' : '2'); await lead(p, { status: st });
    await msgAt(p, `${SP_HOJE} - interval '10 days'`);
    await outAt(p, `${SP_HOJE} + interval '6 hours'`);   // teria retomada, mas fora do universo
  }
  assert.equal((await metrics()).total, 0, 'metrics exclui NOT_LEAD/REVIEW_QUEUE');
  assert.equal((await plantao()).enviadas, 0, 'plantão exclui NOT_LEAD/REVIEW_QUEUE');
  assert.equal(await chipCount(), 0, 'chip-count exclui NOT_LEAD/REVIEW_QUEUE');
});

test('(4) reengajamento: inbound APÓS a retomada → par de qualidade conta', async () => {
  await reset();
  const p = '190000004'; await lead(p);
  await msgAt(p, `${SP_HOJE} - interval '10 days'`);      // inbound antigo
  await outAt(p, `${SP_HOJE} + interval '6 hours'`);       // retomada hoje
  await msgAt(p, `${SP_HOJE} + interval '8 hours'`);       // inbound DEPOIS (reengajou, hoje)
  assert.equal((await chip(p)).reeng, true, 'chip: reengajou');
  assert.equal((await metrics()).responderam, 1, 'metrics: 1 reengajou');
  assert.equal((await plantao()).reengajaram, 1, 'plantão: 1 reengajou hoje');
});

test('(5) fuso SP: retomada às 22h BRT HOJE conta hoje; 23h BRT ONTEM não (UTC erraria)', async () => {
  await reset();
  const hoje = '190000051'; await lead(hoje);
  await msgAt(hoje, `${SP_HOJE} - interval '10 days'`);
  await outAt(hoje, `${SP_HOJE} + interval '22 hours'`);         // 22h BRT hoje
  const ont = '190000052'; await lead(ont);
  await msgAt(ont, `${SP_HOJE} - interval '10 days'`);
  await outAt(ont, `${SP_HOJE} - interval '1 hour'`);            // 23h BRT ONTEM
  assert.equal((await plantao()).enviadas, 1, 'SP: só o de hoje conta (o de ontem fica fora)');
  // demonstra o bug antigo: sob UTC o de ONTEM (23h BRT = 02h UTC hoje) vazaria pra "hoje"
  const utc = (await c.query(
    `WITH ${retomadaCtes('$1')}
     SELECT count(*) FILTER (WHERE rtm.retomada_em IS NOT NULL AND rtm.retomada_em >= ${UTC_HOJE})::int n
       FROM leads l ${JOINS} WHERE l.status NOT IN ('NOT_LEAD','REVIEW_QUEUE') AND l.phone LIKE '19000005%'`, [7])).rows[0].n;
  assert.ok(utc >= 2, `UTC contaria os 2 (leak do fuso): utc=${utc}`);
});

test('(6) multi-tenant: dormancy diferente move o corte (gap 5d)', async () => {
  await reset();
  const p = '190000006'; await lead(p);
  await msgAt(p, `${SP_HOJE} - interval '20 days'`);
  await outAt(p, `${SP_HOJE} - interval '15 days'`);   // saída 5d após o inbound (gap 5)
  assert.ok((await chip(p, 3)).retomada_em != null, 'dorm=3: gap 5 conta');
  assert.equal((await chip(p, 7)).retomada_em, null, 'dorm=7: gap 5 não conta');
  assert.equal((await metrics(30, 3)).total, 1, 'metrics dorm=3 conta');
  assert.equal((await metrics(30, 7)).total, 0, 'metrics dorm=7 não conta');
});

test('(7) CONSISTÊNCIA: /leads chip == metrics == plantão pro mesmo dataset (todas hoje)', async () => {
  // limpa e semeia 3 leads com retomada HOJE + 1 NOT_LEAD (fora) + 1 pendente-só (fora)
  await c.query(`TRUNCATE leads, conversations, messages, staff_outbound_samples, reabordagem_tentativas`);
  for (const p of ['190000071','190000072','190000073']) {
    await lead(p);
    await msgAt(p, `${SP_HOJE} - interval '10 days'`);
    await outAt(p, `${SP_HOJE} + interval '5 hours'`);   // retomada hoje
  }
  await lead('190000074', { status: 'NOT_LEAD' }); await msgAt('190000074', `${SP_HOJE} - interval '10 days'`); await outAt('190000074', `${SP_HOJE} + interval '5 hours'`);
  await lead('190000075'); await msgAt('190000075', `${SP_HOJE} - interval '10 days'`); await pend('190000075');
  const n = await chipCount(), m = (await metrics()).total, pl = (await plantao()).enviadas;
  assert.equal(n, 3, `chip-count=${n}`);
  assert.equal(m, 3, `metrics.total=${m}`);
  assert.equal(pl, 3, `plantao.enviadas=${pl}`);
  assert.ok(n === m && m === pl, `os 3 lugares batem: chip=${n} metrics=${m} plantao=${pl}`);
});
