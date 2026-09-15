'use strict';
// waEnquete.itest.js — voto de enquete cifrado somado na enquete original, contra Postgres real (paridade 3).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Client } = require('pg');
const enquete = require('../src/waEnquete');

let c;
const T1 = '00000000-0000-0000-0000-0000000000e8';
const SEGREDO = crypto.randomBytes(32);
const GRUPO = '120363000000000009@g.us';
const CRIADOR = '5519999990001@s.whatsapp.net';
const hash = (o) => crypto.createHash('sha256').update(o).digest();
const ld = (campo, buf) => Buffer.concat([Buffer.from([(campo << 3) | 2, buf.length]), buf]);

function voto({ votante, opcoes, pushName }) {
  const claro = Buffer.concat(opcoes.map((o) => ld(1, hash(o))));
  const { encIv, encPayload } = enquete._cifrarVotoParaTeste({ segredo: SEGREDO, enqueteId: 'POLL1', criador: CRIADOR, votante, claro });
  return { key: { id: 'V' + Math.random(), remoteJid: GRUPO, participant: votante, fromMe: false }, pushName,
    message: { pollUpdateMessage: { pollCreationMessageKey: { id: 'POLL1', remoteJid: GRUPO, participant: CRIADOR },
      vote: { encIv: encIv.toString('base64'), encPayload: encPayload.toString('base64') } } } };
}

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, body text, raw jsonb, conteudo jsonb, external_message_id text);
    CREATE TABLE staff_outbound_samples (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, body text, raw jsonb, conteudo jsonb, external_message_id text);
    CREATE TABLE wa_lid (tenant_id uuid NOT NULL, lid text NOT NULL, pn text, proprio boolean NOT NULL DEFAULT false,
      visto_em timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, lid));
  `);
  await c.query(`INSERT INTO messages (tenant_id, body, raw, conteudo, external_message_id) VALUES ($1, '📊 Enquete: Melhor dia?', $2, $3, 'POLL1')`,
    [T1, { data: { key: { remoteJid: GRUPO, participant: CRIADOR, fromMe: false }, message: { pollCreationMessageV3: {}, messageContextInfo: { messageSecret: SEGREDO.toString('base64') } } } },
      { tipo: 'enquete', pergunta: 'Melhor dia?', opcoes: ['Sábado', 'Domingo'], multipla: false, votos: {} }]);
});
after(async () => { await c.end(); });

const votos = async () => (await c.query(`SELECT conteudo->'votos' AS v FROM messages WHERE external_message_id='POLL1'`)).rows[0].v;

test('(1) voto no grupo soma na enquete, com o nome de quem votou', async () => {
  const r = await enquete.aplicarVoto(T1, voto({ votante: '5519999990002@s.whatsapp.net', opcoes: ['Domingo'], pushName: 'Maria' }));
  assert.equal(r.resultado, 'votou');
  const v = await votos();
  assert.deepEqual(v['5519999990002'].opcoes, ['Domingo']);
  assert.equal(v['5519999990002'].nome, 'Maria');
});

test('(2) a mesma pessoa muda o voto -> substitui, não soma', async () => {
  await enquete.aplicarVoto(T1, voto({ votante: '5519999990002@s.whatsapp.net', opcoes: ['Sábado'], pushName: 'Maria' }));
  const v = await votos();
  assert.deepEqual(v['5519999990002'].opcoes, ['Sábado']);
  assert.equal(Object.keys(v).length, 1);
});

test('(3) outra pessoa vota -> dois votos', async () => {
  await enquete.aplicarVoto(T1, voto({ votante: '5519999990003@s.whatsapp.net', opcoes: ['Domingo'], pushName: 'João' }));
  assert.equal(Object.keys(await votos()).length, 2);
});

test('(4) enquete que não temos -> nada acontece', async () => {
  const ev = voto({ votante: '5519999990004@s.whatsapp.net', opcoes: ['Domingo'] });
  ev.message.pollUpdateMessage.pollCreationMessageKey.id = 'NAO_EXISTE';
  assert.equal((await enquete.aplicarVoto(T1, ev)).resultado, 'enquete_ausente');
});
