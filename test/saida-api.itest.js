'use strict';
// saida-api.itest.js — paridade com o WhatsApp, etapa 1 (15/09/2026).
// Todo envio do Regente pela API (avisos do dashboard, alertas, a própria Caixa de Entrada) tem de aparecer
// NA HORA, na conversa certa e com os tiques. Antes: SEND_MESSAGE desligado → avisos só na busca de
// histórico, até ~6 h depois, sem tiques; e saída para quem nunca escreveu ficava sem conversa (invisível).
// PG descartável; o webhook e o registro de saída reais, sem mock.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const staffSamples = require('../src/staffSamples');
const outbound = require('../src/outbound');
const webhook = require('../src/routes/webhook');

let c;
const T1 = '00000000-0000-0000-0000-0000000000a5';
const eco = (remoteJid, id) => ({ event: 'send.message', data: { key: { remoteJid, fromMe: true, id } } });

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE OR REPLACE FUNCTION br_phone_key(x text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
      WITH d AS (SELECT regexp_replace(coalesce(x, ''), '[^0-9]', '', 'g') AS v),
           loc AS (SELECT CASE WHEN length(v) IN (12,13) AND left(v,2)='55' THEN substr(v,3) ELSE v END AS v FROM d)
      SELECT CASE WHEN length(v)=11 AND substr(v,3,1)='9' THEN left(v,2)||substr(v,4) ELSE v END FROM loc
    $fn$;
    CREATE TABLE conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text, external_id text,
      conversation_kind text DEFAULT 'DIRECT', updated_at timestamptz DEFAULT now(), last_read_at timestamptz,
      br_key text GENERATED ALWAYS AS (br_phone_key(external_id)) STORED,
      UNIQUE (tenant_id, channel, external_id));
    CREATE TABLE staff_outbound_samples (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text, external_id text,
      external_message_id text, source text, sender text, body text, raw jsonb,
      media_url text, media_type text, media_filename text, reply_to_message_id uuid,
      is_group boolean NOT NULL DEFAULT false, ack_status text, received_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX so_uq ON staff_outbound_samples (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL;
    CREATE TABLE pending_approvals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, conversation_id uuid,
      status text, created_at timestamptz DEFAULT now());
    -- migr. 114 (espelho): tique que chegou antes da mensagem
    CREATE TABLE wa_ack_pendente (tenant_id uuid NOT NULL, external_message_id text NOT NULL,
      ack_status text NOT NULL, recebido_em timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, external_message_id));
    CREATE FUNCTION tg_staff_aplica_ack_pendente() RETURNS trigger AS $t$
    DECLARE pend text;
    BEGIN
      IF NEW.external_message_id IS NULL THEN RETURN NEW; END IF;
      DELETE FROM wa_ack_pendente WHERE tenant_id = NEW.tenant_id AND external_message_id = NEW.external_message_id
      RETURNING ack_status INTO pend;
      IF pend IS NOT NULL AND
         (CASE pend WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END)
         > (CASE NEW.ack_status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END) THEN
        NEW.ack_status := pend;
      END IF;
      RETURN NEW;
    END; $t$ LANGUAGE plpgsql;
    CREATE TRIGGER trg_staff_aplica_ack_pendente BEFORE INSERT ON staff_outbound_samples
      FOR EACH ROW EXECUTE FUNCTION tg_staff_aplica_ack_pendente();
  `);
});
after(async () => { await c.end(); });

const conversas = async () => (await c.query('SELECT external_id, conversation_kind, updated_at FROM conversations WHERE tenant_id=$1 ORDER BY external_id', [T1])).rows;
const saida = async (id) => (await c.query('SELECT * FROM staff_outbound_samples WHERE tenant_id=$1 AND external_message_id=$2', [T1, id])).rows[0];

test('(1) aviso para quem NUNCA escreveu -> abre a conversa e grava a saída como envio automático', async () => {
  const cap = await staffSamples.captureOutbound(T1,
    { externalId: '5519999990001', externalMessageId: 'RH1', source: 'regente-auto', sender: 'Escola', body: 'Rock Hour: inscrições até 25/09' },
    eco('5519999990001@s.whatsapp.net', 'RH1'));
  assert.equal(cap.rowCount, 1);
  const cv = await conversas();
  assert.equal(cv.length, 1, 'a conversa nasceu com o envio, como no WhatsApp');
  assert.equal(cv[0].external_id, '5519999990001');
  const s = await saida('RH1');
  assert.equal(s.source, 'regente-auto');
  assert.equal(s.body, 'Rock Hour: inscrições até 25/09');
});

test('(2) conversa existente em OUTRO formato de número -> reaproveita, sem duplicar e sem mexer no último inbound', async () => {
  await c.query(`INSERT INTO conversations (tenant_id, channel, external_id, updated_at) VALUES ($1,'whatsapp','5519981234567','2026-01-01T12:00:00Z')`, [T1]);
  // o WhatsApp devolve o jid SEM o 9º dígito
  await staffSamples.captureOutbound(T1,
    { externalId: '551981234567', externalMessageId: 'AG1', source: 'regente-auto', body: 'Agenda de hoje' },
    eco('551981234567@s.whatsapp.net', 'AG1'));
  const cv = (await conversas()).filter((x) => x.external_id.includes('1234567'));
  assert.equal(cv.length, 1, 'não duplica a conversa');
  assert.equal(new Date(cv[0].updated_at).toISOString(), '2026-01-01T12:00:00.000Z', 'updated_at (último inbound) intacto');
});

test('(3) grupo abre conversa de GRUPO; status do WhatsApp não vira conversa', async () => {
  await staffSamples.captureOutbound(T1,
    { externalId: '120363000000000001', externalMessageId: 'G1', source: 'regente-auto', body: 'Aviso no grupo' },
    eco('120363000000000001@g.us', 'G1'));
  await staffSamples.captureOutbound(T1,
    { externalId: 'status', externalMessageId: 'ST1', source: 'regente-auto', body: 'status' },
    eco('status@broadcast', 'ST1'));
  const cv = await conversas();
  assert.ok(cv.some((x) => x.external_id === '120363000000000001@g.us' && x.conversation_kind === 'GROUP'));
  assert.ok(!cv.some((x) => x.external_id.startsWith('status')), 'status não é conversa');
  assert.equal((await saida('G1')).is_group, true);
});

test('(4) tique que chega ANTES da mensagem espera e é aplicado quando ela entra', async () => {
  await webhook.atualizarAckStatus(T1, { event: 'messages.update', data: { keyId: 'NPS1', fromMe: true, status: 'DELIVERY_ACK' } });
  const pend = (await c.query('SELECT ack_status FROM wa_ack_pendente WHERE tenant_id=$1 AND external_message_id=$2', [T1, 'NPS1'])).rows[0];
  assert.equal(pend && pend.ack_status, 'delivered', 'o tique ficou esperando');
  // chega um READ antes da mensagem também: sobe, não desce
  await webhook.atualizarAckStatus(T1, { event: 'messages.update', data: { keyId: 'NPS1', fromMe: true, status: 'READ' } });
  await webhook.atualizarAckStatus(T1, { event: 'messages.update', data: { keyId: 'NPS1', fromMe: true, status: 'DELIVERY_ACK' } });
  await staffSamples.captureOutbound(T1,
    { externalId: '5519999990002', externalMessageId: 'NPS1', source: 'regente-auto', body: 'Como está sendo sua experiência?' },
    eco('5519999990002@s.whatsapp.net', 'NPS1'));
  assert.equal((await saida('NPS1')).ack_status, 'read', 'a mensagem entra já com o tique certo');
  const resto = (await c.query('SELECT count(*)::int n FROM wa_ack_pendente WHERE tenant_id=$1 AND external_message_id=$2', [T1, 'NPS1'])).rows[0].n;
  assert.equal(resto, 0, 'o pendente é consumido');
});

test('(5) recibo de mensagem do CLIENTE não cria pendência; tique de saída existente atualiza direto', async () => {
  await webhook.atualizarAckStatus(T1, { event: 'messages.update', data: { keyId: 'CLIENTE1', fromMe: false, status: 'READ' } });
  const n = (await c.query('SELECT count(*)::int n FROM wa_ack_pendente WHERE external_message_id=$1', ['CLIENTE1'])).rows[0].n;
  assert.equal(n, 0);
  await webhook.atualizarAckStatus(T1, { event: 'messages.update', data: { keyId: 'RH1', fromMe: true, status: 'DELIVERY_ACK' } });
  assert.equal((await saida('RH1')).ack_status, 'delivered');
  const pend = (await c.query('SELECT count(*)::int n FROM wa_ack_pendente WHERE external_message_id=$1', ['RH1'])).rows[0].n;
  assert.equal(pend, 0, 'mensagem existente não gera pendência');
});

test('(6) o evento de envio chega ANTES do registro do Regente -> o registro completa quem enviou', async () => {
  await staffSamples.captureOutbound(T1,
    { externalId: '5519999990003', externalMessageId: 'JN1', source: 'regente-auto', sender: 'Academia', body: '*Janis Joplin*\nOi!' },
    eco('5519999990003@s.whatsapp.net', 'JN1'));
  await outbound.registrarSaida(T1, { phone: '5519999990003', externalMessageId: 'JN1', sender: 'Janis Joplin', body: '*Janis Joplin*\nOi!' });
  const s = await saida('JN1');
  assert.equal(s.sender, 'Janis Joplin', 'quem enviou não se perde');
  assert.equal(s.source, 'api');
  const n = (await c.query('SELECT count(*)::int n FROM staff_outbound_samples WHERE external_message_id=$1', ['JN1'])).rows[0].n;
  assert.equal(n, 1, 'uma linha só');
});
