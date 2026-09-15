'use strict';
// leitura-whatsapp.itest.js — paridade 4 (15/09/2026): abrir a conversa no Regente lê também no WhatsApp
// (celular sem contador, tique azul ao cliente) e "marcar como não lida" vale no celular. Evolution mockada.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const leitura = require('../src/leituraWhatsapp');

let c;
const T1 = '00000000-0000-0000-0000-0000000000c4';
const run = async (_t, fn) => fn(c);
const creds = async () => ({ instance: 'i', apikey: 'k' });
function evo() {
  const spy = { lidas: [], naoLida: [] };
  return { spy, evolution: { markMessageAsRead: async (_c, k) => { spy.lidas.push(k); }, markChatUnread: async (_c, b) => { spy.naoLida.push(b); } } };
}

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_id text, conversation_kind text DEFAULT 'DIRECT', last_read_at timestamptz);
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, role text, body text, raw jsonb,
      external_message_id text, received_at timestamptz, deleted_at timestamptz);
    CREATE TABLE wa_lid (tenant_id uuid, lid text, pn text, proprio boolean DEFAULT false, PRIMARY KEY (tenant_id, lid));
  `);
});
after(async () => { await c.end(); });

async function conv(ext, kind = 'DIRECT') {
  return (await c.query(`INSERT INTO conversations (tenant_id, external_id, conversation_kind) VALUES ($1,$2,$3) RETURNING id`, [T1, ext, kind])).rows[0].id;
}
async function msg(cv, id, minAtras, key, o = {}) {
  await c.query(`INSERT INTO messages (conversation_id, role, body, raw, external_message_id, received_at, deleted_at)
                 VALUES ($1,$2,$3,$4,$5, now() - ($6 || ' minutes')::interval, $7)`,
    [cv, o.role || 'USER', o.body || 'oi', key ? { event: 'messages.upsert', data: { key } } : null, id, String(minAtras), o.apagada ? new Date() : null]);
}

test('(1) abrir a conversa lê só as recebidas depois do cursor anterior; @lid vira o número', async () => {
  const cv = await conv('5519999990001');
  await msg(cv, 'A1', 30, { remoteJid: '5519999990001@s.whatsapp.net', id: 'A1' });                    // já lida antes
  await msg(cv, 'A2', 10, { remoteJid: '111@lid', remoteJidAlt: '5519999990001@s.whatsapp.net', id: 'A2' });
  await msg(cv, 'A3', 5, { remoteJid: '222@lid', id: 'A3' });                                           // par em wa_lid
  await msg(cv, 'A4', 4, { remoteJid: '5519999990001@s.whatsapp.net', id: 'A4' }, { role: 'ASSISTANT' }); // nossa: não
  await msg(cv, 'A5', 3, { remoteJid: '5519999990001@s.whatsapp.net', id: 'A5' }, { body: '[reação] ❤️' }); // reação: não
  await msg(cv, 'A6', 2, null);                                                                          // sem raw: número da conversa
  await c.query(`INSERT INTO wa_lid (tenant_id, lid, pn) VALUES ($1,'222@lid','5519999990001@s.whatsapp.net')`, [T1]);
  const { spy, evolution } = evo();
  const r = await leitura.lerNoWhatsapp(T1, cv, new Date(Date.now() - 20 * 60000), new Date(), { withTenant: run, credsForTenant: creds, evolution });
  assert.equal(r.enviadas, 3);
  const ks = spy.lidas[0].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(ks, [
    { remoteJid: '5519999990001@s.whatsapp.net', fromMe: false, id: 'A2' },
    { remoteJid: '5519999990001@s.whatsapp.net', fromMe: false, id: 'A3' },
    { remoteJid: '5519999990001@s.whatsapp.net', fromMe: false, id: 'A6' }]);
});

test('(2) reabrir sem mensagem nova não manda nada (o recarregar da tela não repete recibos)', async () => {
  const cv = await conv('5519999990002');
  await msg(cv, 'B1', 10, { remoteJid: '5519999990002@s.whatsapp.net', id: 'B1' });
  const { spy, evolution } = evo();
  const agora = new Date();
  const r = await leitura.lerNoWhatsapp(T1, cv, agora, agora, { withTenant: run, credsForTenant: creds, evolution });
  assert.equal(r.enviadas, 0);
  assert.equal(spy.lidas.length, 0);
});

test('(3) grupo: lê com o jid do grupo; apagada não entra', async () => {
  const cv = await conv('120363000000000077@g.us', 'GROUP');
  await msg(cv, 'G1', 5, { remoteJid: '120363000000000077@g.us', participant: '333@lid', id: 'G1' });
  await msg(cv, 'G2', 4, { remoteJid: '120363000000000077@g.us', participant: '333@lid', id: 'G2' }, { apagada: true });
  const { spy, evolution } = evo();
  await leitura.lerNoWhatsapp(T1, cv, null, new Date(), { withTenant: run, credsForTenant: creds, evolution });
  assert.deepEqual(spy.lidas[0], [{ remoteJid: '120363000000000077@g.us', fromMe: false, id: 'G1' }]);
});

test('(4) marcar como não lida: usa a última recebida, com o jid do próprio WhatsApp', async () => {
  const cv = await conv('5519999990004');
  await msg(cv, 'N1', 10, { remoteJid: '444@lid', id: 'N1' });
  await msg(cv, 'N2', 2, { remoteJid: '444@lid', id: 'N2' });
  await msg(cv, 'N3', 1, { remoteJid: '444@lid', id: 'N3' }, { role: 'ASSISTANT' });
  const { spy, evolution } = evo();
  const r = await leitura.marcarNaoLidaNoWhatsapp(T1, cv, { withTenant: run, credsForTenant: creds, evolution });
  assert.equal(r.ok, true);
  assert.equal(spy.naoLida[0].chat, '444@lid');
  assert.deepEqual(spy.naoLida[0].lastMessage.key, { remoteJid: '444@lid', fromMe: false, id: 'N2' });
  assert.ok(spy.naoLida[0].lastMessage.messageTimestamp > 1.7e9);
});

test('(5) falha da Evolution nunca derruba a tela', async () => {
  const cv = await conv('5519999990005');
  await msg(cv, 'F1', 1, { remoteJid: '5519999990005@s.whatsapp.net', id: 'F1' });
  const evolution = { markMessageAsRead: async () => { throw new Error('HTTP 500'); } };
  const r = await leitura.lerNoWhatsapp(T1, cv, null, new Date(), { withTenant: run, credsForTenant: creds, evolution });
  assert.equal(r.enviadas, 0);
  assert.match(r.erro, /500/);
});
