'use strict';
// reabordagem-cleanup.itest.js — #8 Fase 2: dedup do job + coluna honesta (enviado_em) +
// limpeza (migração 073, testada VERBATIM do arquivo). PG descartável, schema lead_manager
// real (a 073 é schema-qualificada). NUNCA toca produção.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

let c;
const T = '00000000-0000-0000-0000-0000000000aa';   // tenant de teste
const MIG073 = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '073_reabordagem_cleanup.sql'), 'utf8');

// Predicado de dedup do job (espelho FIEL do NOT EXISTS novo em detectar-silenciosos.js).
const DEDUP_SELECT = `
  SELECT l.id FROM leads l
   WHERE l.status IN ('QUALIFYING','QUALIFIED') AND l.desfecho IS NULL AND l.id = $1
     AND NOT EXISTS (
       SELECT 1 FROM reabordagem_tentativas rt
        WHERE rt.lead_id = l.id
          AND (rt.status = 'pendente' OR rt.enviado_em > now() - interval '3 days'))`;

// INSERT de pendente EXATO como o job (enviado_em=NULL explícito).
const INSERT_PENDENTE = `
  INSERT INTO reabordagem_tentativas (tenant_id, lead_id, texto, sugestao_estrategia, sugestao_rascunho, status, enviado_em)
  VALUES ($1, $2, 'rascunho', NULL, 'rascunho', 'pendente', NULL) RETURNING id, enviado_em`;

// INSERT de envio EXATO como enviar-retomada (enviado_em=now() explícito).
const INSERT_ENVIADO = `
  INSERT INTO reabordagem_tentativas (tenant_id, lead_id, texto, sugestao_estrategia, sugestao_rascunho, status, enviado_em)
  VALUES ($1, $2, 'oi', NULL, NULL, 'enviado', now()) RETURNING enviado_em`;

// Mirror da derivação da Fase 1 (retomada_enviado_em do staff_outbound) — pra provar que o
// pendente NÃO interfere.
const MIRROR_FASE1 = `
  SELECT rtm.retomada_em FROM leads l
    LEFT JOIN LATERAL (
      SELECT max(s.received_at) AS retomada_em FROM staff_outbound_samples s
       WHERE regexp_replace(s.external_id,'[^0-9]','','g')=regexp_replace(coalesce(l.phone,l.meta_psid,''),'[^0-9]','','g')
         AND (SELECT max(m.received_at) FROM messages m JOIN conversations cv ON cv.id=m.conversation_id
               WHERE cv.external_id=l.phone AND m.role='USER' AND m.received_at < s.received_at)
             <= s.received_at - make_interval(days => 7)
    ) rtm ON true
   WHERE l.id = $1`;

async function lead(phone, over = {}) {
  const o = { status: 'QUALIFYING', desfecho: null, ...over };
  const id = (await c.query(
    `INSERT INTO leads (tenant_id, phone, status, desfecho) VALUES ($1,$2,$3,$4) RETURNING id`,
    [T, phone, o.status, o.desfecho])).rows[0].id;
  await c.query(`INSERT INTO conversations (external_id) VALUES ($1) ON CONFLICT DO NOTHING`, [phone]);
  return id;
}
const msg = (phone, diasAtras) => c.query(
  `INSERT INTO messages (conversation_id, role, received_at)
     SELECT id,'USER', now() - make_interval(mins => ($2*1440)::int) FROM conversations WHERE external_id=$1`, [phone, diasAtras]);
const out = (phone, diasAtras) => c.query(
  `INSERT INTO staff_outbound_samples (external_id, received_at) VALUES ($1, now() - make_interval(mins => ($2*1440)::int))`, [phone, diasAtras]);
const pend = (leadId, enviadoDiasAtras) => c.query(
  `INSERT INTO reabordagem_tentativas (tenant_id, lead_id, texto, status, enviado_em)
   VALUES ($1,$2,'x','pendente', now() - make_interval(mins => ($3*1440)::int)) RETURNING id`, [T, leadId, enviadoDiasAtras]);
const nPend = async (leadId) => (await c.query(
  `SELECT count(*)::int n FROM reabordagem_tentativas WHERE lead_id=$1 AND status='pendente'`, [leadId])).rows[0].n;

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query(`CREATE SCHEMA lead_manager; SET search_path = lead_manager, public;`);
  await c.query(`
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text UNIQUE);
    CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, phone text, meta_psid text, status text, desfecho text);
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, role text, received_at timestamptz);
    CREATE TABLE staff_outbound_samples (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text, received_at timestamptz);
    CREATE TABLE tenant_lead_config (tenant_id uuid PRIMARY KEY, dormancy_days int);
    -- enviado_em COM default now() = estado PRÉ-migração (a 073 dropa o default).
    CREATE TABLE reabordagem_tentativas (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, texto text,
      enviado_em timestamptz DEFAULT now(), respondeu boolean, respondeu_em timestamptz,
      sugestao_estrategia text, sugestao_rascunho text, status text DEFAULT 'enviado');
    INSERT INTO tenant_lead_config (tenant_id, dormancy_days) VALUES ('${T}', 7);`);
});
after(async () => { await c.end(); });

test('(a) dedup: job roda 2× no mesmo dormente → 1 pendente, não 2', async () => {
  const p = 'a1'; const id = await lead(p);
  await msg(p, 20); await out(p, 19);   // silêncio (última = nossa, dormente)
  // 1ª rodada: selecionável → gera pendente
  assert.equal((await c.query(DEDUP_SELECT, [id])).rowCount, 1, 'run1: selecionável');
  await c.query(INSERT_PENDENTE, [T, id]);
  // 2ª rodada: já tem pendente aberto → NÃO selecionável (não regenera)
  assert.equal((await c.query(DEDUP_SELECT, [id])).rowCount, 0, 'run2: bloqueado pelo pendente');
  assert.equal(await nPend(id), 1, 'exatamente 1 pendente após 2 rodadas');
});

test('(b) INSERT de pendente grava enviado_em NULL (coluna honesta)', async () => {
  const p = 'b1'; const id = await lead(p);
  const r = (await c.query(INSERT_PENDENTE, [T, id])).rows[0];
  assert.equal(r.enviado_em, null, 'pendente nasce com enviado_em NULL');
});

test('(b2) após DROP DEFAULT (073), INSERT sem enviado_em também fica NULL', async () => {
  await c.query(MIG073);   // aplica a migração (idempotente) — dropa o default
  const p = 'b2'; const id = await lead(p);
  const r = (await c.query(
    `INSERT INTO reabordagem_tentativas (tenant_id, lead_id, texto, status) VALUES ($1,$2,'x','pendente') RETURNING enviado_em`,
    [T, id])).rows[0];
  assert.equal(r.enviado_em, null, 'sem default, enviado_em é NULL');
});

test('(c) envio real (enviar-retomada) carimba enviado_em NOT NULL', async () => {
  const p = 'c1'; const id = await lead(p);
  const r = (await c.query(INSERT_ENVIADO, [T, id])).rows[0];
  assert.ok(r.enviado_em != null, 'enviado carrega timestamp explícito');
});

test('(d) Fase 1 intacta: pendente NÃO afeta retomada derivada do staff_outbound', async () => {
  const p = 'd1'; const id = await lead(p);
  await msg(p, 30); await out(p, 20);      // retomada real (gap 10d >= 7) no staff_outbound
  await c.query(INSERT_PENDENTE, [T, id]); // e um pendente aberto na fila
  const r = (await c.query(MIRROR_FASE1, [id])).rows[0];
  assert.ok(r.retomada_em != null, 'retomada vem do staff_outbound, independente do pendente');
});

test('(e) limpeza dedup: 3 pendentes duplicados → 1 (o mais recente)', async () => {
  const p = 'e1'; const id = await lead(p);
  await msg(p, 30); await out(p, 20);      // dormente válido (fica após purga)
  const keep = (await pend(id, 1)).rows[0].id;  // mais recente (1d atrás)
  await pend(id, 3); await pend(id, 5);         // mais antigos
  assert.equal(await nPend(id), 3, 'seed: 3 pendentes');
  await c.query(MIG073);
  assert.equal(await nPend(id), 1, 'após 073: 1 pendente');
  const sobrou = (await c.query(`SELECT id FROM reabordagem_tentativas WHERE lead_id=$1 AND status='pendente'`, [id])).rows[0].id;
  assert.equal(sobrou, keep, 'sobrou o mais recente');
});

test('(f) purga: pendente de lead NÃO-candidato some; de dormente válido fica', async () => {
  const dorm = await lead('f_ok'); await msg('f_ok', 30); await out('f_ok', 20);  // dormente válido
  const recent = await lead('f_recent'); await msg('f_recent', 2);                 // não-dormente (2d)
  const conv = await lead('f_conv', { status: 'NOT_LEAD' });                       // fora do funil
  const desf = await lead('f_desf', { desfecho: 'matriculado' });                  // desfecho definido
  for (const id of [dorm, recent, conv, desf]) await c.query(INSERT_PENDENTE, [T, id]);
  await c.query(MIG073);
  assert.equal(await nPend(dorm), 1, 'dormente válido: pendente fica');
  assert.equal(await nPend(recent), 0, 'não-dormente: purgado');
  assert.equal(await nPend(conv), 0, 'NOT_LEAD: purgado');
  assert.equal(await nPend(desf), 0, 'com desfecho: purgado');
});

test('(g) 073 é idempotente: rodar 2× não muda o resultado', async () => {
  const p = 'g1'; const id = await lead(p); await msg(p, 30); await out(p, 20);
  await pend(id, 1); await pend(id, 2);
  await c.query(MIG073);
  const apos1 = await nPend(id);
  await c.query(MIG073);
  assert.equal(await nPend(id), apos1, '2ª execução não altera');
  assert.equal(apos1, 1, '1 pendente');
});
