'use strict';
// wa-protocolo.itest.js — paridade 3b (15/09/2026): edição e "apagar para todos" feitos no CELULAR/Web.
// A Evolution desvia toda protocolMessage do upsert para o evento messages.edited (que estava desligado) e o
// histórico traz o tipo como número — as edições e apagamentos se perdiam e viravam bolha vazia.
// PG descartável; webhook e sync reais, sem mock.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const webhook = require('../src/routes/webhook');
const { aplicarProtocoloDoHistorico } = require('../src/waSync');

let c;
const T1 = '00000000-0000-0000-0000-0000000000f3';

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  for (const t of ['messages', 'staff_outbound_samples']) {
    await c.query(`CREATE TABLE ${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_message_id text,
      body text, original_body text, edited_at timestamptz, deleted_at timestamptz)`);
  }
  await c.query(`INSERT INTO staff_outbound_samples (tenant_id, external_message_id, body) VALUES ($1,'S1','Aula às 17h'), ($1,'S2','mensagem errada'), ($1,'S3','x')`, [T1]);
  await c.query(`INSERT INTO messages (tenant_id, external_message_id, body) VALUES ($1,'M1','quero cancelar'), ($1,'M2','oi')`, [T1]);
});
after(async () => { await c.end(); });

const linha = async (t, id) => (await c.query(`SELECT * FROM ${t} WHERE external_message_id=$1`, [id])).rows[0];

test('(1) escola apaga no celular (histórico, tipo 0) -> bolha da escola fica "apagada"', async () => {
  const r = await aplicarProtocoloDoHistorico(T1, { key: { id: 'P1', fromMe: true }, message: { protocolMessage: { key: { id: 'S2', fromMe: true }, type: 0 } } });
  assert.equal(r, 'apagada');
  assert.ok((await linha('staff_outbound_samples', 'S2')).deleted_at);
});

test('(2) escola edita no celular (histórico, tipo 14) -> texto novo + original guardado', async () => {
  const r = await aplicarProtocoloDoHistorico(T1, { key: { id: 'P2', fromMe: true },
    message: { protocolMessage: { key: { id: 'S1', fromMe: true }, type: 14, editedMessage: { conversation: 'Aula às 18h' } } } });
  assert.equal(r, 'edicao');
  const l = await linha('staff_outbound_samples', 'S1');
  assert.equal(l.body, 'Aula às 18h');
  assert.equal(l.original_body, 'Aula às 17h');
  assert.ok(l.edited_at);
});

test('(3) cliente apaga (histórico) -> bolha do cliente fica "apagada"', async () => {
  await aplicarProtocoloDoHistorico(T1, { key: { id: 'P3' }, message: { protocolMessage: { key: { id: 'M1' }, type: 'REVOKE' } } });
  assert.ok((await linha('messages', 'M1')).deleted_at);
});

test('(4) protocolo que não é edição/apagamento -> nada muda', async () => {
  assert.equal(await aplicarProtocoloDoHistorico(T1, { key: { id: 'P4' }, message: { protocolMessage: { type: 3, ephemeralExpiration: 86400 } } }), null);
  assert.equal(await aplicarProtocoloDoHistorico(T1, { key: { id: 'P5' }, message: { conversation: 'oi' } }), null);
});

test('(5) webhook messages.edited ao vivo: apagamento e edição chegam na original', async () => {
  await webhook.marcarApagada(T1, webhook._detectDelete({ event: 'messages.edited', data: { key: { id: 'S3', fromMe: true }, type: 'REVOKE' } }));
  assert.ok((await linha('staff_outbound_samples', 'S3')).deleted_at);
  await webhook.aplicarEdicao(T1, webhook._detectEdit({ event: 'messages.edited', data: { key: { id: 'M2' }, type: 'MESSAGE_EDIT', editedMessage: { conversation: 'olá!' } } }));
  assert.equal((await linha('messages', 'M2')).body, 'olá!');
});
