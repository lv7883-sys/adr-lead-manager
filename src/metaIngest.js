'use strict';
//
// metaIngest.js — orquestra os webhooks da Meta para o funil (engine.js).
//   - leadgen / leadgen_update : busca o lead na Graph API, cria/atualiza o lead e
//     gera um RASCUNHO de 1º contato (modo observação) — pula a triagem (já é lead).
//   - messages (DM Messenger/IG): injeta a mensagem no funil normal (com triagem).
// Tudo best-effort: erros são logados, nunca propagados (o webhook já respondeu 200).
//
const meta = require('./meta');
const engine = require('./engine');
const logger = require('./logger');

// Procura um campo de instrumento entre as respostas do formulário (nome do campo
// costuma conter "instrument"/"instrumento").
function findInstrument(fieldMap) {
  for (const [k, v] of Object.entries(fieldMap)) {
    if (/instrument|instrumento/i.test(k) && v) return v;
  }
  return null;
}

// Monta uma 1ª mensagem em 1ª pessoa a partir dos dados do formulário, pra dar
// contexto ao Gemini gerar a resposta de boas-vindas.
function buildLeadgenMessage(name, instrument) {
  let m = 'Olá! Vim pelo anúncio e tenho interesse';
  m += instrument ? ` em aula de ${instrument}.` : ' nas aulas.';
  if (name) m += ` Meu nome é ${name}.`;
  return m;
}

async function ingestLeadgen(value, isUpdate) {
  const pageId = value && value.page_id;
  const leadgenId = value && value.leadgen_id;
  const log = logger.child({ page_id: pageId, leadgen_id: leadgenId, update: !!isUpdate });
  if (!leadgenId) { log.info('meta.leadgen.no_id', {}); return; }

  const tenantId = await meta.tenantByPageId(pageId);
  if (!tenantId) { log.info('meta.leadgen.unknown_page', {}); return; }

  const creds = await meta.pageCredsForTenant(tenantId);
  if (!creds || !creds.token) { log.warn('meta.leadgen.no_page_token', { tenant_id: tenantId }); return; }

  const lead = await meta.fetchLead(leadgenId, creds.token);   // pode lançar (id falso -> 404)
  const f = meta.fieldDataToMap(lead.field_data);
  const name = f.full_name || f.name ||
    [f.first_name, f.last_name].filter(Boolean).join(' ') || null;
  const phone = f.phone_number || f.phone || null;
  const instrument = findInstrument(f);

  const msg = {
    channel: 'meta_lead_ads',
    externalId: phone || leadgenId,
    phone,
    sender: name,
    body: buildLeadgenMessage(name, instrument),
    skipTriage: true,
    leadgenId,
    // Idempotência: leadgen reentregue não duplica; update reprocessa (created_time).
    externalMessageId: (isUpdate ? 'leadgen_update:' + leadgenId + ':' + (value.created_time || '')
                                 : 'leadgen:' + leadgenId),
  };
  log.info('meta.leadgen.ingesting', { tenant_id: tenantId, has_phone: !!phone, instrument: instrument || null });
  await engine.processInbound({ id: tenantId }, msg, { meta_leadgen: lead });
}

async function ingestMessage(pageId, m, channel, rawBody) {
  const log = logger.child({ page_id: pageId, channel });
  if (!m || !m.message) return;                         // delivery/read receipts, etc.
  if (m.message.is_echo) { log.info('meta.message.skip_echo', {}); return; }
  const text = m.message.text;
  if (!text) { log.info('meta.message.skip_no_text', {}); return; }   // anexo/postback: por ora ignora
  const psid = m.sender && m.sender.id;
  const mid = m.message.mid;
  if (!psid) { log.info('meta.message.no_psid', {}); return; }

  const tenantId = await meta.tenantByPageId(pageId);
  if (!tenantId) { log.info('meta.message.unknown_page', {}); return; }

  const creds = await meta.pageCredsForTenant(tenantId);
  if (!creds || !creds.token) { log.warn('meta.message.no_page_token', { tenant_id: tenantId }); return; }

  const name = await meta.fetchUserName(psid, creds.token);
  const msg = {
    channel,
    psid,
    externalId: psid,
    sender: name,
    body: text,
    externalMessageId: mid || null,
  };
  log.info('meta.message.ingesting', { tenant_id: tenantId, mid });
  await engine.processInbound({ id: tenantId }, msg, rawBody);
}

// Ponto de entrada: processa o corpo inteiro do webhook (várias entries).
async function ingest(body) {
  const object = body && body.object;
  const entries = Array.isArray(body && body.entry) ? body.entry : [];
  for (const entry of entries) {
    // Lead Ads (changes[].field = leadgen | leadgen_update)
    if (Array.isArray(entry.changes)) {
      for (const ch of entry.changes) {
        if (ch.field === 'leadgen' || ch.field === 'leadgen_update') {
          await ingestLeadgen(ch.value, ch.field === 'leadgen_update')
            .catch((err) => logger.error('meta.leadgen.error', { error: err.message }));
        }
      }
    }
    // DM (messaging[]). object 'instagram' = IG DM; 'page' = Messenger.
    if (Array.isArray(entry.messaging)) {
      const channel = object === 'instagram' ? 'instagram_dm' : 'facebook_messenger';
      for (const m of entry.messaging) {
        await ingestMessage(entry.id, m, channel, body)
          .catch((err) => logger.error('meta.message.error', { error: err.message }));
      }
    }
  }
}

module.exports = { ingest, ingestLeadgen, ingestMessage, findInstrument, buildLeadgenMessage };
