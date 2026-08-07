'use strict';
// engine-conversa-dedup.itest.js — ADR-049: FIND-OR-CREATE de conversa por br_phone_key no funil.
//
// Regressão do bug "conversas DUPLICADAS na Caixa de Entrada": o funil (engine.js) gravava external_id
// E.164 "+55..." (telBR.toE164BR) enquanto webhook/outbound-first usam "55..." (sem "+"), e o
// ON CONFLICT (tenant,channel,external_id) casava EXATO → 2 linhas do mesmo telefone. engine.upsertConversation
// passa a casar por br_phone_key (como src/routes/inbox.js:ensureConversation) → reusa a thread.
//
// Conecta como postgres (sem RLS) e monta um schema MÍNIMO — mesmo padrão dos demais itests.
// A lógica real vem de src/engine.js:upsertConversation (fonte única); o teste só semeia e asserta.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const engine = require('../src/engine');

let c;
const T1 = '00000000-0000-0000-0000-0000000000d1';
const T2 = '00000000-0000-0000-0000-0000000000d2';

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text,
      external_id text, conversation_kind text DEFAULT 'DIRECT',
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), last_read_at timestamptz,
      UNIQUE (tenant_id, channel, external_id));
    -- Espelho da migr. 085 (o helper usa br_phone_key sem schema; aqui vive em public).
    CREATE OR REPLACE FUNCTION br_phone_key(x text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
      WITH d AS (SELECT regexp_replace(coalesce(x, ''), '[^0-9]', '', 'g') AS v),
           loc AS (SELECT CASE WHEN length(v) IN (12,13) AND left(v,2)='55' THEN substr(v,3) ELSE v END AS v FROM d)
      SELECT CASE WHEN length(v)=11 AND substr(v,3,1)='9' THEN left(v,2)||substr(v,4) ELSE v END FROM loc
    $fn$;
  `);
});
// NB: não dropa tabela (como os itests irmãos) — estes testes SÓ rodam contra um banco de teste
// DESCARTÁVEL, jamais o de produção (o schema é montado sem qualificar; um DROP resolveria p/
// lead_manager.conversations se o search_path incluísse o schema real).
after(async () => { await c.end(); });
beforeEach(async () => { await c.query('TRUNCATE conversations'); });

const count = async (tenant) =>
  (await c.query('SELECT count(*)::int n FROM conversations WHERE tenant_id=$1', [tenant])).rows[0].n;
const seed = (tenant, extId, kind = 'DIRECT', channel = 'whatsapp') =>
  c.query(`INSERT INTO conversations (tenant_id, channel, external_id, conversation_kind) VALUES ($1,$2,$3,$4) RETURNING id`,
    [tenant, channel, extId, kind]).then((r) => r.rows[0].id);

// 1) A thread "+55..." antiga do funil é REUSADA por um inbound "55..." (sem +) — não duplica.
test('reusa conversa E.164 (+55) quando chega o formato só-dígitos (55)', async () => {
  const id = await seed(T1, '+5519998175817');
  const r = await engine.upsertConversation(c, T1, 'whatsapp', '5519998175817');
  assert.equal(r.id, id, 'deve reusar a MESMA conversa');
  assert.equal(r.inserted, false, 'reuso não é inserção');
  assert.equal(await count(T1), 1, 'não pode criar segunda linha');
});

// 2) Casa também variação do 9º dígito (br_phone_key colapsa) — robustez além do "+".
test('reusa mesmo com divergência de 9º dígito (br_phone_key)', async () => {
  const id = await seed(T1, '+5519998175817');            // com 9
  const r = await engine.upsertConversation(c, T1, 'whatsapp', '551998175817'); // sem 9
  assert.equal(r.id, id);
  assert.equal(await count(T1), 1);
});

// 3) Número novo: cria o canônico em DÍGITOS sem "+" (igual normalizeMessage/ensureConversation).
test('cria conversa nova em dígitos canônicos (sem +)', async () => {
  const r = await engine.upsertConversation(c, T1, 'whatsapp', '+5519991234567');
  assert.equal(r.inserted, true);
  const row = (await c.query('SELECT external_id FROM conversations WHERE id=$1', [r.id])).rows[0];
  assert.equal(row.external_id, '5519991234567', 'external_id canônico = dígitos com 55, sem +');
});

// 4) Chamar em formatos diferentes converge numa ÚNICA linha (idempotência de dedup).
test('formatos diferentes do mesmo telefone convergem numa conversa', async () => {
  const a = await engine.upsertConversation(c, T1, 'whatsapp', '+5519998887766');
  const b = await engine.upsertConversation(c, T1, 'whatsapp', '5519998887766');
  const d = await engine.upsertConversation(c, T1, 'whatsapp', '19998887766');   // sem DDI
  assert.equal(a.id, b.id);
  assert.equal(a.id, d.id);
  assert.equal(await count(T1), 1);
});

// 5) Isolamento por tenant: mesmo telefone em T2 é OUTRA conversa.
test('não funde através de tenants', async () => {
  const a = await engine.upsertConversation(c, T1, 'whatsapp', '5519995554433');
  const b = await engine.upsertConversation(c, T2, 'whatsapp', '5519995554433');
  assert.notEqual(a.id, b.id);
  assert.equal(await count(T1), 1);
  assert.equal(await count(T2), 1);
});

// 6) GRUPO (@g.us): NÃO normaliza — casa EXATO pelo jid (comportamento de antes).
test('grupo @g.us casa exato (sem normalização telefônica)', async () => {
  const r1 = await engine.upsertConversation(c, T1, 'whatsapp', '120363000000000000@g.us');
  const r2 = await engine.upsertConversation(c, T1, 'whatsapp', '120363000000000000@g.us');
  assert.equal(r1.id, r2.id, 'mesmo jid → mesma linha (ON CONFLICT exato)');
  const row = (await c.query('SELECT external_id FROM conversations WHERE id=$1', [r1.id])).rows[0];
  assert.equal(row.external_id, '120363000000000000@g.us', 'jid preservado com @g.us');
  assert.equal(await count(T1), 1);
});

// 7) Canal Meta (psid): external_id NÃO é telefone — casa EXATO, sem br_phone_key.
test('canal Meta (psid) casa exato, sem normalização', async () => {
  const r = await engine.upsertConversation(c, T1, 'instagram_dm', '17841400000000000');
  const row = (await c.query('SELECT external_id, channel FROM conversations WHERE id=$1', [r.id])).rows[0];
  assert.equal(row.external_id, '17841400000000000');
  assert.equal(row.channel, 'instagram_dm');
  assert.equal(r.inserted, true);
});
