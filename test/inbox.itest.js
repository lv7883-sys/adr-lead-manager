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
      external_id text, conversation_kind text DEFAULT 'DIRECT', updated_at timestamptz DEFAULT now(), last_read_at timestamptz,
      renovacao_draft boolean DEFAULT false,   -- migr. 097 (Fase B)
      UNIQUE (tenant_id, channel, external_id));   -- prod tem (engine.js/ensureConversation dependem)
    CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, role text,
      body text, media_type text, edited_at timestamptz, deleted_at timestamptz,
      sender text, received_at timestamptz DEFAULT now());
    CREATE TABLE staff_outbound_samples (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_id text,
      body text, media_type text, edited_at timestamptz, deleted_at timestamptz,
      received_at timestamptz DEFAULT now(), raw jsonb,
      is_group boolean NOT NULL DEFAULT false);   -- migr. 103: filtro de grupo materializado
    CREATE TABLE leads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, phone text,
      meta_psid text, status text, desfecho text, origem text, aborda_renovacao boolean,
      created_at timestamptz DEFAULT now());
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
    CREATE TABLE person (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, display_name text);
    -- Fila de toques da Janis (migr. 092) — a projeção do inbox marca renovacao.toque a partir daqui.
    CREATE TABLE renovacao_touchpoint (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid,
      phone text, marco text, status text DEFAULT 'pendente');
    -- Contatos internos (equipe/dono, ADR-018) — excluídos da aba Renovações.
    CREATE TABLE internal_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, phone text, name text, type text);
    -- Renovação resolvida pela recepção (migr. 095) — retira da aba (amarrada ao venc do ciclo).
    CREATE TABLE renovacao_dismiss (
      tenant_id uuid, br_key text, venc date, situacao text, por text, em timestamptz DEFAULT now(),
      PRIMARY KEY (tenant_id, br_key));
    -- Espelho da migr. 085 (a query usa br_phone_key sem schema; aqui vive em public).
    CREATE OR REPLACE FUNCTION br_phone_key(x text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
      WITH d AS (SELECT regexp_replace(coalesce(x, ''), '[^0-9]', '', 'g') AS v),
           loc AS (SELECT CASE WHEN length(v) IN (12,13) AND left(v,2)='55' THEN substr(v,3) ELSE v END AS v FROM d)
      SELECT CASE WHEN length(v)=11 AND substr(v,3,1)='9' THEN left(v,2)||substr(v,4) ELSE v END FROM loc
    $fn$;
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
    `INSERT INTO messages (conversation_id, role, body, media_type, edited_at, deleted_at, sender, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$8, now() - make_interval(days => $7)) RETURNING id`,
    [convId, over.role || 'USER', over.body ?? 'oi', over.media_type || null,
     over.edited_at || null, over.deleted_at || null, over.diasAtras || 0, over.sender || null])).rows[0].id;
}
// Cadastro canônico: uma pessoa com nome + telefone (contact_point). Casa por br_phone_key.
async function pessoaNome(tenant, phoneRaw, nome) {
  const pid = (await c.query(`INSERT INTO person (tenant_id, display_name) VALUES ($1,$2) RETURNING id`, [tenant, nome])).rows[0].id;
  const local = String(phoneRaw).replace(/\D/g, '').replace(/^55/, '');
  await c.query(`INSERT INTO contact_point (tenant_id, person_id, kind, value_raw) VALUES ($1,$2,'phone',$3)`,
    [tenant, pid, `((${local.slice(0, 2)}))${local.slice(2)}`]);
  return pid;
}
async function outbound(tenant, extDigits, over = {}) {
  return (await c.query(
    `INSERT INTO staff_outbound_samples (tenant_id, external_id, body, media_type, received_at, raw, is_group)
     VALUES ($1,$2,$3,$4, now() - make_interval(days => $5), $6, $7) RETURNING id`,
    [tenant, extDigits, over.body ?? 'resposta', over.media_type || null,
     over.diasAtras || 0, over.raw || null, over.is_group === true])).rows[0].id;
}
async function lead(tenant, over = {}) {
  return (await c.query(
    `INSERT INTO leads (tenant_id, name, phone, meta_psid, status, desfecho, origem, aborda_renovacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [tenant, over.name || null, over.phone || null, over.meta_psid || null,
     over.status || 'QUALIFYING', over.desfecho || null, over.origem || null,
     over.aborda_renovacao === true ? true : null])).rows[0].id;
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
  // value_raw no formato REAL da Extranet: SEM o DDI 55 e COM pontuação — força a query a
  // normalizar (br_phone_key) p/ casar com o external_id da conversa (que vem COM 55).
  const localDig = String(phoneRaw).replace(/\D/g, '').replace(/^55/, '');
  const valueRaw = over.valueRaw || `((${localDig.slice(0, 2)}))${localDig.slice(2)}`;
  await c.query(`INSERT INTO contact_point (tenant_id, person_id, kind, value_raw)
                 VALUES ($1,$2,'phone',$3)`, [tenant, pid, valueRaw]);
  return said;
}

// Toque da Janis (migr. 092) ligado a um telefone. value_raw no formato da Extranet (força br_phone_key).
async function touchpoint(tenant, phoneRaw, marco = 'D-10', over = {}) {
  const localDig = String(phoneRaw).replace(/\D/g, '').replace(/^55/, '');
  const valueRaw = over.valueRaw || `((${localDig.slice(0, 2)}))${localDig.slice(2)}`;
  await c.query(`INSERT INTO renovacao_touchpoint (tenant_id, phone, marco, status) VALUES ($1,$2,$3,$4)`,
    [tenant, valueRaw, marco, over.status || 'pendente']);
}

// Contato interno (equipe/dono) — casa por dígitos.
async function interno(tenant, phoneRaw) {
  await c.query(`INSERT INTO internal_contacts (tenant_id, phone, name, type) VALUES ($1,$2,'Interno','gestor')`,
    [tenant, phoneRaw]);
}
// Recepção resolveu a renovação (dismiss) — venc = current_date + vencDias (amarra ao ciclo).
async function dismiss(tenant, phoneRaw, vencDias) {
  await c.query(
    `INSERT INTO renovacao_dismiss (tenant_id, br_key, venc, situacao)
     VALUES ($1, br_phone_key($2), (current_date + make_interval(days => $3))::date, 'nao_renovou')`,
    [tenant, phoneRaw, vencDias]);
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

  // migr. 103: uma saída de GRUPO (is_group) MAIS RECENTE não pode virar a última atividade 1:1.
  await outbound(tenant, D(200), { diasAtras: -1, body: 'msg de grupo', is_group: true });
  const it2 = byExt((await list(tenant, { limit: 50 })).items, H(200));
  assert.equal(it2.ultima_mensagem.preview, 'resposta recente', 'saída de grupo é ignorada na lista');
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
  assert.ok(!byExt((await list(tenant, { q: 'Bruno', limit: 50 })).items, H(401)), 'busca por nome EXCLUI quem não casa (não é %%)');
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

test('(8) view=renovacoes: janela APERTADA [hoje-60d, hoje+15d] + saída automática (ADR-049 rev.)', async () => {
  const tenant = '00000000-0000-0000-0000-0000000000e9'; await cfg(tenant, 7);
  // a) vence em 15d -> ENTRA (borda de cima)
  const cDentro = await conv(tenant, H(700)); await msg(cDentro); await contrato(tenant, D(700), 15);
  // b) vence em 40d -> FORA (cedo demais: fora da janela apertada) — MUDANÇA vs. ADR-049 original
  const cCedo = await conv(tenant, H(701)); await msg(cCedo); await contrato(tenant, D(701), 40);
  // c) venceu há 20d (recuperável) -> ENTRA
  const cVenc = await conv(tenant, H(702)); await msg(cVenc); await contrato(tenant, D(702), -20);
  // d) venceu há 80d -> FORA (< hoje-60d)
  const cVelho = await conv(tenant, H(703)); await msg(cVelho); await contrato(tenant, D(703), -80);
  // e) sem contrato e sem contexto -> FORA
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
  assert.ok(!ext(701), 'vence em 40d fica fora (cedo demais)');
  assert.ok(ext(702), 'vencido há 20d entra');
  assert.equal(ext(702).renovacao.dias, -20, 'dias negativo p/ vencido');
  assert.ok(!ext(703), 'vencido há 80d fica fora (<-60d)');
  assert.ok(!ext(704), 'sem contrato e sem contexto fica fora');
  assert.ok(!ext(705), 'renovou (novo contrato +300d) sai sozinho — saída automática');
  assert.ok(!ext(706), 'contrato ausente da fonte é ignorado');

  // a etiqueta (renovacao) segue aparecendo na visão TODAS p/ rotular (janela do renov não muda)
  const todas = (await list(tenant, { view: 'todas', limit: 50 })).items;
  assert.ok(byExt(todas, H(700)).renovacao, 'renovacao presente na visão todas (etiqueta)');
  assert.equal(byExt(todas, H(704)).renovacao, null, 'sem contrato => renovacao null');
});

test('(8d) view=renovacoes: CONTEXTO puxa a conversa independente do vencimento (toque OU tema-IA)', async () => {
  const tenant = '00000000-0000-0000-0000-0000000000ed'; await cfg(tenant, 7);
  // p1) vence em 40d (fora da janela) MAS tem toque enviado -> ENTRA (contexto)
  const c1 = await conv(tenant, H(730)); await msg(c1); await contrato(tenant, D(730), 40);
  await touchpoint(tenant, D(730), 'D-10', { status: 'enviado' });
  // p2) vence em 40d MAS a IA marcou o TEMA renovação (leads.aborda_renovacao) -> ENTRA (contexto)
  const c2 = await conv(tenant, H(731)); await msg(c2); await contrato(tenant, D(731), 40);
  await lead(tenant, { phone: D(731), status: 'NOT_LEAD', aborda_renovacao: true });
  // p3) vence em 40d e NADA (sem toque, IA não marcou) -> FORA
  const c3 = await conv(tenant, H(732)); await msg(c3); await contrato(tenant, D(732), 40);
  await lead(tenant, { phone: D(732), status: 'NOT_LEAD' });   // aborda_renovacao = null
  // p4) SEM contrato, mas com toque pendente -> ENTRA (contexto, sem vencimento)
  const c4 = await conv(tenant, H(733)); await msg(c4); await touchpoint(tenant, D(733), 'D-2', { status: 'pendente' });

  const { items } = await list(tenant, { view: 'renovacoes', limit: 50 });
  const ext = (n) => byExt(items, H(n));
  assert.ok(ext(730), 'D-40 com toque enviado entra (contexto)');
  assert.ok(ext(731), 'D-40 com tema-IA (aborda_renovacao) entra (contexto)');
  assert.ok(!ext(732), 'D-40 sem contexto (IA não marcou) fica fora');
  assert.ok(ext(733), 'sem contrato mas com toque pendente entra (contexto)');
});

test('(8b) renovacao.toque: marca a conversa com toque pendente da Janis (D-2 > D-10; sumido quando não-pendente)', async () => {
  const tenant = '00000000-0000-0000-0000-0000000000eb'; await cfg(tenant, 7);
  // a) contrato + toque D-10 pendente → renovacao.toque = 'D-10'
  const cA = await conv(tenant, H(720)); await msg(cA); await contrato(tenant, D(720), 10);
  await touchpoint(tenant, D(720), 'D-10');
  // b) mesma pessoa com D-10 e D-2 pendentes → prefere D-2
  const cB = await conv(tenant, H(721)); await msg(cB); await contrato(tenant, D(721), 2);
  await touchpoint(tenant, D(721), 'D-10'); await touchpoint(tenant, D(721), 'D-2');
  // c) toque já enviado (não-pendente) → sem toque
  const cC = await conv(tenant, H(722)); await msg(cC); await contrato(tenant, D(722), 8);
  await touchpoint(tenant, D(722), 'D-10', { status: 'enviado' });
  // d) contrato sem toque → toque null
  const cD = await conv(tenant, H(723)); await msg(cD); await contrato(tenant, D(723), 40);

  const { items } = await list(tenant, { view: 'todas', limit: 50 });
  const ext = (n) => byExt(items, H(n));
  assert.equal(ext(720).renovacao.toque, 'D-10', 'toque pendente marca a conversa');
  assert.equal(ext(721).renovacao.toque, 'D-2', 'com D-10 e D-2, prefere o D-2');
  assert.equal(ext(722).renovacao.toque, null, 'toque enviado não marca');
  assert.equal(ext(723).renovacao.toque, null, 'contrato sem toque → toque null');
});

test('(8c) ensureConversation (outbound-first): cria e REUSA por br_phone_key', async () => {
  const tenant = '00000000-0000-0000-0000-0000000000ec'; await cfg(tenant, 7);
  // 1) telefone sem thread → cria
  const a = await inbox.ensureConversation(c, tenant, '5519991112233');
  assert.equal(a.created, true, 'cria quando não há');
  assert.ok(a.conversation_id);
  // 2) mesmo número, formato diferente (sem 55, com pontuação) → REUSA a mesma conversa
  const b = await inbox.ensureConversation(c, tenant, '(19) 99111-2233');
  assert.equal(b.created, false, 'reusa por br_phone_key');
  assert.equal(b.conversation_id, a.conversation_id);
  // 3) conversa que veio de inbound (external_id +55…) → reusa, não duplica
  const cid = await conv(tenant, H(913));
  const d = await inbox.ensureConversation(c, tenant, D(913));
  assert.equal(d.created, false); assert.equal(d.conversation_id, cid);
  // 4) telefone inválido → null
  assert.equal(await inbox.ensureConversation(c, tenant, '123'), null);
});

test('(8e) view=renovacoes: contato INTERNO nunca aparece (mesmo com contrato na janela + toque)', async () => {
  const tenant = '00000000-0000-0000-0000-0000000000ee'; await cfg(tenant, 7);
  // interno com contrato vencido 20d (na janela) E toque pendente — mesmo assim FORA
  const cInt = await conv(tenant, H(740)); await msg(cInt); await contrato(tenant, D(740), -20);
  await touchpoint(tenant, D(740), 'D-2', { status: 'pendente' });
  await interno(tenant, D(740));
  // controle: NÃO-interno, mesmo contrato vencido 20d -> ENTRA
  const cOk = await conv(tenant, H(741)); await msg(cOk); await contrato(tenant, D(741), -20);

  const { items } = await list(tenant, { view: 'renovacoes', limit: 50 });
  assert.ok(!byExt(items, H(740)), 'interno fica fora da aba mesmo com contrato+toque');
  assert.ok(byExt(items, H(741)), 'não-interno com contrato na janela entra (controle)');
});

test('(8f) view=renovacoes: recepção RESOLVE → sai da aba; dismiss de outro ciclo (venc) não retira', async () => {
  const tenant = '00000000-0000-0000-0000-0000000000ef'; await cfg(tenant, 7);
  // contrato vencido 20d (na janela) → entra
  const cv = await conv(tenant, H(750)); await msg(cv); await contrato(tenant, D(750), -20);
  assert.ok(byExt((await list(tenant, { view: 'renovacoes', limit: 50 })).items, H(750)), 'entra antes de resolver');
  // recepção resolve com o MESMO venc do ciclo → SAI
  await dismiss(tenant, D(750), -20);
  assert.ok(!byExt((await list(tenant, { view: 'renovacoes', limit: 50 })).items, H(750)), 'resolvido sai da aba');
  // outro contato: dismiss com venc que NÃO casa (ex.: ciclo antigo) → segue na aba
  const cv2 = await conv(tenant, H(751)); await msg(cv2); await contrato(tenant, D(751), -20);
  await dismiss(tenant, D(751), 5);
  assert.ok(byExt((await list(tenant, { view: 'renovacoes', limit: 50 })).items, H(751)), 'dismiss de outro venc não retira (ciclo novo reaparece)');
});

test('(8g) rascunho de renovação (Fase B): só na aba Renovação; após enviar, aparece na Caixa normal', async () => {
  const tenant = '00000000-0000-0000-0000-0000000000f1'; await cfg(tenant, 7);
  const r = await inbox.ensureRenovacaoDraft(c, tenant, '5519990022001');
  assert.equal(r.created, true, 'cria a conversa como rascunho');
  const cid = r.conversation_id;
  const emView = (v) => list(tenant, { view: v, limit: 50 }).then((x) => x.items.some((i) => i.conversation_id === cid));
  assert.equal(await emView('renovacoes'), true, 'rascunho aparece na aba Renovação');
  assert.equal(await emView('todas'), false, 'rascunho NÃO aparece na Caixa normal');
  assert.equal(await emView('nao_lead'), false, 'nem em Outras');
  // simula a 1ª mensagem enviada (limpa o flag) → passa a aparecer na Caixa normal
  await c.query('UPDATE conversations SET renovacao_draft=false WHERE id=$1', [cid]);
  assert.equal(await emView('todas'), true, 'após enviar, aparece na Caixa normal');
  // reusar o MESMO telefone não recria nem re-rascunha (conversa já existe)
  const r2 = await inbox.ensureRenovacaoDraft(c, tenant, '(19) 99002-2001');
  assert.equal(r2.created, false, 'reusa a conversa existente');
  assert.equal(r2.conversation_id, cid);
});

test('(9) nome do CONTATO = WhatsApp (pushName) primeiro; ALUNO/cadastro vira campo discreto', async () => {
  const tenant = '00000000-0000-0000-0000-0000000000ea'; await cfg(tenant, 7);
  // a) pushName + cadastro + lead → nome = pushName (WhatsApp); aluno = cadastro (difere)
  const cCad = await conv(tenant, H(800)); await msg(cCad, { sender: 'Zé do Zap' });
  await pessoaNome(tenant, D(800), 'João da Silva');
  await lead(tenant, { phone: D(800), name: 'Lead Antigo', status: 'QUALIFYING' });
  // b) pushName + lead (sem cadastro) → nome = pushName; aluno = lead
  const cLead = await conv(tenant, H(801)); await msg(cLead, { sender: 'Fulano WA' });
  await lead(tenant, { phone: D(801), name: 'Maria Lead', status: 'QUALIFYING' });
  // c) só pushName → nome = pushName; aluno = null
  const cPush = await conv(tenant, H(802)); await msg(cPush, { sender: 'Pedro WhatsApp' });
  // d) nada → cai no número (external_id); aluno = null
  const cNum = await conv(tenant, H(803)); await msg(cNum, {});

  const { items } = await list(tenant, { limit: 50 });
  const a = byExt(items, H(800));
  assert.equal(a.contato.nome, 'Zé do Zap', 'WhatsApp (pushName) é o nome do contato');
  assert.equal(a.contato.aluno, 'João da Silva', 'cadastro vira o aluno discreto (difere do contato)');
  const b = byExt(items, H(801));
  assert.equal(b.contato.nome, 'Fulano WA'); assert.equal(b.contato.aluno, 'Maria Lead');
  const cc = byExt(items, H(802));
  assert.equal(cc.contato.nome, 'Pedro WhatsApp'); assert.equal(cc.contato.aluno, null, 'sem cadastro/lead → sem aluno');
  assert.equal(byExt(items, H(803)).contato.nome, H(803), 'número quando não há nada');
});

test('(7) isolamento multi-tenant', async () => {
  const tA = '00000000-0000-0000-0000-0000000000e7'; const tB = '00000000-0000-0000-0000-0000000000e8';
  await cfg(tA, 7); await cfg(tB, 7);
  const cvA = await conv(tA, H(600)); await msg(cvA);
  const cvB = await conv(tB, H(601)); await msg(cvB);
  const itemsA = (await list(tA, { limit: 50 })).items;
  assert.ok(byExt(itemsA, H(600)) && !byExt(itemsA, H(601)), 'tenant A não vê conversa de B');
});
