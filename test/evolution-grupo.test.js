'use strict';
// evolution-grupo.test.js — ADR-042 B3: sendText/sendMedia enviam o jid @g.us INTEIRO no
// campo `number` (sem strip de dígitos nem toggle-9), enquanto o telefone individual continua
// normalizado. Stub do fetch global (sem rede). Requer EVOLUTION_URL só p/ passar o guard.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.EVOLUTION_URL = 'http://evo.test';
const evo = require('../src/evolution');

let calls;
const realFetch = global.fetch;
before(() => {
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ key: { id: 'MID' } }) };
  };
});
after(() => { global.fetch = realFetch; });

const CREDS = { instance: 'inst', apikey: 'k' };
const GJID = '120363402601589198@g.us';

test('sendText p/ GRUPO manda o jid @g.us inteiro no number', async () => {
  calls = [];
  await evo.sendText(CREDS, GJID, 'oi grupo');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.number, GJID, 'number = jid completo, sem strip');
  assert.equal(calls[0].body.text, 'oi grupo');
});

test('sendText p/ telefone individual continua normalizado (só dígitos)', async () => {
  calls = [];
  await evo.sendText(CREDS, '+55 (19) 99999-8888', 'oi');
  assert.equal(calls[0].body.number, '5519999998888');
});

test('sendMedia p/ GRUPO manda o jid @g.us inteiro no number', async () => {
  calls = [];
  await evo.sendMedia(CREDS, GJID, { mediatype: 'image', mimetype: 'image/png', media: 'b64', fileName: 'x.png' });
  assert.equal(calls[0].body.number, GJID);
  assert.equal(calls[0].body.mediatype, 'image');
});
