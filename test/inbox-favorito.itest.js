'use strict';
// inbox-favorito.itest.js — ADR-042: favoritar mensagens (estrela). toggle insert/delete +
// enriquecimento da thread (favorito=true na bolha). Conecta como postgres (sem RLS), schema
// mínimo — mesmo padrão dos demais itests.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const inbox = require('../src/routes/inbox');
const { withTenant } = require('../src/db');

let c;
const T1 = '00000000-0000-0000-0000-0000000000fa';

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text,
      external_id text, conversation_kind text DEFAULT 'DIRECT', updated_at timestamptz DEFAULT now(), last_read_at timestamptz);
    CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, role text, sender text,
      body text, media_url text, media_type text, media_filename text, media_transcription text,
      edited_at timestamptz, deleted_at timestamptz, received_at timestamptz DEFAULT now(),
      external_message_id text, reply_to_message_id uuid, raw jsonb);
    CREATE TABLE staff_outbound_samples (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_id text, sender text,
      body text, media_url text, media_type text, media_filename text,
      edited_at timestamptz, deleted_at timestamptz, received_at timestamptz DEFAULT now(),
      external_message_id text, reply_to_message_id uuid, ack_status text, raw jsonb);
    CREATE TABLE pending_approvals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid,
      suggested_response text, status text, reply_to_message_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE leads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, phone text,
      meta_psid text, status text, desfecho text, origem text, created_at timestamptz DEFAULT now());
    CREATE TABLE message_favorites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, conversation_id uuid,
      message_kind text, message_id uuid, favorited_by text, favorited_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX mf_uq ON message_favorites (tenant_id, message_id, favorited_by);
  `);
});
after(async () => { await c.end(); });

const EXT = '+5519988887777';
const U1 = '20', U2 = '21';   // Késsia, Rafaela (ids do dashboard, texto)
async function setup() {
  const cv = (await c.query(`INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1,'whatsapp',$2) RETURNING id`, [T1, EXT])).rows[0].id;
  const mid = (await c.query(`INSERT INTO messages (conversation_id, role, body) VALUES ($1,'USER','mensagem importante') RETURNING id`, [cv])).rows[0].id;
  return { cv, mid };
}
const countFav = async (mid) => (await c.query(`SELECT count(*)::int n FROM message_favorites WHERE tenant_id=$1 AND message_id=$2`, [T1, mid])).rows[0].n;

test('(1) favoritar cria o registro do usuário (favorito=true)', async () => {
  const { cv, mid } = await setup();
  const out = await inbox.toggleFavorito(T1, cv, mid, 'lead', U1);
  assert.equal(out.ok, true); assert.equal(out.favorito, true);
  assert.equal(await countFav(mid), 1);
});

test('(2) a thread marca a bolha favoritada SÓ p/ o dono (per-user)', async () => {
  const { cv, mid } = await setup();
  await inbox.toggleFavorito(T1, cv, mid, 'lead', U1);   // Késsia favorita
  const thK = await withTenant(T1, (client) => inbox.getConversationThread(client, T1, cv, U1));
  assert.equal(thK.timeline.find((m) => m.id === mid).favorito, true, 'Késsia vê favorita');
  const thR = await withTenant(T1, (client) => inbox.getConversationThread(client, T1, cv, U2));
  assert.ok(!thR.timeline.find((m) => m.id === mid).favorito, 'Rafaela NÃO vê a favorita da Késsia');
});

test('(3) usuários diferentes favoritam a MESMA mensagem (2 registros)', async () => {
  const { cv, mid } = await setup();
  await inbox.toggleFavorito(T1, cv, mid, 'lead', U1);
  await inbox.toggleFavorito(T1, cv, mid, 'lead', U2);
  assert.equal(await countFav(mid), 2, 'uma favorita por usuário');
});

test('(4) toggle de novo desfavorita só a do usuário', async () => {
  const { cv, mid } = await setup();
  await inbox.toggleFavorito(T1, cv, mid, 'lead', U1);
  await inbox.toggleFavorito(T1, cv, mid, 'lead', U2);
  const out = await inbox.toggleFavorito(T1, cv, mid, 'lead', U1); // Késsia desfavorita
  assert.equal(out.favorito, false);
  assert.equal(await countFav(mid), 1, 'a da Rafaela permanece');
  const thR = await withTenant(T1, (client) => inbox.getConversationThread(client, T1, cv, U2));
  assert.equal(thR.timeline.find((m) => m.id === mid).favorito, true, 'Rafaela ainda vê a sua');
});

test('(5) kind inválido cai em lead (não estoura)', async () => {
  const { cv, mid } = await setup();
  const out = await inbox.toggleFavorito(T1, cv, mid, 'xpto', U1);
  assert.equal(out.favorito, true);
  const k = (await c.query(`SELECT message_kind FROM message_favorites WHERE tenant_id=$1 AND message_id=$2`, [T1, mid])).rows[0];
  assert.equal(k.message_kind, 'lead');
});
