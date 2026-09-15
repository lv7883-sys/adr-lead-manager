'use strict';
// inbox-send.itest.js — ADR-042 / E12-06: envio humano na conversa (via Z-API/Evolution).
// A API externa (Evolution) e as credenciais sao MOCKADAS (deps injetadas) — NAO dispara
// WhatsApp. O outbound.registrarSaida REAL grava em staff_outbound_samples (mesmo DB), entao
// asseguramos a persistencia. Cobre: happy-path; 404; canal nao suportado; sem-evolution;
// instancia fechada — e que a API externa NAO e chamada nos casos de erro.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const inbox = require('../src/routes/inbox');

let c;
const T1 = '00000000-0000-0000-0000-0000000000a1';

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text, external_id text,
      conversation_kind text DEFAULT 'DIRECT');   -- a saída marca is_group a partir daqui
    CREATE TABLE staff_outbound_samples (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text, external_id text,
      external_message_id text, source text, sender text, body text, raw jsonb,
      media_url text, media_type text, media_filename text, reply_to_message_id uuid, reply_to_external_id text,
      is_group boolean NOT NULL DEFAULT false, deleted_at timestamptz, conteudo jsonb);   -- migr. 103 / 116
    CREATE UNIQUE INDEX so_uq ON staff_outbound_samples (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL;
    CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, conversation_id uuid,
      direction text, role text, external_message_id text, sender text, body text, raw jsonb, media_type text,
      received_at timestamptz NOT NULL DEFAULT now());
  `);
});
after(async () => { await c.end(); });

const H = (n) => `+5519${String(n).padStart(9, '0')}`;
async function conv(tenant, ext, channel = 'whatsapp') {
  return (await c.query(`INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1,$2,$3) RETURNING id`, [tenant, channel, ext])).rows[0].id;
}
// Evolution + Meta mockadas com espião de envio. Creds mockadas (sem tocar tenants/crypto).
function mkDeps({ state = 'open', creds = { instance: 'inst', apikey: 'key' }, metaCreds = { pageId: 'PID', token: 'TOK' } } = {}) {
  const spy = { sends: 0, metaSends: 0, replies: 0, hides: 0 };
  const evolution = {
    status: async () => ({ state }),
    sendText: async () => { spy.sends++; return { key: { id: 'MSGID1' } }; },
    pickMessageId: () => 'MSGID1',
  };
  const meta = {
    sendMessage: async () => { spy.metaSends++; return { message_id: 'MMSG1' }; },
    replyToComment: async (args) => { spy.replies++; spy.replyArgs = args; return { id: 'RCID1' }; },
    hideComment: async (args, hidden) => { spy.hides++; spy.hideArgs = { ...args, hidden }; return { success: true }; },
  };
  return { deps: { evolution, credsForTenant: async () => creds, meta, pageCredsForTenant: async () => metaCreds }, spy };
}
// comentário de post (role=USER, external_message_id = comment_id) numa conversa
async function comentario(tenant, convId, commentId, body = 'tem aula?') {
  await c.query(`INSERT INTO messages (tenant_id, conversation_id, direction, role, external_message_id, body)
                 VALUES ($1,$2,'inbound','USER',$3,$4)`, [tenant, convId, commentId, body]);
}
const soRows = async (tenant) => (await c.query('SELECT * FROM staff_outbound_samples WHERE tenant_id=$1', [tenant])).rows;

// =============================================================================
test('(1) happy-path: envia e persiste a saida (source=api, channel=whatsapp)', async () => {
  const cv = await conv(T1, H(1));
  const { deps, spy } = mkDeps();
  const out = await inbox.sendMessage(T1, cv, { text: 'ola tudo bem?', sender: 'RECEPCAO' }, deps);
  assert.equal(out.ok, true);
  assert.equal(out.message_id, 'MSGID1');
  assert.equal(spy.sends, 1, 'chamou o envio externo uma vez');
  const rows = await soRows(T1);
  const row = rows.find((r) => r.external_message_id === 'MSGID1');
  assert.ok(row, 'gravou em staff_outbound_samples');
  assert.equal(row.body, 'ola tudo bem?');
  assert.equal(row.external_id, H(1));
  assert.equal(row.source, 'api');
  assert.equal(row.channel, 'whatsapp');
  assert.equal(row.sender, 'RECEPCAO');
});

test('(2) conversa inexistente -> notFound, sem chamar a API externa', async () => {
  const { deps, spy } = mkDeps();
  const out = await inbox.sendMessage(T1, '00000000-0000-0000-0000-0000000000ff', { text: 'oi' }, deps);
  assert.deepEqual(out, { notFound: true });
  assert.equal(spy.sends, 0);
});

test('(3) canal nao suportado (ex.: google) -> unsupported, sem envio', async () => {
  const cv = await conv(T1, H(3), 'google');
  const { deps, spy } = mkDeps();
  const out = await inbox.sendMessage(T1, cv, { text: 'oi' }, deps);
  assert.deepEqual(out, { unsupported: 'google' });
  assert.equal(spy.sends, 0); assert.equal(spy.metaSends, 0);
});

test('(3b) Instagram DM -> envia via Meta (PSID) e persiste a saida', async () => {
  const cv = await conv(T1, '17841400000000001', 'instagram_dm');
  const { deps, spy } = mkDeps();
  const out = await inbox.sendMessage(T1, cv, { text: 'oi pelo insta', sender: 'RECEPCAO' }, deps);
  assert.equal(out.ok, true); assert.equal(out.channel, 'instagram_dm'); assert.equal(out.message_id, 'MMSG1');
  assert.equal(spy.metaSends, 1); assert.equal(spy.sends, 0, 'nao chamou Evolution');
  const row = (await soRows(T1)).find((r) => r.external_message_id === 'MMSG1');
  assert.ok(row); assert.equal(row.body, 'oi pelo insta'); assert.equal(row.external_id, '17841400000000001');
});

test('(3c) Messenger sem credenciais Meta -> tenant_sem_meta, sem envio', async () => {
  const cv = await conv(T1, '2000000000001', 'facebook_messenger');
  const { deps, spy } = mkDeps({ metaCreds: { pageId: null, token: null } });
  const out = await inbox.sendMessage(T1, cv, { text: 'oi' }, deps);
  assert.equal(out.reason, 'tenant_sem_meta'); assert.equal(spy.metaSends, 0);
});

test('(4) tenant sem evolution -> reason, sem envio', async () => {
  const cv = await conv(T1, H(4));
  const { deps, spy } = mkDeps({ creds: { instance: null, apikey: null } });
  const out = await inbox.sendMessage(T1, cv, { text: 'oi' }, deps);
  assert.equal(out.reason, 'tenant_sem_evolution');
  assert.equal(spy.sends, 0);
});

test('(5) instancia desconectada -> reason=instancia=..., sem envio', async () => {
  const cv = await conv(T1, H(5));
  const { deps, spy } = mkDeps({ state: 'close' });
  const out = await inbox.sendMessage(T1, cv, { text: 'oi' }, deps);
  assert.equal(out.reason, 'instancia=close');
  assert.equal(spy.sends, 0);
});

test('(6) comentário FB -> responde ao ÚLTIMO comentário (Graph) e persiste a saída', async () => {
  const cv = await conv(T1, 'FBUSER1', 'facebook_comment');
  await comentario(T1, cv, 'CMT_OLD', 'primeiro');
  await comentario(T1, cv, 'CMT_LAST', 'tem aula de bateria?');
  const { deps, spy } = mkDeps();
  const out = await inbox.sendMessage(T1, cv, { text: 'Oi! Temos sim 🥁', sender: 'RECEPCAO' }, deps);
  assert.equal(out.ok, true); assert.equal(out.channel, 'facebook_comment'); assert.equal(out.message_id, 'RCID1');
  assert.equal(spy.replies, 1); assert.equal(spy.metaSends, 0); assert.equal(spy.sends, 0);
  assert.equal(spy.replyArgs.commentId, 'CMT_LAST', 'responde ao comentário mais recente');
  assert.equal(spy.replyArgs.channel, 'facebook_comment');
  const row = (await soRows(T1)).find((r) => r.external_message_id === 'RCID1');
  assert.ok(row); assert.equal(row.body, 'Oi! Temos sim 🥁'); assert.equal(row.external_id, 'FBUSER1');
});

test('(7) comentário sem alvo (nenhum comment_id) -> reason=sem_comentario_alvo', async () => {
  const cv = await conv(T1, 'IGUSER9', 'instagram_comment');
  const { deps, spy } = mkDeps();
  const out = await inbox.sendMessage(T1, cv, { text: 'oi' }, deps);
  assert.equal(out.reason, 'sem_comentario_alvo'); assert.equal(spy.replies, 0);
});

test('(8) ocultar comentário -> chama hideComment com o canal certo', async () => {
  const cv = await conv(T1, 'IGUSER8', 'instagram_comment');
  const { deps, spy } = mkDeps();
  const out = await inbox.ocultarComentario(T1, cv, 'CMT8', true, deps);
  assert.equal(out.ok, true); assert.equal(out.hidden, true);
  assert.equal(spy.hides, 1);
  assert.equal(spy.hideArgs.commentId, 'CMT8'); assert.equal(spy.hideArgs.channel, 'instagram_comment'); assert.equal(spy.hideArgs.hidden, true);
});

test('(9) ocultar em canal não-comentário -> unsupported, sem chamar Graph', async () => {
  const cv = await conv(T1, H(9), 'whatsapp');
  const { deps, spy } = mkDeps();
  const out = await inbox.ocultarComentario(T1, cv, 'X', true, deps);
  assert.deepEqual(out, { unsupported: 'whatsapp' }); assert.equal(spy.hides, 0);
});

test('(10) responder a mensagem NOSSA (recepção): cita com a key fromMe e grava reply_to_external_id', async () => {
  const cv = await conv(T1, H(10));
  const nossa = (await c.query(`INSERT INTO staff_outbound_samples (tenant_id, channel, external_id, external_message_id, source, body)
     VALUES ($1,'whatsapp',$2,'NOSSA1','api','Aula amanhã às 17h') RETURNING id`, [T1, H(10)])).rows[0].id;
  const { deps } = mkDeps();
  let quotedVisto = null;
  deps.evolution.sendText = async (_c, _n, _t, quoted) => { quotedVisto = quoted; return { key: { id: 'MSGID10' } }; };
  deps.evolution.pickMessageId = () => 'MSGID10';
  const out = await inbox.sendMessage(T1, cv, { text: 'confirmando!', sender: 'RECEPCAO', replyToMessageId: nossa }, deps);
  assert.equal(out.ok, true);
  assert.equal(out.quoted, true);
  assert.equal(quotedVisto.key.id, 'NOSSA1');
  assert.equal(quotedVisto.key.fromMe, true);
  const row = (await soRows(T1)).find((r) => r.external_message_id === 'MSGID10');
  assert.equal(row.reply_to_message_id, null);
  assert.equal(row.reply_to_external_id, 'NOSSA1');
});


// ---- paridade 5: o menu 📎 do WhatsApp (localização, contato, enquete) e a @menção -------------------------------
function especiais(deps) {
  const spy = { chamadas: [] };
  const resposta = (id) => ({ key: { id, fromMe: true, remoteJid: '5519000000011@s.whatsapp.net' },
    message: { pollCreationMessageV3: { name: 'x' }, messageContextInfo: { messageSecret: 'U0VHUkVETw==' } } });
  deps.evolution.sendPoll = async (_c, n, a) => { spy.chamadas.push(['poll', n, a]); return resposta('POLL11'); };
  deps.evolution.sendLocation = async (_c, n, a) => { spy.chamadas.push(['loc', n, a]); return { key: { id: 'LOC11' } }; };
  deps.evolution.sendContact = async (_c, n, a) => { spy.chamadas.push(['ctt', n, a]); return { key: { id: 'CTT11' } }; };
  deps.evolution.pickMessageId = (r) => r && r.key && r.key.id;
  return spy;
}

test('(11) enquete: envia, grava o cartão e a mensagem com o segredo (para somar os votos)', async () => {
  const cv = await conv(T1, H(11));
  const { deps } = mkDeps(); const spy = especiais(deps);
  const out = await inbox.sendEspecial(T1, cv, { tipo: 'enquete', dados: { pergunta: 'Melhor dia?', opcoes: ['Sábado', 'Domingo', 'Sábado', ''], multipla: false }, sender: 'RECEPCAO' }, deps);
  assert.equal(out.ok, true);
  assert.deepEqual(spy.chamadas[0][2], { pergunta: 'Melhor dia?', opcoes: ['Sábado', 'Domingo'], multipla: false });
  const row = (await soRows(T1)).find((r) => r.external_message_id === 'POLL11');
  assert.equal(row.body, '📊 Enquete: Melhor dia?\n• Sábado\n• Domingo');
  assert.equal(row.conteudo.tipo, 'enquete');
  assert.equal(row.raw.data.message.messageContextInfo.messageSecret, 'U0VHUkVETw==');
});

test('(12) localização e contato: cartão igual ao da entrada; dados inválidos não enviam', async () => {
  const cv = await conv(T1, H(12));
  const { deps } = mkDeps(); const spy = especiais(deps);
  const loc = await inbox.sendEspecial(T1, cv, { tipo: 'localizacao', dados: { latitude: '-22.97', longitude: '-46.99', nome: 'Academia do Rock', endereco: 'Av. X, 100' } }, deps);
  assert.equal(loc.ok, true);
  const rl = (await soRows(T1)).find((r) => r.external_message_id === 'LOC11');
  assert.equal(rl.body, '📍 Localização: Academia do Rock — Av. X, 100');
  assert.equal(rl.conteudo.url, 'https://maps.google.com/?q=-22.97,-46.99');
  const ctt = await inbox.sendEspecial(T1, cv, { tipo: 'contato', dados: { nome: 'Secretaria', telefone: '(19) 99999-0000' } }, deps);
  assert.equal(ctt.ok, true);
  assert.equal((await soRows(T1)).find((r) => r.external_message_id === 'CTT11').body, '👤 Contato: Secretaria');
  const n = spy.chamadas.length;
  assert.deepEqual(await inbox.sendEspecial(T1, cv, { tipo: 'localizacao', dados: { latitude: 'abc', longitude: 1 } }, deps), { invalido: 'coordenadas_invalidas' });
  assert.deepEqual(await inbox.sendEspecial(T1, cv, { tipo: 'enquete', dados: { pergunta: 'x', opcoes: ['só uma'] } }, deps), { invalido: 'enquete_invalida' });
  assert.equal(spy.chamadas.length, n, 'nada enviado');
});

test('(13) @menção no grupo: manda os números e grava as menções (a tela troca pelo nome)', async () => {
  const g = (await c.query("INSERT INTO conversations (tenant_id, channel, external_id, conversation_kind) VALUES ($1,'whatsapp','120363000000000013@g.us','GROUP') RETURNING id", [T1])).rows[0].id;
  const { deps } = mkDeps();
  let opts = null;
  deps.evolution.sendText = async (_c, _n, _t, _q, o) => { opts = o; return { key: { id: 'MEN13' } }; };
  deps.evolution.pickMessageId = () => 'MEN13';
  const out = await inbox.sendMessage(T1, g, { text: '@5519999990001 bom dia!', sender: 'RECEPCAO', mentions: ['5519999990001', 'lixo', '5519999990001'] }, deps);
  assert.equal(out.ok, true);
  assert.deepEqual(opts.mentioned, ['5519999990001']);
  const row = (await soRows(T1)).find((r) => r.external_message_id === 'MEN13');
  assert.deepEqual(row.conteudo.contexto.mencoes, ['5519999990001@s.whatsapp.net']);
  // conversa direta ignora menção
  const cv = await conv(T1, H(13));
  await inbox.sendMessage(T1, cv, { text: 'oi', sender: 'RECEPCAO', mentions: ['5519999990001'] }, deps);
  assert.deepEqual(opts.mentioned, []);
});
