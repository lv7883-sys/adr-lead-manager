'use strict';

// Testes de INTEGRAÇÃO (DB+Redis) do fluxo de resiliência a 503 no Portão 1.
// Complementa resiliencia503.test.js (unitário dos helpers puros). Roda só em
// ambiente de teste (DATABASE_URL/REDIS_URL de teste) — NUNCA contra prod.
//
// Cobre os caminhos que o investigador/Leo pediu:
//   1. 503 no Portão 1 (contato novo) → retry esgota → BUFFER visível (não limbo/NOT_LEAD).
//   2. nova mensagem → reclassifica a CONVERSA INTEIRA → recupera pro funil (QUALIFYING) + rascunho.
//   3. job: 503 com janela de 15min ESGOTADA → Revisar + ALERTA ativo (classificacao_indisponivel).
//   4. erro NÃO-transitório (contrato) → NÃO entra no buffer (caminho antigo).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const app = require('../src/server');
const { pool, withTenant } = require('../src/db');
const redisClient = require('../src/redisClient');
const engine = require('../src/engine');

const TENANT_ID = crypto.randomUUID();
let server;

const q = (sql, params) => withTenant(TENANT_ID, (c) => c.query(sql, params)).then((r) => r.rows);
const tenant = { id: TENANT_ID };

// erro que casa _isTransientAIError (503 do Gemini, igual ao de prod).
const err503 = () => new Error('[GoogleGenerativeAI Error]: [503 Service Unavailable] This model is currently experiencing high demand.');

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await withTenant(TENANT_ID, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, name, lead_manager_active, zapi_token, notif_enabled)
       VALUES ($1, 'Academia 503', true, 'tok503', false)`, [TENANT_ID]);
    await c.query(
      `INSERT INTO tenant_lead_config (tenant_id, school_name, available_instruments, business_hours, notification_whatsapp)
       VALUES ($1, 'Academia 503', $2, '{}'::jsonb, '+5511999990000')`,
      [TENANT_ID, ['Bateria']]);
    await c.query(
      `INSERT INTO tenant_subscriptions (tenant_id, feature, status, valid_until)
       VALUES ($1, 'LEAD_MANAGER', 'ACTIVE', now() + interval '30 days')`, [TENANT_ID]);
  });
});

after(async () => {
  await withTenant(TENANT_ID, (c) => c.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]));
  await redisClient.redis.quit().catch(() => {});
  await new Promise((r) => server.close(r));
  await pool.end();
});

// deps que falham se a IA for chamada indevidamente (garante o caminho certo).
const baseDeps = () => ({
  classify: async () => assert.fail('classify não deveria ser chamado'),
  classifyConversa: async () => assert.fail('classifyConversa não deveria ser chamado'),
  generate: async () => assert.fail('generate não deveria ser chamado'),
  classifyIntent: async () => 'GENERAL_INFO',
  extract: async () => ({ name: null, instrument: null, availability: null }),
  notify: async () => ({ sent: false }),
  notificar: async () => {},
  redis: redisClient,
});

test('503 no Portão 1 (contato novo): retry esgota → BUFFER visível (não NOT_LEAD/limbo)', async () => {
  const phone = '+5511970000501';
  const deps = baseDeps();
  let tentativas = 0;
  deps.classify = async () => { tentativas += 1; throw err503(); };   // 503 em toda tentativa

  await engine.processInbound(tenant, { phone, externalId: phone, body: 'Boa noite', externalMessageId: 'm503-1' }, {}, deps);

  assert.ok(tentativas >= 2, 'deve ter havido retry imediato (>=2 tentativas)');
  const lead = await q('SELECT status, classification_pending_since, classification_attempts FROM leads WHERE tenant_id=$1 AND phone=$2', [TENANT_ID, phone]);
  assert.equal(lead.length, 1, 'lead criado (não some no limbo)');
  assert.equal(lead[0].status, 'PENDING_CLASSIFICATION', 'estado VISÍVEL de buffer, não NOT_LEAD');
  assert.ok(lead[0].classification_pending_since, 'janela do buffer iniciada');
  // mensagem capturada pro reprocessamento da conversa inteira:
  const msgs = await q(`SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id
                        WHERE c.tenant_id=$1 AND regexp_replace(c.external_id,'[^0-9]','','g') LIKE '%11970000501%'`, [TENANT_ID]);
  assert.ok(msgs.length >= 1, 'mensagem do lead capturada no buffer');
});

test('recuperação por EVENTO: nova mensagem → classifyConversa (conversa inteira) → funil + rascunho', async () => {
  const phone = '+5511970000501';   // mesmo lead do teste anterior (já em buffer)
  const deps = baseDeps();
  // Agora o classificador de conversa funciona e vê o thread completo (saudação + intenção):
  deps.classifyConversa = async ({ conversation }) => {
    assert.ok(conversation.length >= 2, 'reclassifica a CONVERSA INTEIRA (>=2 turnos), não single-message');
    return { is_lead: true, confidence: 0.9, reasoning: 'quer aula de bateria',
             intent: 'NOVA_OPORTUNIDADE', conversation_state: 'AGUARDANDO_RECEPCAO', state_reasoning: 'cliente perguntou', suggested_stage: null, stage_reasoning: null };
  };
  deps.generate = async () => 'Olá! Vamos agendar sua aula experimental de bateria?';

  await engine.processInbound(tenant, { phone, externalId: phone, body: 'Gostaria de aula de bateria', externalMessageId: 'm503-2' }, {}, deps);

  const lead = await q('SELECT status, classification_pending_since FROM leads WHERE tenant_id=$1 AND phone=$2', [TENANT_ID, phone]);
  assert.equal(lead[0].status, 'QUALIFYING', 'recuperado pro funil');
  assert.equal(lead[0].classification_pending_since, null, 'buffer limpo');
  const pa = await q(`SELECT 1 FROM pending_approvals pa JOIN leads l ON l.id=pa.lead_id
                      WHERE l.tenant_id=$1 AND l.phone=$2 AND pa.status='PENDING'`, [TENANT_ID, phone]);
  assert.ok(pa.length >= 1, 'rascunho (pending_approval) gerado');
});

test('job: 503 com janela de 15min ESGOTADA → Revisar + alerta ATIVO', async () => {
  const phone = '+5511970000502';
  // cria um lead no buffer com pending_since ANTIGO (>15min) — simula janela esgotada.
  const leadId = (await q(
    `INSERT INTO leads (tenant_id, name, phone, status, classification_pending_since, classification_attempts)
     VALUES ($1,'Fulano',$2,'PENDING_CLASSIFICATION', now() - interval '16 minutes', 5) RETURNING id`,
    [TENANT_ID, phone])).at(0).id;
  // conversa mínima pro reprocessamento ter o que ler.
  const convId = (await q(`INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1,'whatsapp',$2) RETURNING id`, [TENANT_ID, phone])).at(0).id;
  await q(`INSERT INTO messages (tenant_id, conversation_id, direction, role, body) VALUES ($1,$2,'inbound','USER','oi')`, [TENANT_ID, convId]);

  let alerta = null;
  const deps = {
    classifyConversa: async () => { throw err503(); },              // ainda falhando
    notificar: async (_t, tipo, dados) => { alerta = { tipo, dados }; },
  };
  const res = await engine.reprocessPendingLead(tenant, { id: leadId, phone, meta_psid: null, classification_pending_since: new Date(Date.now() - 16 * 60 * 1000) }, deps);

  assert.equal(res.status, 'expired_to_review');
  const lead = await q('SELECT status, classification_pending_since FROM leads WHERE id=$1', [leadId]);
  assert.equal(lead[0].status, 'REVIEW_QUEUE', 'janela esgotada → Revisar');
  assert.equal(lead[0].classification_pending_since, null, 'buffer limpo (não vira limbo permanente)');
  assert.ok(alerta && alerta.tipo === 'classificacao_indisponivel', 'alerta ATIVO disparado');
});

test('job: 503 DENTRO da janela → permanece no buffer (silencioso, sem alerta)', async () => {
  const phone = '+5511970000503';
  const leadId = (await q(
    `INSERT INTO leads (tenant_id, name, phone, status, classification_pending_since, classification_attempts)
     VALUES ($1,'Beltrano',$2,'PENDING_CLASSIFICATION', now() - interval '1 minute', 1) RETURNING id`,
    [TENANT_ID, phone])).at(0).id;
  const convId = (await q(`INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1,'whatsapp',$2) RETURNING id`, [TENANT_ID, phone])).at(0).id;
  await q(`INSERT INTO messages (tenant_id, conversation_id, direction, role, body) VALUES ($1,$2,'inbound','USER','oi')`, [TENANT_ID, convId]);

  let alertou = false;
  const deps = { classifyConversa: async () => { throw err503(); }, notificar: async () => { alertou = true; } };
  const res = await engine.reprocessPendingLead(tenant, { id: leadId, phone, meta_psid: null, classification_pending_since: new Date(Date.now() - 60 * 1000) }, deps);

  assert.equal(res.status, 'retained');
  const lead = await q('SELECT status FROM leads WHERE id=$1', [leadId]);
  assert.equal(lead[0].status, 'PENDING_CLASSIFICATION', 'continua no buffer');
  assert.equal(alertou, false, 'NÃO alerta dentro da janela (silencioso)');
});

test('erro NÃO-transitório (contrato) NÃO entra no buffer (caminho antigo)', async () => {
  const phone = '+5511970000504';
  const deps = baseDeps();
  deps.classify = async () => { throw new SyntaxError('Unexpected token < in JSON'); };

  await engine.processInbound(tenant, { phone, externalId: phone, body: 'oi', externalMessageId: 'm504-1' }, {}, deps);

  const lead = await q('SELECT status FROM leads WHERE tenant_id=$1 AND phone=$2', [TENANT_ID, phone]);
  assert.equal(lead.length, 0, 'erro de contrato não cria lead em buffer (captura inbound como antes)');
});
