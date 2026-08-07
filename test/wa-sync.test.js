'use strict';
//
// RECONEXÃO — backfill do histórico do WhatsApp (waSync). Testes de UNIDADE, sem DB: helpers puros
// + orquestração de backfillTenant/backfillChat/syncReconnections com deps mockadas (evolution,
// credsForTenant, withTenant, importarConversa).
//
const { test } = require('node:test');
const assert = require('node:assert');
const waSync = require('../src/waSync');
const { mapEvolutionMsg } = require('../src/importHistorico');

// ── helpers puros ──────────────────────────────────────────────────────────────────
test('_telefoneDoChat: @s.whatsapp.net → o próprio número', () => {
  assert.equal(waSync._telefoneDoChat('5519999990000@s.whatsapp.net'), '5519999990000');
});
test('_telefoneDoChat: @lid → telefone via key.remoteJidAlt de alguma mensagem', () => {
  const recs = [{ key: { remoteJid: '44903950200873@lid' } }, { key: { remoteJid: '44903950200873@lid', remoteJidAlt: '5511993300613@s.whatsapp.net' } }];
  assert.equal(waSync._telefoneDoChat('44903950200873@lid', recs), '5511993300613');
});
test('_telefoneDoChat: @lid sem remoteJidAlt → null (não dá p/ rotear)', () => {
  assert.equal(waSync._telefoneDoChat('44903950200873@lid', [{ key: { remoteJid: '44903950200873@lid' } }]), null);
});
test('_telefoneDoChat: grupo (@g.us) → null', () => {
  assert.equal(waSync._telefoneDoChat('12036@g.us', []), null);
});

test('_estadoDoConnectionUpdate: extrai state de várias formas do payload', () => {
  assert.equal(waSync._estadoDoConnectionUpdate({ data: { state: 'open' } }), 'open');
  assert.equal(waSync._estadoDoConnectionUpdate({ data: { connection: 'close' } }), 'close');
  assert.equal(waSync._estadoDoConnectionUpdate({ state: 'connecting' }), 'connecting');
  assert.equal(waSync._estadoDoConnectionUpdate({ data: {} }), null);
});

// ── mapEvolutionMsg: mídia sem texto ganha placeholder (senão some no backfill) ──────
test('mapEvolutionMsg: imagem sem legenda vira [imagem] (não bolha vazia)', () => {
  const m = mapEvolutionMsg({ key: { id: 'M1', fromMe: false }, message: { imageMessage: { mimetype: 'image/jpeg' } }, messageTimestamp: 100 });
  assert.equal(m.body, '[imagem]');
  assert.equal(m.externalMessageId, 'M1');
  assert.equal(m.atMs, 100000);
});
test('mapEvolutionMsg: áudio vira [áudio]; texto puro é preservado', () => {
  assert.equal(mapEvolutionMsg({ key: { id: 'A' }, message: { audioMessage: {} } }).body, '[áudio]');
  assert.equal(mapEvolutionMsg({ key: { id: 'B' }, message: { conversation: 'oi' } }).body, 'oi');
});

// ── orquestração ─────────────────────────────────────────────────────────────────────
// withTenant fake: resolveExternalId (br_phone_key) → vazio (cai no canônico); wa_sync_state → vazio.
function fakeWithTenant() {
  return async (_tenantId, cb) => cb({ query: async () => ({ rows: [], rowCount: 0 }) });
}

test('backfillChat: pagina o histórico INTEIRO e roteia @lid pelo remoteJidAlt', async () => {
  const paginas = {
    1: { records: [{ key: { id: 'A', fromMe: true, remoteJid: '44903950200873@lid', remoteJidAlt: '5511993300613@s.whatsapp.net' }, message: { conversation: 'p1' } }], pages: 2, pageSize: 1 },
    2: { records: [{ key: { id: 'B', fromMe: false, remoteJid: '44903950200873@lid', remoteJidAlt: '5511993300613@s.whatsapp.net' }, message: { conversation: 'p2' } }], pages: 2, pageSize: 1 },
  };
  const paginasPedidas = [];
  let externalIdUsado = null;
  const deps = {
    evolution: { findMessages: async (_c, _jid, { page }) => { paginasPedidas.push(page); return paginas[page] || { records: [], pages: 2 }; } },
    importarConversa: async (_t, { externalId, msgs }) => { externalIdUsado = externalId; return { inseridos: msgs.length, pulados: 0 }; },
    withTenant: fakeWithTenant(),
  };
  const r = await waSync.backfillChat('t1', { instance: 'i', apikey: 'k' }, { remoteJid: '44903950200873@lid' }, deps);
  assert.deepEqual(paginasPedidas, [1, 2]);
  assert.equal(r.inseridos, 2);
  assert.equal(externalIdUsado, '5511993300613');   // canônico derivado do remoteJidAlt
});

test('backfillChat: grupo é ignorado', async () => {
  let chamou = false;
  const deps = { evolution: { findMessages: async () => { chamou = true; return { records: [] }; } }, importarConversa: async () => { chamou = true; return {}; }, withTenant: fakeWithTenant() };
  const r = await waSync.backfillChat('t1', { instance: 'i', apikey: 'k' }, { remoteJid: '12036@g.us' }, deps);
  assert.equal(r.inseridos, 0);
  assert.equal(chamou, false);
});

test('backfillTenant: itera findChats, pula grupos e mescla cada 1:1', async () => {
  const chats = [
    { remoteJid: '120363@g.us' },                               // grupo → fora
    { remoteJid: '5519999990001@s.whatsapp.net' },
    { remoteJid: '44903950200873@lid' },
  ];
  const importados = [];
  const deps = {
    credsForTenant: async () => ({ instance: 'inst', apikey: 'k' }),
    evolution: {
      status: async () => ({ state: 'open' }),
      findChats: async () => chats,
      findMessages: async (_c, jid) => ({
        records: [{ key: { id: 'X-' + jid, fromMe: false, remoteJid: jid, remoteJidAlt: /@lid$/.test(jid) ? '5511993300613@s.whatsapp.net' : undefined }, message: { conversation: 'oi' } }],
        pages: 1,
      }),
    },
    importarConversa: async (_t, { externalId, msgs }) => { importados.push(externalId); return { inseridos: msgs.length, pulados: 0 }; },
    withTenant: fakeWithTenant(),
  };
  const out = await waSync.backfillTenant('t1', { deep: true }, deps);
  assert.equal(out.chats, 2);            // grupo excluído
  assert.equal(out.inseridos, 2);
  assert.deepEqual(importados.sort(), ['5511993300613', '5519999990001']);
});

test('backfillTenant: instância NÃO-open → skip sem chamar findChats', async () => {
  let chamou = false;
  const deps = {
    credsForTenant: async () => ({ instance: 'inst', apikey: 'k' }),
    evolution: { status: async () => ({ state: 'connecting' }), findChats: async () => { chamou = true; return []; } },
    withTenant: fakeWithTenant(),
  };
  const out = await waSync.backfillTenant('t1', { deep: true }, deps);
  assert.equal(out.skipped, 'nao_open');
  assert.equal(out.state, 'connecting');
  assert.equal(chamou, false);
});

test('backfillTenant: sem credencial Evolution → skip', async () => {
  const deps = { credsForTenant: async () => ({ instance: null, apikey: null }), withTenant: fakeWithTenant() };
  const out = await waSync.backfillTenant('t1', {}, deps);
  assert.equal(out.skipped, 'sem_evolution');
});

// syncReconnections: só a transição NÃO-open → open dispara o backfill profundo.
test('syncReconnections: reconexão (close→open) dispara backfill', async () => {
  const estados = { t1: { last_state: 'close', last_sync_at: new Date() } };
  const run = async (tenantId, cb) => cb({
    query: async (sql) => {
      if (/FROM wa_sync_state/i.test(sql)) return { rows: estados[tenantId] ? [estados[tenantId]] : [] };
      if (/INSERT INTO wa_sync_state/i.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };   // br_phone_key resolve → vazio (canônico)
    },
  });
  let importou = 0;
  const deps = {
    pool: { query: async () => ({ rows: [{ tenant_id: 't1' }] }) },
    credsForTenant: async () => ({ instance: 'i', apikey: 'k' }),
    evolution: {
      status: async () => ({ state: 'open' }),
      findChats: async () => ([{ remoteJid: '5519999990001@s.whatsapp.net' }]),
      findMessages: async () => ({ records: [{ key: { id: 'Z', fromMe: false, remoteJid: '5519999990001@s.whatsapp.net' }, message: { conversation: 'x' } }], pages: 1 }),
    },
    importarConversa: async (_t, { msgs }) => { importou += msgs.length; return { inseridos: msgs.length }; },
    withTenant: run,
  };
  const r = await waSync.syncReconnections(deps);
  assert.equal(r.reconexoes, 1);
  assert.ok(importou >= 1);
});

test('syncReconnections: estável em open (sem transição) e sync recente → não faz backfill', async () => {
  const estados = { t1: { last_state: 'open', last_sync_at: new Date() } };
  let tocouChats = false;
  const run = async (tenantId, cb) => cb({
    query: async (sql) => {
      if (/FROM wa_sync_state/i.test(sql)) return { rows: [estados[tenantId]] };
      return { rows: [], rowCount: 0 };
    },
  });
  const deps = {
    pool: { query: async () => ({ rows: [{ tenant_id: 't1' }] }) },
    credsForTenant: async () => ({ instance: 'i', apikey: 'k' }),
    evolution: { status: async () => ({ state: 'open' }), findChats: async () => { tocouChats = true; return []; }, findMessages: async () => ({ records: [] }) },
    importarConversa: async () => ({ inseridos: 0 }),
    withTenant: run,
  };
  const r = await waSync.syncReconnections(deps);
  assert.equal(r.reconexoes, 0);
  assert.equal(r.safety, 0);
  assert.equal(tocouChats, false);
});
