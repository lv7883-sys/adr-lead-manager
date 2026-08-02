'use strict';
// inbox.itest.js — ADR-042 / E12-03: listagem unificada do inbox (conversation-centric).
// Cobre: (1) projeção is_lead (gate) + is_lead_ativo (régua ADR-041, SQL≡JS com lifecycle.js)
// + fonte (origem|channel) nos 5 estados de lead; (2) não-lidas + marcar-lido (migr. 080);
// (3) last_activity_at = max(inbound ∪ outbound) e ordenação; (4) filtros view/fonte/q;
// (5) keyset pagination sem sobreposição; (6) isolamento multi-tenant.
//
// Conecta como postgres (sem RLS) e monta um schema MÍNIMO — mesmo padrão dos demais itests.
// A query real vem de src/routes/inbox.js (fonte única); o teste só semeia e asserta.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const inbox = require('../src/routes/inbox');
const { isStatusVivo, isTerminal } = require('../src/lifecycle');

let c;
const T1 = '00000000-0000-0000-0000-0000000000e1';
const T2 = '00000000-0000-0000-0000-0000000000e2';

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text,
      external_id text, conversation_kind text DEFAULT 'DIRECT', updated_at timestamptz DEFAULT now(), last_read_at timestamptz);
    CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, role text,
      body text, media_type text, edited_at timestamptz, deleted_at timestamptz,
      received_at timestamptz DEFAULT now());
    CREATE TABLE staff_outbound_samples (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_id text,
      body text, media_type text, edited_at timestamptz, deleted_at timestamptz,
      received_at timestamptz DEFAULT now(), raw jsonb);
    CREATE TABLE leads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, phone text,
      meta_psid text, status text, desfecho text, origem text, created_at timestamptz DEFAULT now());
    CREATE TABLE tenant_lead_config (tenant_id uuid PRIMARY KEY, dormancy_days int DEFAULT 7);
    -- Canônico (ADR-049): contrato ↔ pessoa ↔ telefone. Schema mínimo — só as colunas que a
    -- view=renovacoes lê (sem FKs, como os demais itests).
    CREATE TABLE service_account (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid,
      fim_vigencia date, fonte_ausente_em timestamptz);
    CREATE TABLE account_member (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid,
      account_id uuid, person_id uuid, bond text);
    CREATE TABLE contact_point (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid,
      person_id uuid, kind text, value_raw text);
  `);
});
after(async () => { await c.end(); });

// ---- helpers de seed --------------------------------------------------------
const H = (n) => `+5519${String(n).padStart(9, '0')}`;      // telefone externo (conversa)
const D = (n) => `5519${String(n).padStart(9, '0')}`;        // só dígitos (lead/saída)

async function cfg(tenant, dormancy = 7) {
  await c.query(`INSERT INTO tenant_lead_config (tenant_id, dormancy_days) VALUES ($1,$2)
                 ON CONFLICT (tenant_id) DO UPDATE SET dormancy_days = EXCLUDED.dormancy_days`, [tenant, dormancy]);
}
async function conv(tenant, extId, over = {}) {
  return (await c.query(
    `INSERT INTO conversations (tenant_id, channel, external_id, last_read_at, updated_at)
     VALUES ($1,$2,$3,$4, now()) RETURNING id`,
    [tenant, over.channel || 'whatsapp', extId, over.last_read_at || null])).rows[0].id;
}
async function msg(convId, over = {}) {
  return (await c.query(
    `INSERT INTO messages (conversation_id, role, body, media_type, edited_at, deleted_at, received_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() - make_interval(days => $7)) RETURNING id`,
    [convId, over.role || 'USER', over.body ?? 'oi', over.media_type || null,
     over.edited_at || null, over.deleted_at || null, over.diasAtras || 0])).rows[0].id;
}
async function outbound(tenant, extDigits, over = {}) {
  return (await c.query(
    `INSERT INTO staff_outbound_samples (tenant_id, external_id, body, media_type, received_at, raw)
     VALUES ($1,$2,$3,$4, now() - make_interval(days => $5), $6) RETURNING id`,
    [tenant, extDigits, over.body ?? 'resposta', over.media_type || null,
     over.diasAtras || 0, over.raw || null])).rows[0].id;
}
async function lead(tenant, over = {}) {
  return (await c.query(
    `INSERT INTO leads (tenant_id, name, phone, meta_psid, status, desfecho, origem)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [tenant, over.name || null, over.phone || null, over.meta_psid || null,
     over.status || 'QUALIFYING', over.desfecho || null, over.origem || null])).rows[0].id;
}

// Semeia um contrato (service_account) ligado a um telefone via person→contact_point→account_member.
// `diasAteVencer`: >0 = vence no futuro; <0 = já venceu. Sem person real (sem FK) — uuid solto.
async function contrato(tenant, phoneRaw, diasAteVencer, over = {}) {
  const pid = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id;
  const said = (await c.query(
    `INSERT INTO service_account (tenant_id, fim_vigencia, fonte_ausente_em)
     VALUES ($1, (current_date + make_interval(days => $2))::date, $3) RETURNING id`,
    [tenant, diasAteVencer, over.fonte_ausente_em || null])).rows[0].id;
  await c.query(`INSERT INTO account_member (tenant_id, account_id, person_id, bond)
                 VALUES ($1,$2,$3,$4)`, [tenant, said, pid, over.bond || 'beneficiario']);
  await c.query(`INSERT INTO contact_point (tenant_id, person_id, kind, value_raw)
                 VALUES ($1,$2,'phone',$3)`, [tenant, pid, phoneRaw]);
  return said;
}

const list = (tenant, opts = {}) => inbox.listConversations(c, tenant, opts);
const byExt = (items, extId) => items.find((i) => i.external_id === extId);

// =============================================================================
test('(1) projeção is_lead / is_lead_ativo / fonte nos 5 estados', async () => {
  await cfg(T1, 7);

  // a) não-lead: conversa sem lead casável
  const cNao = await conv(T1, H(1)); await msg(cNao, { diasAtras: 0 });
  // b) lead ativo (QUALIFYING, atividade recente)
  const cAtivo = await conv(T1, H(2)); await msg(cAtivo, { diasAtras: 0 });
  await lead(T1, { phone: D(2), status: 'QUALIFYING', origem: 'instagram_dm', name: 'Ana' });
  // c) lead dormente (atividade 10d atrás > dormancy 7)
  const cDorm = await conv(T1, H(3)); await msg(cDorm, { diasAtras: 10 });
  await lead(T1, { phone: D(3), status: 'QUALIFYING' });
  // d) lead terminal (desfecho preenchido)
  const cTerm = await conv(T1, H(4)); await msg(cTerm, { diasAtras: 0 });
  await lead(T1, { phone: D(4), status: 'QUALIFYING', desfecho: 'perdido' });
  // e) NOT_LEAD (gate)
  const cNotLead = await conv(T1, H(5)); await msg(cNotLead, { diasAtras: 0 });
  await lead(T1, { phone: D(5), status: 'NOT_LEAD' });

  const { items } = await list(T1, { limit: 50 });

  const nao = byExt(items, H(1));
  assert.equal(nao.is_lead, false);
  assert.equal(nao.is_lead_ativo, null);
  assert.equal(nao.fonte, 'whatsapp', 'não-lead usa o channel como fonte');

  const ativo = byExt(items, H(2));
  assert.equal(ativo.is_lead, true);
  assert.equal(ativo.is_lead_ativo, true);
  assert.equal(ativo.fonte, 'instagram_dm', 'lead usa a origem imutável como fonte');
  assert.equal(ativo.contato.nome, 'Ana');

  assert.equal(byExt(items, H(3)).is_lead_ativo, false, 'dormente não é ativo');
  assert.equal(byExt(items, H(4)).is_lead_ativo, false, 'terminal não é ativo');
  assert.equal(byExt(items, H(4)).is_lead, true, 'terminal ainda é lead (gate)');

  const notLead = byExt(items, H(5));
  assert.equal(notLead.is_lead, false, 'NOT_LEAD sai do pill LEAD');
  assert.equal(notLead.is_lead_ativo, null);
});

test('(2) SQL≡JS: is_lead_ativo do endpoint == predicado JS do lifecycle.js', async () => {
  await cfg(T2, 7);
  const estados = [
    { status: 'NEW', desfecho: null, dias: 0 },
    { status: 'QUALIFIED', desfecho: null, dias: 0 },
    { status: 'QUALIFYING', desfecho: null, dias: 30 },   // dormente
    { status: 'CONVERTED', desfecho: null, dias: 0 },     // terminal por status
    { status: 'QUALIFYING', desfecho: 'matriculado', dias: 0 }, // terminal por desfecho
    { status: 'EXPERIMENTAL_AGENDADA', desfecho: null, dias: 1 },
  ];
  let n = 100;
  for (const e of estados) {
    const cv = await conv(T2, H(n)); await msg(cv, { diasAtras: e.dias });
    await lead(T2, { phone: D(n), status: e.status, desfecho: e.desfecho });
    n++;
  }
  const { items } = await list(T2, { limit: 50 });
  n = 100;
  for (const e of estados) {
    const item = byExt(items, H(n));
    const naoDormente = e.dias <= 7;
    const jsAtivo = isStatusVivo(e) && !isTerminal(e) && naoDormente;
    assert.equal(item.is_lead_ativo, jsAtivo, `estado ${JSON.stringify(e)}: SQL≡JS`);
    n++;
  }
});

test('(3) last_activity_at inclui outbound e ordena por atividade real', async () => {
  const tenant = '00000000-0000-0000-0000-0000000000e3'; await cfg(tenant, 7);
  // conversa cujo último toque é uma SAÍDA da recepção (não um inbound)
  const cv = await conv(tenant, H(200));
  await msg(cv, { diasAtras: 5, body: 'inbound antigo' });
  await outbound(tenant, D(200), { diasAtras: 0, body: 'resposta recente' });
  const { items } = await list(tenant, { limit: 50 });
  const it = byExt(items, H(200));
  assert.equal(it.ultima_mensagem.kind, 'recepcao', 'última mensagem é a saída');
  assert.equal(it.ultima_mensagem.preview, 'resposta recente');
});

test('(4) não-lidas + marcar-lido (migr. 080, compartilhado por tenant)', async () => {
  const tenant = '00000000-0000-0000-0000-0000000000e4'; await cfg(tenant, 7);
  const cv = await conv(tenant, H(300));           // last_read_at NULL => tudo não-lido
  await msg(cv, { diasAtras: 2 }); await msg(cv, { diasAtras: 1 }); await msg(cv, { diasAtras: 0 });
  let it = byExt((await list(tenant, { limit: 50 })).items, H(300));
  assert.equal(it.nao_lidas, 3, 'sem cursor, todas as inbound contam');

  const r = await inbox.markRead(c, tenant, cv, null);
  assert.equal(r.nao_lidas, 0);
  it = byExt((await list(tenant, { limit: 50 })).items, H(300));
  assert.equal(it.nao_lidas, 0, 'após marcar-lido, zera');

  // tenant errado não mexe na conversa
  assert.equal(await inbox.markRead(c, T1, cv, null), null);

  // marcar como NÃO-LIDA: recua o cursor -> volta a contar (>=1); tenant errado -> null
  const u = await inbox.markUnread(c, tenant, cv);
  assert.equal(u.ok, true); assert.ok(u.nao_lidas >= 1, 'marcar não-lido volta a contar');
  it = byExt((await list(tenant, { limit: 50 })).items, H(300));
  assert.ok(it.nao_lidas >= 1, 'lista reflete não-lida');
  assert.equal(await inbox.markUnread(c, T1, cv), null);
});

test('(5) filtros view / fonte / q', async () => {
  const tenant = '00000000-0000-0000-0000-0000000000e5'; await cfg(tenant, 7);
  const cLead = await conv(tenant, H(400)); await msg(cLead);
  await lead(tenant, { phone: D(400), status: 'QUALIFYING', origem: 'whatsapp', name: 'Bruno Lima' });
  const cNao = await conv(tenant, H(401)); await msg(cNao);   // não-lead

  const leads = (await list(tenant, { view: 'leads', limit: 50 })).items;
  assert.ok(leads.every((i) => i.is_lead === true) && byExt(leads, H(400)));
  const naoLead = (await list(tenant, { view: 'nao_lead', limit: 50 })).items;
  assert.ok(naoLead.every((i) => i.is_lead === false) && byExt(naoLead, H(401)));

  assert.ok(byExt((await list(tenant, { q: 'Bruno', limit: 50 })).items, H(400)), 'busca por nome');
  assert.ok(byExt((await list(tenant, { q: '19000000400', limit: 50 })).items, H(400)), 'busca por dígitos');
  assert.ok(byExt((await list(tenant, { fonte: 'whatsapp', limit: 50 })).items, H(400)), 'filtro fonte');
});

test('(6) keyset pagination sem sobreposição', async () => {
  const tenant = '00000000-0000-0000-0000-0000000000e6'; await cfg(tenant, 7);
  for (let i = 0; i < 5; i++) { const cv = await conv(tenant, H(500 + i)); await msg(cv, { diasAtras: i }); }
  const p1 = await list(tenant, { limit: 2 });
  assert.equal(p1.items.length, 2);
  assert.ok(p1.next_cursor, 'há próxima página');
  const p2 = await list(tenant, { limit: 2, cursor: inbox.decodeCursor(p1.next_cursor) });
  const ids1 = new Set(p1.items.map((i) => i.conversation_id));
  assert.ok(p2.items.every((i) => !ids1.has(i.conversation_id)), 'página 2 não repete a 1');
});

test('(8) view=renovacoes: janela + rastro de vencidos + saída automática (ADR-049)', async () => {
  const tenant = '00000000-0000-0000-0000-0000000000e9'; await cfg(tenant, 7);
  // a) vence em 15d -> ENTRA
  const cDentro = await conv(tenant, H(700)); await msg(cDentro); await contrato(tenant, D(700), 15);
  // b) vence em 200d (longe) -> FORA (> hoje+90d)
  const cLonge = await conv(tenant, H(701)); await msg(cLonge); await contrato(tenant, D(701), 200);
  // c) venceu há 10d (rastro recuperável) -> ENTRA
  const cVenc = await conv(tenant, H(702)); await msg(cVenc); await contrato(tenant, D(702), -10);
  // d) venceu há 60d -> FORA (< hoje-30d)
  const cVelho = await conv(tenant, H(703)); await msg(cVelho); await contrato(tenant, D(703), -60);
  // e) sem contrato -> FORA
  const cSem = await conv(tenant, H(704)); await msg(cSem);
  // f) RENOVOU: contrato vencia em 5d, mas há um novo +300d -> MAX(fim_vigencia) vai pra frente -> SAI
  const cRenov = await conv(tenant, H(705)); await msg(cRenov);
  await contrato(tenant, D(705), 5); await contrato(tenant, D(705), 300);
  // g) contrato AUSENTE da fonte (soft-delete) -> ignorado
  const cAus = await conv(tenant, H(706)); await msg(cAus);
  await contrato(tenant, D(706), 10, { fonte_ausente_em: new Date() });

  const { items } = await list(tenant, { view: 'renovacoes', limit: 50 });
  const ext = (n) => byExt(items, H(n));

  assert.ok(ext(700), 'vence em 15d entra');
  assert.equal(ext(700).renovacao.dias, 15, 'dias até vencer = 15');
  assert.ok(!ext(701), 'vence em 200d fica fora (>90d)');
  assert.ok(ext(702), 'vencido há 10d entra (rastro)');
  assert.equal(ext(702).renovacao.dias, -10, 'dias negativo p/ vencido');
  assert.ok(!ext(703), 'vencido há 60d fica fora (<-30d)');
  assert.ok(!ext(704), 'sem contrato fica fora');
  assert.ok(!ext(705), 'renovou (novo contrato +300d) sai sozinho — saída automática');
  assert.ok(!ext(706), 'contrato ausente da fonte é ignorado');

  // ordenado por atividade, e a etiqueta (renovacao) aparece TAMBÉM na visão geral p/ rotular
  const todas = (await list(tenant, { view: 'todas', limit: 50 })).items;
  assert.ok(byExt(todas, H(700)).renovacao, 'renovacao presente na visão todas (etiqueta)');
  assert.equal(byExt(todas, H(704)).renovacao, null, 'sem contrato => renovacao null');
});

test('(7) isolamento multi-tenant', async () => {
  const tA = '00000000-0000-0000-0000-0000000000e7'; const tB = '00000000-0000-0000-0000-0000000000e8';
  await cfg(tA, 7); await cfg(tB, 7);
  const cvA = await conv(tA, H(600)); await msg(cvA);
  const cvB = await conv(tB, H(601)); await msg(cvB);
  const itemsA = (await list(tA, { limit: 50 })).items;
  assert.ok(byExt(itemsA, H(600)) && !byExt(itemsA, H(601)), 'tenant A não vê conversa de B');
});
