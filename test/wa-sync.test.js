'use strict';
//
// RECONEXÃO — backfill do histórico do WhatsApp (waSync). Testes de UNIDADE, sem DB: helpers puros
// + orquestração de backfillTenant/syncReconnections com deps mockadas (evolution, credsForTenant,
// withTenant, importarConversa).
//
const { test } = require('node:test');
const assert = require('node:assert');
const waSync = require('../src/waSync');
const { mapEvolutionMsg } = require('../src/importHistorico');

// ── helpers puros ──────────────────────────────────────────────────────────────────
test('_remoteJid: telefone cru vira jid; +55 e sujeira são normalizados', () => {
  assert.equal(waSync._remoteJid('5519999990000'), '5519999990000@s.whatsapp.net');
  assert.equal(waSync._remoteJid('+55 (19) 99999-0000'), '5519999990000@s.whatsapp.net');
});
test('_remoteJid: grupo (@g.us) e vazio ficam de fora (null)', () => {
  assert.equal(waSync._remoteJid('12036@g.us'), null);
  assert.equal(waSync._remoteJid(''), null);
  assert.equal(waSync._remoteJid(null), null);
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
// withTenant fake: roteia pela SQL. conversations -> lista dada; wa_sync_state -> vazio; resto ok.
function fakeWithTenant(convs) {
  return async (_tenantId, cb) => cb({
    query: async (sql) => {
      if (/FROM conversations/i.test(sql)) return { rows: convs };
      return { rows: [], rowCount: 0 };
    },
  });
}

test('backfillTenant: instância open → puxa e mescla cada conversa', async () => {
  const convs = [{ id: 'c1', external_id: '5519999990001' }, { id: 'c2', external_id: '5519999990002' }];
  const chamadasImport = [];
  const deps = {
    credsForTenant: async () => ({ instance: 'inst', apikey: 'k' }),
    evolution: {
      status: async () => ({ state: 'open' }),
      findMessages: async () => ({ records: [{ key: { id: 'X', fromMe: true }, message: { conversation: 'resposta da recepção' } }], pages: 1 }),
    },
    importarConversa: async (_t, { externalId, msgs }) => { chamadasImport.push({ externalId, n: msgs.length }); return { inseridos: msgs.length, pulados: 0 }; },
    withTenant: fakeWithTenant(convs),
  };
  const out = await waSync.backfillTenant('t1', { deep: true }, deps);
  assert.equal(out.conversas, 2);
  assert.equal(out.inseridos, 2);
  assert.equal(chamadasImport.length, 2);
  assert.deepEqual(chamadasImport.map((x) => x.externalId).sort(), ['5519999990001', '5519999990002']);
});

test('backfillConversa: pagina o histórico INTEIRO (não só a 1ª página)', async () => {
  // 3 páginas: pages=3 nas duas primeiras; a última completa o total. Deve chamar findMessages 3×.
  const paginas = {
    1: { records: [{ key: { id: 'A' }, message: { conversation: 'p1' } }], pages: 3 },
    2: { records: [{ key: { id: 'B' }, message: { conversation: 'p2' } }], pages: 3 },
    3: { records: [{ key: { id: 'C' }, message: { conversation: 'p3' } }], pages: 3 },
  };
  const paginasPedidas = [];
  const deps = {
    evolution: { findMessages: async (_c, _jid, { page }) => { paginasPedidas.push(page); return paginas[page] || { records: [], pages: 3 }; } },
    importarConversa: async (_t, { msgs }) => ({ inseridos: msgs.length, pulados: 0 }),
    withTenant: fakeWithTenant([]),
  };
  const r = await waSync.backfillConversa('t1', { instance: 'i', apikey: 'k' }, { id: 'c1', external_id: '5519999990001' }, deps);
  assert.deepEqual(paginasPedidas, [1, 2, 3]);
  assert.equal(r.inseridos, 3);
  assert.equal(r.paginas, 3);
});

test('backfillConversa: para quando a página vem incompleta (sem metadados de pages)', async () => {
  // pageSize default 200; a 1ª página traz 2 registros (< 200) → era a última, para em 1 chamada.
  let chamadas = 0;
  const deps = {
    evolution: { findMessages: async () => { chamadas++; return { records: [{ key: { id: 'A' }, message: { conversation: 'a' } }, { key: { id: 'B' }, message: { conversation: 'b' } }], pages: null }; } },
    importarConversa: async (_t, { msgs }) => ({ inseridos: msgs.length, pulados: 0 }),
    withTenant: fakeWithTenant([]),
  };
  const r = await waSync.backfillConversa('t1', { instance: 'i', apikey: 'k' }, { id: 'c1', external_id: '5519999990001' }, deps);
  assert.equal(chamadas, 1);
  assert.equal(r.inseridos, 2);
});

test('backfillTenant: instância NÃO-open → skip sem tocar em conversas', async () => {
  let chamou = false;
  const deps = {
    credsForTenant: async () => ({ instance: 'inst', apikey: 'k' }),
    evolution: { status: async () => ({ state: 'connecting' }), findMessages: async () => { chamou = true; return { records: [] }; } },
    importarConversa: async () => { chamou = true; return { inseridos: 0 }; },
    withTenant: fakeWithTenant([]),
  };
  const out = await waSync.backfillTenant('t1', { deep: true }, deps);
  assert.equal(out.skipped, 'nao_open');
  assert.equal(out.state, 'connecting');
  assert.equal(chamou, false);
});

test('backfillTenant: sem credencial Evolution → skip', async () => {
  const deps = { credsForTenant: async () => ({ instance: null, apikey: null }), withTenant: fakeWithTenant([]) };
  const out = await waSync.backfillTenant('t1', {}, deps);
  assert.equal(out.skipped, 'sem_evolution');
});

// syncReconnections: só a transição NÃO-open → open dispara o backfill profundo.
test('syncReconnections: reconexão (close→open) dispara backfill', async () => {
  const estados = { t1: { last_state: 'close', last_sync_at: new Date() } };
  const run = async (tenantId, cb) => cb({
    query: async (sql, params) => {
      if (/FROM wa_sync_state/i.test(sql)) return { rows: estados[tenantId] ? [estados[tenantId]] : [] };
      if (/INSERT INTO wa_sync_state/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/FROM conversations/i.test(sql)) return { rows: [{ id: 'c1', external_id: '5519999990001' }] };
      return { rows: [], rowCount: 0 };
    },
  });
  let importou = 0;
  const deps = {
    pool: { query: async () => ({ rows: [{ tenant_id: 't1' }] }) },
    credsForTenant: async () => ({ instance: 'i', apikey: 'k' }),
    evolution: { status: async () => ({ state: 'open' }), findMessages: async () => ({ records: [{ key: { id: 'Z' }, message: { conversation: 'x' } }], pages: 1 }) },
    importarConversa: async (_t, { msgs }) => { importou += msgs.length; return { inseridos: msgs.length }; },
    withTenant: run,
  };
  const r = await waSync.syncReconnections(deps);
  assert.equal(r.reconexoes, 1);
  assert.ok(importou >= 1);
});

test('syncReconnections: estável em open (sem transição) e sync recente → não faz backfill', async () => {
  const estados = { t1: { last_state: 'open', last_sync_at: new Date() } };
  let tocou = false;
  const run = async (tenantId, cb) => cb({
    query: async (sql) => {
      if (/FROM wa_sync_state/i.test(sql)) return { rows: [estados[tenantId]] };
      if (/FROM conversations/i.test(sql)) { tocou = true; return { rows: [] }; }
      return { rows: [], rowCount: 0 };
    },
  });
  const deps = {
    pool: { query: async () => ({ rows: [{ tenant_id: 't1' }] }) },
    credsForTenant: async () => ({ instance: 'i', apikey: 'k' }),
    evolution: { status: async () => ({ state: 'open' }), findMessages: async () => ({ records: [] }) },
    importarConversa: async () => ({ inseridos: 0 }),
    withTenant: run,
  };
  const r = await waSync.syncReconnections(deps);
  assert.equal(r.reconexoes, 0);
  assert.equal(r.safety, 0);
  assert.equal(tocou, false);
});
