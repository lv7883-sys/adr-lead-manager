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
const autoReply = require('./autoReply');   // ADR-006+ resposta automática fora do horário
const logger = require('./logger');

// Default do mapeamento de campos do Lead Ad. ESPELHO EXATO do field_map seedado em
// db/migrations/041_tenant_lead_source.sql (linha do ADR) — manter os dois em sincronia.
// É o fallback quando a fonte (tenant_lead_source) ainda não tem field_map: garante
// comportamento idêntico ao histórico cravado (música/ADR) p/ qualquer tenant sem config.
const DEFAULT_FIELD_MAP = {
  name_keys: ['full_name', 'name'],
  name_compose_keys: ['first_name', 'last_name'],
  phone_keys: ['phone_number', 'phone'],
  email_keys: ['email', 'email_address', 'e-mail'],
  interest_key_pattern: 'instrument|instrumento',
  welcome: {
    prefix: 'Olá! Vim pelo anúncio e tenho interesse',
    with_interest: ' em aula de {interest}.',
    without_interest: ' nas aulas.',
    with_name: ' Meu nome é {name}.',
  },
};

// Primeiro valor não-vazio entre `keys`.
function firstByKeys(values, keys) {
  for (const k of keys || []) { if (values[k]) return values[k]; }
  return null;
}

// Compõe um valor juntando `keys` na ordem (ex.: first_name + last_name).
function composeByKeys(values, keys) {
  return (keys || []).map((k) => values[k]).filter(Boolean).join(' ') || null;
}

// Acha o valor cujo NOME de campo casa o padrão de interesse (ex.: instrumento).
// Generaliza a antiga findInstrument: o padrão vem do field_map (domínio externalizado).
function findInterest(values, pattern) {
  if (!pattern) return null;
  let re;
  try { re = new RegExp(pattern, 'i'); } catch { return null; }
  for (const [k, v] of Object.entries(values)) {
    if (re.test(k) && v) return v;
  }
  return null;
}

// Monta a 1ª mensagem em 1ª pessoa (contexto p/ o Gemini gerar a boas-vindas) a partir
// do template `welcome` do field_map. Placeholders {interest} e {name}.
function buildLeadgenMessage(welcome, name, interest) {
  const w = welcome || DEFAULT_FIELD_MAP.welcome;
  let m = w.prefix;
  m += interest ? w.with_interest.replace('{interest}', interest) : w.without_interest;
  if (name) m += w.with_name.replace('{name}', name);
  return m;
}

// Aplica um field_map (config por-fonte OU o DEFAULT) ao field_data já mapeado do form.
// Retorna { name, phone, interest, body } — paridade total com o hardcode quando cfg=DEFAULT.
function applyFieldMap(values, cfg) {
  const c = cfg || DEFAULT_FIELD_MAP;
  const name = firstByKeys(values, c.name_keys) || composeByKeys(values, c.name_compose_keys) || null;
  const phone = firstByKeys(values, c.phone_keys) || null;
  const email = firstByKeys(values, c.email_keys) || null;
  const interest = findInterest(values, c.interest_key_pattern);
  const body = buildLeadgenMessage(c.welcome, name, interest);
  return { name, phone, email, interest, body };
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
  // field_map por-tenant (externalizado); fallback ao DEFAULT (paridade c/ o hardcode).
  const cfg = (await meta.leadSourceFieldMap(tenantId, pageId)) || DEFAULT_FIELD_MAP;
  const { name, phone, email, interest, body } = applyFieldMap(f, cfg);

  const msg = {
    channel: 'meta_lead_ads',
    externalId: phone || leadgenId,
    phone,
    email,
    sender: name,
    body,
    skipTriage: true,
    leadgenId,
    // Idempotência: leadgen reentregue não duplica; update reprocessa (created_time).
    externalMessageId: (isUpdate ? 'leadgen_update:' + leadgenId + ':' + (value.created_time || '')
                                 : 'leadgen:' + leadgenId),
  };
  log.info('meta.leadgen.ingesting', { tenant_id: tenantId, has_phone: !!phone, interest: interest || null });
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
  // ADR-006+ — resposta automática fora do horário (Messenger/Instagram). Best-effort.
  autoReply.maybeAutoReply({ id: tenantId }, { channel, externalId: psid, inboundText: text })
    .catch((e) => log.warn('autoreply.unhandled', { error: e.message }));
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

module.exports = {
  ingest, ingestLeadgen, ingestMessage,
  applyFieldMap, findInterest, buildLeadgenMessage, DEFAULT_FIELD_MAP,
};
