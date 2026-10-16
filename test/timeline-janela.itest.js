'use strict';
//
// timeline-janela.itest.js — PERCORRER A CONVERSA POR JANELAS DÁ EXATAMENTE A CONVERSA INTEIRA.
//
// Por que este teste existe: abrir uma conversa trazia a thread INTEIRA. Medido em produção em
// 16/10/2026, na maior conversa de Valinhos: 2.097 mensagens → **4.378 itens**, 816 ms de banco,
// 2,1 MB de JSON e **19,7 MB de HTML** (4,6 KB por mensagem). A recepção reclamou da lentidão ao
// trocar de conversa. A correção é a janela do WhatsApp Web: últimas N, mais ao rolar.
//
// O DEFEITO QUE ESTE TESTE IMPEDE não dá erro: paginação errada **perde mensagem em silêncio**, ou
// repete. Por isso o teste é de EQUIVALÊNCIA — a união das janelas tem de ser, item a item, a mesma
// coisa que a thread inteira.
//
// ⚠ Sobre ordem: a consulta inteira ordena só por `received_at`, então o empate entre itens do
// mesmo instante fica a cargo do plano do Postgres — NÃO é determinística. A janela desempata por
// `id` (as três fontes usam uuid). Na produção de Valinhos há ~30 instantes com mais de um item, e
// foi só aí que as duas listas divergiram — mesmo conjunto, mesma cronologia. O teste exige
// igualdade POR INSTANTE, não a sequência crua, porque exigir a sequência seria exigir que o
// Postgres repita um desempate que ele não promete.
//
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const tl = require('../src/timeline');

const T = '00000000-0000-4000-8000-00000000f1f1';
let c;

const ident = '19999887766';
const BASE = Date.parse('2026-10-01T12:00:00Z');

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE SCHEMA IF NOT EXISTS lead_manager;
    SET search_path = lead_manager, public;
    CREATE TABLE IF NOT EXISTS conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_id text,
      conversation_kind text, renovacao_draft boolean);
    CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, conversation_id uuid,
      role text, sender text, body text, received_at timestamptz, raw jsonb,
      reply_to_message_id uuid, external_message_id text, media_url text, media_type text,
      media_filename text, media_transcription text, edited_at timestamptz, deleted_at timestamptz);
    CREATE TABLE IF NOT EXISTS staff_outbound_samples (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_id text,
      sender text, body text, received_at timestamptz, source text, raw jsonb,
      reply_to_message_id uuid, external_message_id text, ack_status text, entregue_em timestamptz,
      lida_em timestamptz, edited_at timestamptz, deleted_at timestamptz, media_url text,
      media_type text, media_filename text, media_transcription text);
    CREATE TABLE IF NOT EXISTS pending_approvals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, status text,
      suggested_response text, created_at timestamptz, reply_to_message_id uuid);
  `);
  await c.query('DELETE FROM messages WHERE tenant_id = $1', [T]);
  await c.query('DELETE FROM staff_outbound_samples WHERE tenant_id = $1', [T]);

  // 120 entradas do cliente + 60 saídas da recepção, intercaladas no tempo.
  // DE PROPÓSITO: 6 pares no MESMO instante — é onde a paginação ingênua perde ou repete item.
  for (let i = 0; i < 120; i++) {
    const t = new Date(BASE + (i < 6 ? Math.floor(i / 2) : i) * 60000).toISOString();
    await c.query(`INSERT INTO messages (tenant_id, conversation_id, role, sender, body, received_at, raw)
      VALUES ($1, gen_random_uuid(), 'USER', 'Cliente', $2, $3, '{}'::jsonb)`, [T, 'entrada ' + i, t]);
  }
  for (let i = 0; i < 60; i++) {
    const t = new Date(BASE + (i * 2) * 60000).toISOString();
    await c.query(`INSERT INTO staff_outbound_samples (tenant_id, external_id, sender, body, received_at, source, raw)
      VALUES ($1, $2, 'Recepção', $3, $4, 'whatsapp', '{}'::jsonb)`, [T, ident, 'saida ' + i, t]);
  }
});

after(async () => {
  if (c) {
    await c.query('DELETE FROM messages WHERE tenant_id = $1', [T]).catch(() => {});
    await c.query('DELETE FROM staff_outbound_samples WHERE tenant_id = $1', [T]).catch(() => {});
    await c.end();
  }
});

const args = { tenantId: T, ident, leadId: null, ehGrupo: false };
const porInstante = (itens) => {
  const m = new Map();
  for (const x of itens) {
    const k = new Date(x.received_at).toISOString();
    m.set(k, [...(m.get(k) || []), String(x.id)].sort());
  }
  return m;
};
async function percorrer(limite) {
  const todos = []; let cur = null; let primeira = true; let voltas = 0;
  while ((primeira || cur) && voltas < 100) {
    const p = await tl.fetchJanela(c, { ...args, limite, antesDe: cur });
    todos.unshift(...p.itens); cur = p.cursor; primeira = false; voltas++;
    if (!p.itens.length) break;
  }
  return { todos, voltas };
}

test('(a) a janela devolve as ÚLTIMAS mensagens, não as primeiras', async () => {
  const inteira = await tl.fetchTimeline(c, args);
  const p = await tl.fetchJanela(c, { ...args, limite: 20 });
  assert.equal(p.itens.length, 20);
  assert.equal(p.temMais, true, 'com 180 itens e janela de 20, tem de haver história acima');
  const ultimoDaInteira = String(inteira[inteira.length - 1].id);
  const ultimoDaJanela = String(p.itens[p.itens.length - 1].id);
  assert.equal(ultimoDaJanela, ultimoDaInteira, 'a conversa abre no FIM, como o WhatsApp — não no começo');
});

test('(b) percorrer por janelas = a conversa inteira, sem perder nem repetir', async () => {
  const inteira = await tl.fetchTimeline(c, args);
  for (const limite of [7, 20, 50]) {          // tamanhos que NÃO dividem 180 exatamente
    const { todos } = await percorrer(limite);
    assert.equal(todos.length, inteira.length, `janela ${limite}: total diferente da thread inteira`);
    const ids = todos.map((x) => String(x.id));
    assert.equal(new Set(ids).size, ids.length, `janela ${limite}: item REPETIDO entre janelas`);
    const faltando = inteira.map((x) => String(x.id)).filter((x) => !new Set(ids).has(x));
    assert.deepEqual(faltando, [], `janela ${limite}: item PERDIDO entre janelas`);
  }
});

test('(c) mensagens no MESMO instante não se perdem na borda da janela', async () => {
  // o fixture tem 6 entradas em 3 instantes repetidos — o caso que quebra cursor só-por-data
  const inteira = await tl.fetchTimeline(c, args);
  const comEmpate = [...porInstante(inteira).values()].filter((v) => v.length > 1).length;
  assert.ok(comEmpate >= 3, `o fixture precisa ter instantes repetidos para o teste valer (tem ${comEmpate})`);
  for (const limite of [1, 2, 3]) {            // janela MENOR que o grupo de empate
    const { todos } = await percorrer(limite);
    assert.equal(todos.length, inteira.length, `janela ${limite}: perdeu item no empate de instante`);
  }
});

test('(d) a cronologia é a mesma — igualdade por instante, não sequência crua', async () => {
  const inteira = await tl.fetchTimeline(c, args);
  const { todos } = await percorrer(20);
  const A = porInstante(inteira), B = porInstante(todos);
  assert.equal(A.size, B.size);
  for (const [k, v] of A) assert.deepEqual(B.get(k), v, `instante ${k} com itens diferentes`);
  const ts = todos.map((x) => new Date(x.received_at).getTime());
  assert.ok(ts.every((v, i) => i === 0 || v >= ts[i - 1]), 'a janela tem de sair em ordem cronológica');
});

test('(e) o cursor acaba: no começo da conversa temMais é false e cursor é null', async () => {
  const { voltas } = await percorrer(50);
  assert.ok(voltas >= 4, `180 itens em janelas de 50 exigem ao menos 4 voltas (deu ${voltas})`);
  // a última janela já não tem história acima
  let cur = null; let ultima = null; let primeira = true;
  while (primeira || cur) { const p = await tl.fetchJanela(c, { ...args, limite: 50, antesDe: cur }); ultima = p; cur = p.cursor; primeira = false; }
  assert.equal(ultima.temMais, false);
  assert.equal(ultima.cursor, null, 'cursor null é o sinal de "chegou ao começo" — sem isso o scroll pede para sempre');
});

test('(f) sem limite, nada muda: a thread vem inteira (o que /leads/:id ainda usa)', async () => {
  const inteira = await tl.fetchTimeline(c, args);
  const semLimite = await tl.fetchJanela(c, { ...args, limite: 500 });
  assert.equal(semLimite.itens.length, inteira.length);
  assert.equal(semLimite.temMais, false);
});
