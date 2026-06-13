'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const app = require('../src/server');
const { pool, withTenant } = require('../src/db');
const redisClient = require('../src/redisClient');
const engine = require('../src/engine');

const TENANT_ID = crypto.randomUUID();
const ZAPI_TOKEN = 'tok-engine-test';

let server;
let baseUrl;

// Atalho para consultas no contexto RLS do tenant de teste.
const q = (sql, params) => withTenant(TENANT_ID, (c) => c.query(sql, params)).then((r) => r.rows);

const tenant = { id: TENANT_ID };

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await withTenant(TENANT_ID, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, name, lead_manager_active, zapi_token)
       VALUES ($1, 'Academia do Rock', true, $2)`,
      [TENANT_ID, ZAPI_TOKEN]
    );
    await c.query(
      `INSERT INTO tenant_lead_config
         (tenant_id, school_name, available_instruments, business_hours, notification_whatsapp)
       VALUES ($1, 'Academia do Rock', $2, $3::jsonb, '+5511999990000')`,
      [TENANT_ID, ['Guitarra', 'Bateria'], JSON.stringify({ mon: '09:00-18:00' })]
    );
    // E9-05: gating exige assinatura ativa para processar.
    await c.query(
      `INSERT INTO tenant_subscriptions (tenant_id, feature, status, valid_until)
       VALUES ($1, 'LEAD_MANAGER', 'ACTIVE', now() + interval '30 days')`,
      [TENANT_ID]
    );
  });
});

after(async () => {
  await withTenant(TENANT_ID, (c) => c.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]));
  await redisClient.redis.quit().catch(() => {});
  await new Promise((r) => server.close(r));
  await pool.end();
});

// Deps que falham se chamadas indevidamente (garante que o portão barrou antes).
const failingDeps = () => ({
  classify: async () => assert.fail('classify não deveria ser chamado'),
  generate: async () => assert.fail('generate não deveria ser chamado'),
  notify: async () => ({ sent: false }),
  redis: redisClient,
});

test('contato conhecido NÃO é mais descartado: a IA decide pela mensagem', async () => {
  // Um número já cadastrado em known_contacts não deve mais ser ignorado no determinístico.
  // O critério é o CONTEÚDO da mensagem (cliente atual pode querer novo curso / perguntar
  // por outra pessoa) — a IA classifica normalmente, sem atalho por existência no banco.
  const phone = '+5511900000001';
  await q(
    `INSERT INTO known_contacts (tenant_id, phone, type, source)
     VALUES ($1, $2, 'STAFF', 'MANUAL')`,
    [TENANT_ID, phone]
  );

  let chamouClassify = false;
  const deps = {
    classify: async () => { chamouClassify = true; return { label: 'LEAD', confidence: 0.9, reason: 'novo curso' }; },
    generate: async () => 'Que bom! Vamos agendar sua aula?',
    notify: async () => ({ sent: false }),
    redis: redisClient,
  };

  await engine.processInbound(
    tenant,
    { externalId: '5511900000001', externalMessageId: 'g0-1', sender: 'Cliente', body: 'quero fazer violino também' },
    {},
    deps
  );

  assert.ok(chamouClassify, 'classify deve ser chamado mesmo para número em known_contacts');
  const leads = await q('SELECT 1 FROM leads WHERE tenant_id = $1 AND phone = $2', [TENANT_ID, phone]);
  assert.equal(leads.length, 1, 'contato conhecido com interesse vira lead (sem atalho de exclusão)');
});

test('Portão 1 (Bloco 2): confiança baixa não gera resposta e vai pra fila de revisão (NOT_LEAD)', async () => {
  const deps = failingDeps();
  // Nova semântica: confidence = probabilidade de SER lead. 0.05 = quase certeza que não é.
  deps.classify = async () => ({ is_lead: false, confidence: 0.05, reasoning: 'spam', profile_signals: [] });

  await engine.processInbound(
    tenant,
    { externalId: '5511900000002', externalMessageId: 'g1-1', sender: 'X', body: 'promoção imperdível' },
    {},
    deps
  );

  const pa = await q(
    `SELECT 1 FROM pending_approvals pa
       JOIN leads l ON l.id = pa.lead_id
      WHERE l.tenant_id = $1 AND l.phone = $2`,
    [TENANT_ID, '+5511900000002']
  );
  assert.equal(pa.length, 0, 'baixa confiança não deve gerar aprovação pendente');
  const lead = await q(
    'SELECT status, review_queue FROM leads WHERE tenant_id = $1 AND phone = $2',
    [TENANT_ID, '+5511900000002']
  );
  assert.equal(lead.length, 1, 'cria lead visível (zero lead perdido)');
  assert.equal(lead[0].status, 'NOT_LEAD');
  assert.equal(lead[0].review_queue, true, 'fica na fila de revisão');
});

test('Portão 1 (Bloco 2): confiança média (0.40–0.84) vira REVIEW_QUEUE sem rascunho', async () => {
  const deps = failingDeps();
  deps.classify = async () => ({ is_lead: true, confidence: 0.5, reasoning: 'incerto', profile_signals: [] });

  await engine.processInbound(
    tenant,
    { externalId: '5511900000003', externalMessageId: 'g1-2', sender: 'X', body: 'quero aula?' },
    {},
    deps
  );

  const leads = await q(
    'SELECT status, review_queue FROM leads WHERE tenant_id = $1 AND phone = $2',
    [TENANT_ID, '+5511900000003']
  );
  assert.equal(leads.length, 1, 'confiança média cria lead na fila de revisão');
  assert.equal(leads[0].status, 'REVIEW_QUEUE');
  assert.equal(leads[0].review_queue, true);
  const pa = await q(
    `SELECT 1 FROM pending_approvals pa JOIN leads l ON l.id = pa.lead_id
      WHERE l.tenant_id = $1 AND l.phone = $2`,
    [TENANT_ID, '+5511900000003']
  );
  assert.equal(pa.length, 0, 'REVIEW_QUEUE não gera rascunho automático');
});

test('F (Bloco 2): inbound de baixa confiança é capturado E cria lead na fila de revisão', async () => {
  const phone = '+5511900000050';
  const deps = failingDeps();
  deps.classify = async () => ({ is_lead: false, confidence: 0.1, reasoning: 'agradecimento', profile_signals: [] });

  await engine.processInbound(
    tenant,
    { externalId: '5511900000050', externalMessageId: 'f-1', sender: 'X', body: 'ok, obrigado!' },
    {},
    deps
  );

  const leads = await q(
    'SELECT status, review_queue FROM leads WHERE tenant_id = $1 AND phone = $2',
    [TENANT_ID, phone]
  );
  assert.equal(leads.length, 1, 'cria lead na fila de revisão (zero lead perdido)');
  assert.equal(leads[0].status, 'NOT_LEAD');
  const msgs = await q(
    `SELECT m.body FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
      WHERE cv.tenant_id = $1 AND cv.external_id = $2 AND m.role = 'USER'`,
    [TENANT_ID, phone]
  );
  assert.equal(msgs.length, 1, 'a mensagem inbound deve ser capturada');
});

test('Portão 2: lead novo passa todos os portões e gera pending_approval', async () => {
  const phone = '+5511900000004';
  const deps = {
    classify: async () => ({ label: 'LEAD', confidence: 0.92, reason: 'interesse claro' }),
    generate: async () => 'Olá! Que ótimo seu interesse 🎸 Posso te ajudar a agendar uma aula?',
    notify: async () => ({ sent: true }),
    redis: redisClient,
  };

  await engine.processInbound(
    tenant,
    { externalId: '5511900000004', externalMessageId: 'g2-1', sender: 'Lead Novo', body: 'quero aula de guitarra' },
    { phone: '5511900000004', text: { message: 'quero aula de guitarra' } },
    deps
  );

  const lead = await q('SELECT id, status FROM leads WHERE tenant_id = $1 AND phone = $2', [
    TENANT_ID,
    phone,
  ]);
  assert.equal(lead.length, 1);
  assert.equal(lead[0].status, 'QUALIFYING', 'lead deve ser promovido NEW -> QUALIFYING');

  const pa = await q(
    'SELECT suggested_response, status FROM pending_approvals WHERE tenant_id = $1 AND lead_id = $2',
    [TENANT_ID, lead[0].id]
  );
  assert.equal(pa.length, 1);
  assert.equal(pa[0].status, 'PENDING');
  assert.match(pa[0].suggested_response, /agendar uma aula/);

  const roles = (
    await q(
      `SELECT role FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.external_id = $1 AND m.tenant_id = $2 ORDER BY role`,
      [phone, TENANT_ID]
    )
  ).map((r) => r.role);
  assert.deepEqual(roles, ['ASSISTANT', 'USER'], 'deve salvar mensagem USER e ASSISTANT');
});

test('Portão 2: lead existente — generate recebe a conversa REAL mesclada + retomada', async () => {
  const phone = '+5511900000005';
  // Lead + conversa + entrada anterior do lead (messages USER) + resposta REAL da
  // recepção (staff_outbound_samples fromMe).
  await withTenant(TENANT_ID, async (c) => {
    await c.query(
      `INSERT INTO leads (tenant_id, name, phone, status) VALUES ($1, 'Recorrente', $2, 'QUALIFYING')`,
      [TENANT_ID, phone]
    );
    const r = await c.query(
      `INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1, 'whatsapp', $2) RETURNING id`,
      [TENANT_ID, phone]
    );
    await c.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, role, body, received_at)
       VALUES ($1, $2, 'inbound', 'USER', 'oi, vi o anúncio', now() - interval '2 minutes')`,
      [TENANT_ID, r.rows[0].id]
    );
    await c.query(
      `INSERT INTO staff_outbound_samples (tenant_id, channel, external_id, body, received_at)
       VALUES ($1, 'whatsapp', '5511900000005', 'oi! que bom, sobre qual instrumento?', now() - interval '1 minute')`,
      [TENANT_ID]
    );
  });

  let capturedHistory = null;
  let capturedRetomada = null;
  const deps = {
    classify: async () => ({ label: 'LEAD', confidence: 0.9, reason: 'retorno' }),
    generate: async ({ history, retomada }) => {
      capturedHistory = history;
      capturedRetomada = retomada;
      return 'perfeito, podemos seguir!';
    },
    notify: async () => ({ sent: true }),
    redis: redisClient,
  };

  await engine.processInbound(
    tenant,
    { externalId: '5511900000005', externalMessageId: 'g2-2', sender: 'Recorrente', body: 'guitarra' },
    {},
    deps
  );

  assert.deepEqual(
    capturedHistory,
    [
      { role: 'USER', content: 'oi, vi o anúncio' },
      { role: 'ASSISTANT', content: 'oi! que bom, sobre qual instrumento?' },
    ],
    'generate recebe a conversa real mesclada (lead + recepção), em ordem cronológica'
  );
  assert.equal(capturedRetomada, true, 'com histórico real, retomada = true');
});

test('webhook retorna 200 mesmo quando o Gemini falha', async () => {
  // Sem GEMINI_API_KEY, a classificação real lança — mas o ACK é imediato.
  const res = await fetch(`${baseUrl}/webhook/zapi/${TENANT_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ZAPI-TOKEN': ZAPI_TOKEN },
    body: JSON.stringify({
      phone: '5511900000006',
      messageId: 'http-1',
      fromMe: false,
      text: { message: 'tem aula de bateria?' },
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
});
