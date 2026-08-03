'use strict';
// autoreply.itest.js — decisão do maybeAutoReply contra Postgres real. Envio/IA MOCKADOS (deps).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const autoReply = require('../src/autoReply');

let c;
const T1 = '00000000-0000-0000-0000-0000000000ab';
const EXT = '5519999990001';
const U = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo, d, h, mi, 0, 0));
const BH = { mon: '09:00-18:00', tue: '09:00-18:00', wed: '09:00-18:00', thu: '09:00-18:00', fri: '09:00-18:00', sat: '09:00-18:00', sun: '09:00-18:00' };
const NOITE = U(2026, 7, 5, 23);  // 20:00 local -> fechado em qualquer dia
const DIA = U(2026, 7, 5, 17);    // 14:00 local -> aberto

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE tenants (id uuid PRIMARY KEY, name text);
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text,
      external_id text, conversation_kind text DEFAULT 'DIRECT', auto_reply_at timestamptz, updated_at timestamptz DEFAULT now());
    CREATE TABLE automacao_config (tenant_id uuid PRIMARY KEY, modo_fora_horario text, modo_fds text, nome_ia text, contexto_ia text);
    CREATE TABLE tenant_lead_config (tenant_id uuid PRIMARY KEY, school_name text, business_hours jsonb,
      available_instruments text[] NOT NULL DEFAULT '{}');
    CREATE TABLE staff_outbound_samples (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text,
      external_id text, external_message_id text, source text, sender text, body text, raw jsonb,
      media_url text, media_type text, media_filename text, reply_to_message_id uuid);
    CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, phone text,
      meta_psid text, status text, created_at timestamptz DEFAULT now());
  `);
  await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'ADR Valinhos')`, [T1]);
  await c.query(`INSERT INTO tenant_lead_config (tenant_id, school_name, business_hours) VALUES ($1,'ADR Valinhos',$2)`, [T1, JSON.stringify(BH)]);
});
after(async () => { await c.end(); });

async function conv(kind = 'DIRECT', channel = 'whatsapp', autoAt = null) {
  await c.query(`DELETE FROM conversations WHERE tenant_id=$1`, [T1]);
  return (await c.query(`INSERT INTO conversations (tenant_id, channel, external_id, conversation_kind, auto_reply_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [T1, channel, EXT, kind, autoAt])).rows[0].id;
}
async function setModo(fora, fds = fora, nome = 'Janis Joplin', contexto = null) {
  await c.query(`INSERT INTO automacao_config (tenant_id, modo_fora_horario, modo_fds, nome_ia, contexto_ia) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (tenant_id) DO UPDATE SET modo_fora_horario=$2, modo_fds=$3, nome_ia=$4, contexto_ia=$5`, [T1, fora, fds, nome, contexto]);
}
function mkDeps(now) {
  const spy = { sends: 0, saved: null, texto: null };
  return {
    now,
    loadRealHistory: async () => { spy.histLoaded = true; return []; },
    generate: async ({ systemPrompt, history }) => { spy.systemPrompt = systemPrompt; spy.history = history; return 'Oi! Retornamos em breve. — Janis'; },
    evolution: { status: async () => ({ state: 'open' }), sendText: async (_c, _n, t) => { spy.sends++; spy.texto = t; return { key: { id: 'WA1' } }; }, pickMessageId: () => 'WA1' },
    credsForTenant: async () => ({ instance: 'i', apikey: 'k' }),
    registrarSaida: async (_t, row) => { spy.saved = row; },
    spy,
  };
}

test('(1) fora do horário + modo=auto -> envia e marca cooldown', async () => {
  const cv = await conv(); await setModo('auto', 'auto', 'Janis Joplin', 'Ficamos na Rua X, 100, Valinhos. Aulas individuais e projetos de banda.');
  const deps = mkDeps(NOITE);
  const out = await autoReply.maybeAutoReply({ id: T1 }, { channel: 'whatsapp', externalId: EXT, inboundText: 'quanto custa violão?', contactName: 'Maria Silva' }, deps);
  assert.equal(out.ok, true);
  assert.equal(deps.spy.sends, 1);
  assert.equal(deps.spy.histLoaded, true, 'leu o histórico da conversa');
  assert.ok(Array.isArray(deps.spy.history), 'histórico passado ao gerar');
  assert.equal(deps.spy.saved.sender, 'Janis Joplin');   // assina com o nome da IA, não recepcionista
  assert.ok(deps.spy.saved.body.startsWith('*Janis Joplin*\n'), 'nome em negrito no topo (igual às recepcionistas)');
  assert.ok(deps.spy.texto.startsWith('*Janis Joplin*\n'), 'texto enviado começa com o cabeçalho');
  const sp = deps.spy.systemPrompt;
  assert.match(sp, /Maria/, 'usa o nome do contato (WhatsApp)');
  assert.match(sp, /Rua X, 100/, 'inclui a base de conhecimento (endereço/aulas)');
  assert.match(sp, /ENDERE[ÇC]O|como funcionam as aulas/i, 'permite responder endereço/como funcionam as aulas');
  assert.match(sp, /PRE[ÇC]OS?\/valores/i, 'bloqueia preço');
  assert.match(sp, /experimental/i, 'bloqueia agendar aula experimental');
  const ar = (await c.query(`SELECT auto_reply_at FROM conversations WHERE id=$1`, [cv])).rows[0].auto_reply_at;
  assert.ok(ar, 'auto_reply_at setado');
});

test('(2) dentro do horário -> não envia', async () => {
  await conv(); await setModo('auto');
  const deps = mkDeps(DIA);
  const out = await autoReply.maybeAutoReply({ id: T1 }, { channel: 'whatsapp', externalId: EXT, inboundText: 'oi' }, deps);
  assert.equal(out.skipped, 'aberto'); assert.equal(deps.spy.sends, 0);
});

test('(3) modo != auto -> não envia (kill switch por tenant)', async () => {
  await conv(); await setModo('manual');
  const deps = mkDeps(NOITE);
  const out = await autoReply.maybeAutoReply({ id: T1 }, { channel: 'whatsapp', externalId: EXT, inboundText: 'oi' }, deps);
  assert.match(out.skipped, /^modo=/); assert.equal(deps.spy.sends, 0);
});

test('(4) cooldown: já respondeu nesta janela fechada -> não repete', async () => {
  // auto_reply_at = 19:00 local (22:00 UTC), depois do fechamento das 18h -> dentro da janela
  await conv('DIRECT', 'whatsapp', U(2026, 7, 5, 22));
  await setModo('auto');
  const deps = mkDeps(NOITE);
  const out = await autoReply.maybeAutoReply({ id: T1 }, { channel: 'whatsapp', externalId: EXT, inboundText: 'oi de novo' }, deps);
  assert.equal(out.skipped, 'cooldown'); assert.equal(deps.spy.sends, 0);
});

test('(5) grupo -> nunca responde', async () => {
  await conv('GROUP'); await setModo('auto');
  const deps = mkDeps(NOITE);
  const out = await autoReply.maybeAutoReply({ id: T1 }, { channel: 'whatsapp', externalId: EXT, inboundText: 'oi' }, deps);
  assert.equal(out.skipped, 'nao_direct'); assert.equal(deps.spy.sends, 0);
});

test('(7) sem business_hours configurado -> não responde (evita 24/7)', async () => {
  await conv(); await setModo('auto');
  await c.query(`UPDATE tenant_lead_config SET business_hours = '{}'::jsonb WHERE tenant_id=$1`, [T1]);
  const deps = mkDeps(NOITE);
  const out = await autoReply.maybeAutoReply({ id: T1 }, { channel: 'whatsapp', externalId: EXT, inboundText: 'oi' }, deps);
  assert.equal(out.skipped, 'sem_horario'); assert.equal(deps.spy.sends, 0);
  await c.query(`UPDATE tenant_lead_config SET business_hours = $2 WHERE tenant_id=$1`, [T1, JSON.stringify(BH)]);
});

test('(6) pausa global AUTOREPLY_PAUSE=1 -> não envia', async () => {
  await conv(); await setModo('auto');
  process.env.AUTOREPLY_PAUSE = '1';
  const deps = mkDeps(NOITE);
  const out = await autoReply.maybeAutoReply({ id: T1 }, { channel: 'whatsapp', externalId: EXT, inboundText: 'oi' }, deps);
  delete process.env.AUTOREPLY_PAUSE;
  assert.equal(out.skipped, 'paused'); assert.equal(deps.spy.sends, 0);
});
