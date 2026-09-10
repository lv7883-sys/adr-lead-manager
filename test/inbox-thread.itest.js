'use strict';
// inbox-thread.itest.js — ADR-042 / E12-05: thread da conversa (fonte única src/timeline.js).
// Cobre: (1) conversa de LEAD mescla as 3 fontes (lead + recepcao + ia) em ordem cronologica,
// deduplicando o eco da IA; (2) conversa de NAO-LEAD (leadId null) traz so lead+recepcao, sem
// crash no ramo IA; (3) reply_to resolvido; (4) 404 p/ conversa inexistente / de outro tenant.
//
// Conecta como postgres (sem RLS), schema minimo — mesmo padrao dos demais itests.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const inbox = require('../src/routes/inbox');

let c;
const T1 = '00000000-0000-0000-0000-0000000000f1';
const T2 = '00000000-0000-0000-0000-0000000000f2';

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE OR REPLACE FUNCTION br_phone_key(x text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
      WITH d AS (SELECT regexp_replace(coalesce(x, ''), '[^0-9]', '', 'g') AS v),
           loc AS (SELECT CASE WHEN length(v) IN (12,13) AND left(v,2)='55' THEN substr(v,3) ELSE v END AS v FROM d)
      SELECT CASE WHEN length(v)=11 AND substr(v,3,1)='9' THEN left(v,2)||substr(v,4) ELSE v END FROM loc
    $fn$;
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
      external_message_id text, reply_to_message_id uuid, ack_status text, raw jsonb,
      is_group boolean NOT NULL DEFAULT false);   -- migr. 103
    CREATE TABLE pending_approvals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid,
      suggested_response text, status text, reply_to_message_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE leads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, phone text,
      meta_psid text, status text, desfecho text, origem text, created_at timestamptz DEFAULT now());
    CREATE TABLE message_favorites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, conversation_id uuid,
      message_kind text, message_id uuid, favorited_by text, favorited_at timestamptz DEFAULT now());
    -- "nome empilhado" (getConversationThread): cadastro canônico via contact_point/person + br_phone_key (migr. 085).
    CREATE TABLE contact_point (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, person_id uuid, kind text, value_raw text,
      br_key text GENERATED ALWAYS AS (br_phone_key(value_raw)) STORED);   -- migr. 112
    CREATE TABLE person (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, display_name text);
  `);
});
after(async () => { await c.end(); });

const H = (n) => `+5519${String(n).padStart(9, '0')}`;
const Dg = (n) => `5519${String(n).padStart(9, '0')}`;

async function conv(tenant, ext) {
  return (await c.query(`INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1,'whatsapp',$2) RETURNING id`, [tenant, ext])).rows[0].id;
}
async function msg(convId, o = {}) {
  return (await c.query(
    `INSERT INTO messages (conversation_id, role, sender, body, received_at, external_message_id, reply_to_message_id, raw)
     VALUES ($1,$2,$3,$4, now() - make_interval(days => $5), $6, $7, $8) RETURNING id`,
    [convId, o.role || 'USER', o.sender || null, o.body ?? 'oi', o.dias || 0,
     o.extMsgId || null, o.replyTo || null, o.raw || null])).rows[0].id;
}
async function outbound(tenant, extDigits, o = {}) {
  return (await c.query(
    `INSERT INTO staff_outbound_samples (tenant_id, external_id, sender, body, received_at, external_message_id, ack_status, raw)
     VALUES ($1,$2,$3,$4, now() - make_interval(days => $5), $6, $7, $8) RETURNING id`,
    [tenant, extDigits, o.sender || 'RECEPCAO', o.body ?? 'resposta', o.dias || 0,
     o.extMsgId || null, o.ack || null, o.raw || null])).rows[0].id;
}
async function pending(tenant, leadId, o = {}) {
  return (await c.query(
    `INSERT INTO pending_approvals (tenant_id, lead_id, suggested_response, status, created_at)
     VALUES ($1,$2,$3,$4, now() - make_interval(days => $5)) RETURNING id`,
    [tenant, leadId, o.body ?? 'resposta IA', o.status || 'APPROVED', o.dias || 0])).rows[0].id;
}
async function lead(tenant, o = {}) {
  return (await c.query(
    `INSERT INTO leads (tenant_id, name, phone, status, origem) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tenant, o.name || null, o.phone || null, o.status || 'QUALIFYING', o.origem || null])).rows[0].id;
}
const thread = (tenant, convId) => inbox.getConversationThread(c, tenant, convId);

// =============================================================================
test('(1) conversa de LEAD mescla lead + recepcao + ia em ordem cronologica', async () => {
  const cv = await conv(T1, H(1));
  const leadId = await lead(T1, { phone: Dg(1), name: 'Ana', origem: 'whatsapp' });
  await msg(cv, { body: 'quero aula', dias: 3, extMsgId: 'M1' });                 // lead
  await outbound(T1, Dg(1), { body: 'ola!', dias: 2, extMsgId: 'S1' });           // recepcao
  await pending(T1, leadId, { body: 'resposta IA', status: 'APPROVED', dias: 1 }); // ia
  await outbound(T1, Dg(1), { body: 'resposta IA', dias: 1, extMsgId: 'S2' });    // eco da IA (dedup)

  const out = await thread(T1, cv);
  assert.equal(out.conversation.is_lead, true);
  assert.equal(out.conversation.lead_id, leadId);
  const kinds = out.timeline.map((t) => t.kind);
  assert.deepEqual(kinds, ['lead', 'recepcao', 'ia'], 'ordem cronologica das 3 fontes');
  assert.equal(out.timeline.filter((t) => t.body === 'resposta IA').length, 1, 'eco da IA nao duplica');
});

test('(2) conversa de NAO-LEAD: so lead+recepcao, sem crash no ramo IA', async () => {
  const cv = await conv(T1, H(2));   // sem lead casavel
  await msg(cv, { body: 'boa tarde', dias: 1, extMsgId: 'M9' });
  await outbound(T1, Dg(2), { body: 'oi, tudo bem?', dias: 0, extMsgId: 'S9' });

  const out = await thread(T1, cv);
  assert.equal(out.conversation.is_lead, false);
  assert.equal(out.conversation.lead_id, null);
  assert.deepEqual(out.timeline.map((t) => t.kind), ['lead', 'recepcao']);
});

test('(3) reply_to resolvido a partir da mensagem citada', async () => {
  const cv = await conv(T1, H(3));
  await lead(T1, { phone: Dg(3), status: 'QUALIFYING' });
  const m1 = await msg(cv, { body: 'primeira', dias: 2, extMsgId: 'R1' });
  await msg(cv, { body: 'citando', dias: 1, extMsgId: 'R2', replyTo: m1 });

  const out = await thread(T1, cv);
  const citou = out.timeline.find((t) => t.body === 'citando');
  assert.ok(citou.reply_to, 'tem reply_to');
  assert.equal(citou.reply_to.author, 'lead');
  assert.equal(citou.reply_to.preview, 'primeira');
});

test('(5) timeline expõe external_message_id por bolha (p/ ocultar comentário)', async () => {
  const cv = await conv(T1, H(5));
  await lead(T1, { phone: Dg(5), status: 'QUALIFYING' });
  await msg(cv, { body: 'comentario', dias: 0, extMsgId: 'CMT_X' });
  const out = await thread(T1, cv);
  const b = out.timeline.find((t) => t.body === 'comentario');
  assert.equal(b.external_message_id, 'CMT_X', 'comment_id exposto na bolha');
});

test('(4) 404: conversa inexistente ou de outro tenant', async () => {
  const cv = await conv(T2, H(4)); await msg(cv, { body: 'x' });
  assert.equal(await thread(T1, '00000000-0000-0000-0000-0000000000ff'), null, 'inexistente');
  assert.equal(await thread(T1, cv), null, 'conversa de T2 nao acessivel por T1');
});

// Regressão da queixa da recepção (09/09/2026): "eu respondo no grupo e ele mostra como se eu
// tivesse mandado para a pessoa no privado". O casamento da timeline é por DÍGITOS, e o id de um
// grupo vira dígitos igual a um telefone — havia 11 conversas DIRETAS com id de grupo (migr. 113),
// e cada uma espelhava a conversa do grupo inteira. Grupo e conversa direta agora não se cruzam.
test('(6) grupo e conversa direta com os MESMOS digitos nao se misturam', async () => {
  const idGrupo = '120363224711320694';   // id de grupo: 18 digitos (acima do teto do E.164)
  const grupo = (await c.query(
    `INSERT INTO conversations (tenant_id, channel, external_id, conversation_kind)
     VALUES ($1,'whatsapp',$2,'GROUP') RETURNING id`, [T1, `${idGrupo}@g.us`])).rows[0].id;
  const direta = await conv(T1, idGrupo);   // a "fantasma" que a migr. 113 removeu

  await msg(grupo, { body: 'papo do grupo', dias: 1, extMsgId: 'G1', sender: 'Daniele' });
  await msg(direta, { body: 'papo privado', dias: 1, extMsgId: 'P1' });
  await c.query(
    `INSERT INTO staff_outbound_samples (tenant_id, external_id, body, external_message_id, is_group)
     VALUES ($1,$2,'resposta no grupo','SG1',true), ($1,$2,'resposta no privado','SP1',false)`,
    [T1, idGrupo]);

  const noGrupo = (await thread(T1, grupo)).timeline.map((t) => t.body);
  const noPrivado = (await thread(T1, direta)).timeline.map((t) => t.body);

  assert.deepEqual(noGrupo.sort(), ['papo do grupo', 'resposta no grupo'].sort(),
    'thread do grupo nao puxa o que e da conversa direta');
  assert.deepEqual(noPrivado.sort(), ['papo privado', 'resposta no privado'].sort(),
    'thread direta nao puxa o que e do grupo');
});

// Queixa da recepção (10/09/2026): "não vemos as reações dos clientes". O servidor já grudava a
// reação na bolha-alvo (e por isso a bolha "[reação] ❤️" some da lista) — quem não desenhava era a
// tela. Aqui trava o contrato dos dois lados + a troca de reação.
test('(7) reação gruda na bolha-alvo (cliente e recepção) e a última substitui a anterior', async () => {
  const cv = await conv(T1, H(7));
  const reac = (emoji, alvo) => ({ data: { message: { reactionMessage: { text: emoji, key: { id: alvo } } } } });
  await msg(cv, { body: 'oi, tudo bem?', dias: 3, extMsgId: 'M70' });        // bolha do cliente
  await outbound(T1, Dg(7), { body: 'ola!', dias: 3, extMsgId: 'S70' });     // bolha nossa
  await msg(cv, { body: '[reação] 👍', dias: 2, extMsgId: 'M71', raw: reac('👍', 'S70') });
  await msg(cv, { body: '[reação] ❤️', dias: 1, extMsgId: 'M72', raw: reac('❤️', 'S70') });  // trocou
  await outbound(T1, Dg(7), { body: '[reação] 🙏', dias: 0, extMsgId: 'S71', raw: reac('🙏', 'M70') });

  const out = await thread(T1, cv);
  const bodies = out.timeline.map((t) => String(t.body || ''));
  assert.ok(!bodies.some((b) => b.startsWith('[reação]')), 'reação que grudou não vira bolha solta');
  assert.deepEqual(out.timeline.find((t) => t.body === 'ola!').reactions, ['❤️'],
    'reação do cliente na nossa bolha, só a última (trocar substitui)');
  assert.deepEqual(out.timeline.find((t) => t.body === 'oi, tudo bem?').reactions, ['🙏'],
    'reação da recepção gruda na bolha do cliente');
});

test('(8) reação SEM alvo conhecido continua visível como bolha (não some da conversa)', async () => {
  const cv = await conv(T1, H(8));
  await msg(cv, { body: 'bom dia', dias: 1, extMsgId: 'M80' });
  await msg(cv, { body: '[reação] 🥴', dias: 0, extMsgId: 'M81',
    raw: { data: { message: { reactionMessage: { text: '🥴', key: { id: 'ALVO-QUE-NAO-TEMOS' } } } } } });
  const bodies = (await thread(T1, cv)).timeline.map((t) => t.body);
  assert.ok(bodies.includes('[reação] 🥴'), 'sem alvo capturado, a reação permanece como bolha');
});
