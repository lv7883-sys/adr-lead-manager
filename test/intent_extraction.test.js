'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('../src/server'); // garante carregamento dos módulos
const { pool, withTenant } = require('../src/db');
const redisClient = require('../src/redisClient');
const engine = require('../src/engine');

const TENANT_ID = crypto.randomUUID();
const tenant = { id: TENANT_ID };
const q = (sql, params) => withTenant(TENANT_ID, (c) => c.query(sql, params)).then((r) => r.rows);

// Deps base: passa o Portão 1 e captura os argumentos de generate.
function baseDeps(captor = {}) {
  return {
    classify: async () => ({ label: 'LEAD', confidence: 0.95, reason: 'ok' }),
    generate: async (args) => {
      captor.generate = args;
      return 'Resposta sugerida ao lead.';
    },
    classifyIntent: async () => 'GENERAL_INFO',
    extract: async () => ({ name: null, instrument: null, availability: null, ambiguous: [] }),
    notify: async () => ({ sent: true }),
    redis: redisClient,
  };
}

let seq = 0;
function inbound() {
  seq += 1;
  const tail = String(100 + seq);
  return {
    externalId: `551193000${tail}`,
    externalMessageId: `ie-${seq}`,
    sender: 'Lead',
    body: 'mensagem',
  };
}

before(async () => {
  await withTenant(TENANT_ID, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, name, lead_manager_active, zapi_token)
       VALUES ($1, 'Academia do Rock', true, 'tok')`,
      [TENANT_ID]
    );
    await c.query(
      `INSERT INTO tenant_lead_config (tenant_id, school_name, available_instruments, business_hours)
       VALUES ($1, 'Academia do Rock', $2, '{}'::jsonb)`,
      [TENANT_ID, ['Guitarra', 'Bateria']]
    );
  });
});

after(async () => {
  await withTenant(TENANT_ID, (c) => c.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]));
  await redisClient.redis.quit().catch(() => {});
  await pool.end();
});

async function leadIntentFor(phone) {
  const r = await q('SELECT intent FROM leads WHERE tenant_id = $1 AND phone = $2', [TENANT_ID, phone]);
  return r[0]?.intent;
}

// ---------------- E1-02: intenção ----------------

test('E1-02: mensagem sobre preço -> intent PRICE_INQUIRY', async () => {
  const deps = baseDeps();
  deps.classifyIntent = async () => 'PRICE_INQUIRY';
  const msg = inbound();
  msg.body = 'quanto custa a mensalidade?';
  await engine.processInbound(tenant, msg, {}, deps);
  assert.equal(await leadIntentFor(`+${msg.externalId}`), 'PRICE_INQUIRY');
});

test('E1-02: mensagem sobre agendamento -> intent SCHEDULE_INTEREST', async () => {
  const deps = baseDeps();
  deps.classifyIntent = async () => 'SCHEDULE_INTEREST';
  const msg = inbound();
  msg.body = 'posso marcar uma aula experimental?';
  await engine.processInbound(tenant, msg, {}, deps);
  assert.equal(await leadIntentFor(`+${msg.externalId}`), 'SCHEDULE_INTEREST');
});

test('E1-02: fora do escopo -> intent OUT_OF_SCOPE + system prompt redireciona a humano', async () => {
  const captor = {};
  const deps = baseDeps(captor);
  deps.classifyIntent = async () => 'OUT_OF_SCOPE';
  const msg = inbound();
  msg.body = 'vocês vendem pizza?';
  await engine.processInbound(tenant, msg, {}, deps);
  assert.equal(await leadIntentFor(`+${msg.externalId}`), 'OUT_OF_SCOPE');
  // A instrução de redirecionamento vive no system prompt (template padrão).
  assert.match(captor.generate.systemPrompt, /atendente humano/i);
});

// ---------------- E1-03: extração ----------------

test('E1-03: extrai nome + instrumento + disponibilidade -> qualification_complete + QUALIFIED', async () => {
  const deps = baseDeps();
  deps.extract = async () => ({
    name: 'João',
    instrument: 'Guitarra',
    availability: 'noites de terça',
    ambiguous: [],
  });
  const msg = inbound();
  msg.body = 'sou o João, quero guitarra, terça à noite';
  await engine.processInbound(tenant, msg, {}, deps);

  const phone = `+${msg.externalId}`;
  const lead = await q('SELECT id, status FROM leads WHERE tenant_id = $1 AND phone = $2', [
    TENANT_ID,
    phone,
  ]);
  assert.equal(lead[0].status, 'QUALIFIED');

  const qual = await q(
    'SELECT name, instrument, availability, qualification_complete FROM lead_qualifications WHERE lead_id = $1',
    [lead[0].id]
  );
  assert.equal(qual[0].qualification_complete, true);
  assert.equal(qual[0].name, 'João');
  assert.equal(qual[0].instrument, 'Guitarra');
});

test('E1-03: dado ambíguo gera repergunta única (e ainda não completa)', async () => {
  const captor = {};
  const deps = baseDeps(captor);
  deps.extract = async () => ({
    name: 'Maria',
    instrument: 'Bateria',
    availability: null,
    ambiguous: ['availability'],
  });
  const msg = inbound();
  msg.body = 'sou a Maria, quero bateria, qualquer hora talvez';
  await engine.processInbound(tenant, msg, {}, deps);

  // generate recebeu a instrução de repergunta sobre disponibilidade.
  assert.ok(captor.generate.clarification, 'clarification deve ser passada ao generate');
  assert.match(captor.generate.clarification, /disponibilidade/i);

  const phone = `+${msg.externalId}`;
  const lead = await q('SELECT id, status FROM leads WHERE tenant_id = $1 AND phone = $2', [
    TENANT_ID,
    phone,
  ]);
  const qual = await q(
    'SELECT availability, qualification_complete, reasked FROM lead_qualifications WHERE lead_id = $1',
    [lead[0].id]
  );
  assert.equal(qual[0].qualification_complete, false);
  assert.equal(qual[0].availability, null, 'não marca unclear na primeira ambiguidade');
  assert.deepEqual(qual[0].reasked, ['availability']);
  assert.equal(lead[0].status, 'QUALIFYING');
});

test('E1-03: ambiguidade persistente após repergunta -> unclear (regra de repergunta única)', () => {
  // Unitário do merge: já reperguntado + ainda ambíguo -> 'unclear'.
  const stored = { name: 'Ana', instrument: 'Violão', availability: null, reasked: ['availability'] };
  const extraction = { name: null, instrument: null, availability: null, ambiguous: ['availability'] };
  const merged = engine.mergeQualification(stored, extraction);
  assert.equal(merged.values.availability, 'unclear');
  assert.equal(merged.clarify.length, 0, 'não repergunta de novo');
  assert.equal(merged.complete, false);
});
