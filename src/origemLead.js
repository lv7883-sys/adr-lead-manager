'use strict';
//
// origemLead.js — ATRIBUIÇÃO DE ORIGEM do contato que chega pelo WhatsApp (mídia paga
// Click-to-WhatsApp). Responde "este lead veio de qual anúncio?" sem depender do Meta
// Business Manager: sem Graph API, sem Insights, sem Conversions API — só o que a
// Evolution entrega no webhook.
//
// A REGRA QUE GOVERNA ESTE ARQUIVO
//   O dado de origem chega UMA ÚNICA VEZ, no contextInfo da PRIMEIRA mensagem. Se não for
//   gravado naquele instante, está perdido para sempre — não há a quem perguntar depois.
//   Por isso registrarOrigem() roda ANTES de qualquer IA no webhook, e por isso ela NUNCA
//   lança: uma falha aqui vira log, jamais uma exceção que derrube a ingestão.
//
// DOIS SINAIS, NESTA ORDEM
//   1. contextInfo.externalAdReply — o que a Meta anexa quando a pessoa clica no anúncio.
//      Rico (título, corpo, URL, id do anúncio) e gratuito, mas o formato é dela: pode
//      mudar sem aviso e some se a pessoa apaga o texto pré-preenchido.
//   2. código no texto ("... [RK3]") — NOSSO. Vai no texto pré-preenchido do anúncio, não
//      muda sem a gente mudar, e é por isso que ele MANDA nos campos derivados quando os
//      dois aparecem juntos.
//   Nenhum dos dois -> metodo='nenhum', mas o payload bruto é gravado do mesmo jeito:
//   é nele que se descobre o formato que ainda não conhecemos.
//
const { withTenant } = require('./db');
const logger = require('./logger');
const waConteudo = require('./waConteudo');

// Código do anúncio no FIM do texto pré-preenchido: "Quero saber mais [RK3]".
// No fim, e não em qualquer lugar, para não capturar colchete que a pessoa escreveu.
const CODIGO_RE = /\[([A-Z0-9]{2,4})\]\s*$/;

// Limite defensivo do que vem de fora: campo gigante não entope a linha nem o log.
const MAX = 2000;
const _txt = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, MAX) : null;
};

/**
 * Acha o externalAdReply dentro do objeto `message` da Evolution.
 * O contextInfo mora no submessage do tipo (extendedTextMessage.contextInfo,
 * imageMessage.contextInfo, ...) — mesma régua do waConteudo. Desembrulha antes
 * (mensagem temporária / de outro aparelho) para não perder o anúncio no embrulho.
 * Retorna { anuncioId, anuncioUrl, anuncioTitulo, anuncioTexto } ou null.
 */
function extrairAnuncio(message) {
  if (!message || typeof message !== 'object') return null;
  let inner;
  try { inner = waConteudo.desembrulhar(message).inner; } catch { inner = message; }
  if (!inner || typeof inner !== 'object') return null;
  const candidatos = [];
  if (inner.contextInfo && typeof inner.contextInfo === 'object') candidatos.push(inner.contextInfo);
  for (const [k, v] of Object.entries(inner)) {
    if (k === 'messageContextInfo' || k === 'contextInfo') continue;
    if (v && typeof v === 'object' && v.contextInfo && typeof v.contextInfo === 'object') candidatos.push(v.contextInfo);
  }
  for (const ci of candidatos) {
    const ar = ci.externalAdReply;
    if (!ar || typeof ar !== 'object' || Array.isArray(ar)) continue;
    const out = {
      anuncioId: _txt(ar.sourceId),
      anuncioUrl: _txt(ar.sourceUrl),
      anuncioTitulo: _txt(ar.title),
      anuncioTexto: _txt(ar.body),
    };
    // Objeto presente mas sem nada dentro não é atribuição — é ruído.
    if (!out.anuncioId && !out.anuncioUrl && !out.anuncioTitulo && !out.anuncioTexto) continue;
    return out;
  }
  return null;
}

/** Código do de-para no fim do texto. Retorna 'RK3' ou null. */
function extrairCodigoCampanha(texto) {
  if (texto == null) return null;
  const m = CODIGO_RE.exec(String(texto));
  return m ? m[1] : null;
}

/**
 * PARSER PURO (sem banco, sem exceção): lê o payload do webhook e diz o que ele carrega.
 * Retorna { anuncio, codigoCampanha, metodo }.
 *   externalAdReply  -> 'anuncio_meta'
 *   código no texto  -> 'codigo_campanha'  (manda nos derivados, mesmo com anúncio junto)
 *   nenhum           -> 'nenhum'
 */
function analisar({ message, texto } = {}) {
  let anuncio = null;
  try { anuncio = extrairAnuncio(message); } catch { anuncio = null; }
  let codigoCampanha = null;
  try { codigoCampanha = extrairCodigoCampanha(texto); } catch { codigoCampanha = null; }
  const metodo = codigoCampanha ? 'codigo_campanha' : (anuncio ? 'anuncio_meta' : 'nenhum');
  return { anuncio, codigoCampanha, metodo };
}

/**
 * De-para -> campos derivados. Preferência: o código (nosso) na frente do id do anúncio
 * (da Meta). Só linha VIGENTE hoje (valido_de/valido_ate) — recriar um código para outra
 * campanha no mês que vem não pode reescrever a leitura do mês passado.
 * Retorna { campanha_ref, motor, objetivo, publico, criativo } ou null.
 */
async function resolverDePara(c, tenantId, { codigoCampanha, anuncioId }) {
  const campos = 'campanha_ref, motor, objetivo, publico, criativo';
  const vigente = '(valido_de IS NULL OR valido_de <= current_date) AND (valido_ate IS NULL OR valido_ate >= current_date)';
  if (codigoCampanha) {
    const r = await c.query(
      `SELECT ${campos} FROM mapa_campanha WHERE tenant_id = $1 AND codigo_campanha = $2 AND ${vigente}`,
      [tenantId, codigoCampanha]);
    if (r.rows[0]) return r.rows[0];
  }
  if (anuncioId) {
    const r = await c.query(
      `SELECT ${campos} FROM mapa_campanha
        WHERE tenant_id = $1 AND anuncio_id = $2 AND ${vigente}
        ORDER BY valido_de DESC NULLS LAST LIMIT 1`,
      [tenantId, anuncioId]);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

/**
 * Grava a origem do PRIMEIRO toque deste contato. Idempotente e first-touch por
 * construção: o índice único (tenant, canal, chave_contato) + ON CONFLICT DO NOTHING
 * fazem a segunda mensagem do mesmo contato não sobrescrever nada.
 *
 * NUNCA LANÇA. Chamada no caminho do webhook; qualquer erro vira log estruturado.
 *
 * @param {string} tenantId
 * @param {{externalId: string, body: ?string}} msg  mensagem já normalizada pelo webhook
 * @param {object} rawBody  payload BRUTO do webhook (vai inteiro para payload_bruto)
 * @returns {Promise<{gravado: boolean, metodo: ?string}>}  metodo só vem preenchido
 *   quando houve gravação; o porquê de não haver fica no log.
 */
// ── O jid do WhatsApp NÃO é um telefone ────────────────────────────────────────────────
// Régua confirmada com a sessão de WhatsApp em 21/09/2026, espelhando src/waChats.js.
// Calcular br_phone_key em cima do jid cru produz CHAVE FALSA e contato duplicado:
//   • sufixo de dispositivo: `5519999990001:12@s.whatsapp.net` — o ":12" vira dígito;
//   • `@lid`: id de privacidade do WhatsApp, NÃO é telefone. Os dígitos do lid viram
//     "telefone" e inventam um contato. Resolve-se pelo mapa wa_lid (migr. 115);
//   • `@g.us`: grupo (18–19 dígitos) nunca é lead — foi a causa da migr. 113.
// Sem telefone confiável, NÃO se grava origem. Chave errada é pior que origem ausente:
// ausente aparece como 'nenhum' e se investiga; errada atribui a campanha à pessoa errada
// e ninguém desconfia.
const _dig = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');

// Migração 171 ainda não aplicada: desliga após o primeiro erro. Sem isto seria UMA linha
// de erro por mensagem recebida até alguém aplicar — barulho que esconde erro de verdade.
// A ordem correta é migração ANTES do deploy; isto é a rede para quem inverter, ou para um
// rollback que deixe código novo com banco antigo.
let _semTabela = false;

async function _telefoneDoContato(c, tenantId, rawBody, msg) {
  const jid = rawBody && rawBody.data && rawBody.data.key && rawBody.data.key.remoteJid;
  if (!jid) {
    // Z-API (body.phone) e caminhos sem jid: o externalId já é telefone.
    const pn = _dig(msg && msg.externalId);
    return pn.length >= 10 && pn.length <= 15 ? { pn } : { pular: 'telefone_invalido' };
  }
  const j = String(jid).replace(/:\d+@/, '@');            // tira o sufixo de dispositivo
  if (/@g\.us$/i.test(j)) return { pular: 'grupo' };       // grupo nunca é lead
  let pn = /@lid$/i.test(j) ? null : _dig(j);
  if (!pn && /@lid$/i.test(j)) {
    const r = await c.query('SELECT pn FROM wa_lid WHERE tenant_id = $1 AND lid = $2', [tenantId, j]);
    pn = r.rows[0] && r.rows[0].pn ? _dig(r.rows[0].pn) : null;
    if (!pn) return { pular: 'lid_sem_telefone' };
  }
  if (!pn || pn.length < 10 || pn.length > 15) return { pular: 'telefone_invalido' };
  return { pn };
}

async function registrarOrigem(tenantId, msg, rawBody, log = logger) {
  if (!tenantId || !msg || _semTabela) return { gravado: false, metodo: null };
  const canal = (msg && msg.channel) || 'whatsapp';
  try {
    const message = (rawBody && rawBody.data && rawBody.data.message) || null;
    const { anuncio, codigoCampanha, metodo } = analisar({ message, texto: msg.body });
    const ad = anuncio || {};
    const r = await withTenant(tenantId, async (c) => {
      const contato = await _telefoneDoContato(c, tenantId, rawBody, msg);
      if (contato.pular) {
        // info, não warn: 'grupo' é rotina. 'lid_sem_telefone' é o que vale investigar —
        // se aparecer muito, o mapa wa_lid não está sendo alimentado.
        log.info('origem_lead.sem_telefone', { tenant_id: tenantId, motivo: contato.pular });
        return { pulou: contato.pular };
      }
      const externalId = contato.pn;
      const derivado = (codigoCampanha || ad.anuncioId)
        ? await resolverDePara(c, tenantId, { codigoCampanha, anuncioId: ad.anuncioId })
        : null;
      const d = derivado || {};
      return c.query(
        `INSERT INTO origem_lead
           (tenant_id, canal, telefone, anuncio_id, anuncio_url, anuncio_titulo, anuncio_texto,
            codigo_campanha, campanha_ref, motor, objetivo, publico, criativo, metodo, payload_bruto)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15::jsonb, '{}'::jsonb))
         ON CONFLICT (tenant_id, canal, chave_contato) WHERE telefone NOT LIKE 'anonimizado\\_%'
           DO NOTHING
         RETURNING id`,
        [tenantId, canal, externalId, ad.anuncioId || null, ad.anuncioUrl || null,
          ad.anuncioTitulo || null, ad.anuncioTexto || null, codigoCampanha,
          d.campanha_ref || null, d.motor || null, d.objetivo || null, d.publico || null, d.criativo || null,
          metodo, rawBody ? JSON.stringify(rawBody) : null]);
    });
    // Pulou por falta de telefone confiável: NÃO gravou e não há método a declarar.
    // `metodo` descreve o que foi PERSISTIDO; devolvê-lo aqui faria o chamador acreditar
    // que existe uma linha de origem que não existe. O porquê fica no log — nenhum
    // chamador decide nada com ele, e o retorno tem um contrato só.
    if (r && r.pulou) return { gravado: false, metodo: null };
    const gravado = r.rowCount > 0;
    // Só o 1º toque vira log de origem; do 2º em diante seria ruído em toda mensagem.
    if (gravado) {
      log.info('origem_lead.capturado', {
        tenant_id: tenantId,
        metodo: metodo,
        anuncio_id: ad.anuncioId || null,
        codigo_campanha: codigoCampanha,
      });
    }
    return { gravado, metodo };
  } catch (e) {
    // O webhook segue. Perdemos a origem DESTE contato — e o log é o que conta isso.
    if (e && e.code === '42P01') {
      if (!_semTabela) {
        _semTabela = true;
        log.error('origem_lead.tabela_ausente', { tenant_id: tenantId,
          aviso: 'migração 171 não aplicada — captura de origem DESLIGADA até o próximo reinício' });
      }
    } else {
      log.error('origem_lead.falhou', { tenant_id: tenantId, error: e.message });
    }
    return { gravado: false, metodo: null };
  }
}

/**
 * Liga a origem ao lead depois que ele nasce (o lead só existe DEPOIS dos portões de
 * triagem; a origem foi gravada antes, por contato). Casa pela régua de telefone do
 * sistema (br_phone_key). Nunca toca nos campos de origem — o gatilho da migr. 171
 * levantaria exceção se tentasse.
 *
 * NUNCA LANÇA. Idempotente (só age em linha com lead_id NULL).
 */
async function vincularLead(tenantId, msg, rawBody, log = logger, canal = null) {
  if (!tenantId || !msg) return { vinculado: 0 };
  const via = canal || (msg && msg.channel) || 'whatsapp';
  try {
    const n = await withTenant(tenantId, async (c) => {
      // MESMA RÉGUA DA ESCRITA. Antes esta função recebia o `externalId` do webhook, que é
      // `jid.split('@')[0]` — com o `:12` de aparelho colado e com os dígitos de um `@lid`
      // fazendo as vezes de telefone. A gravação já passava por aqui; a leitura não, e casar
      // por uma chave derivada de jid podre é grudar a origem de um contato no lead de outro.
      const contato = await _telefoneDoContato(c, tenantId, rawBody, msg);
      if (contato.pular) {
        log.info('origem_lead.vinculo_sem_telefone', { tenant_id: tenantId, motivo: contato.pular });
        return 0;
      }
      return (await c.query(
      `UPDATE origem_lead s
          SET lead_id = l.id
         FROM (SELECT id, br_phone_key(coalesce(phone, '')) AS k
                 FROM leads
                WHERE tenant_id = $1 AND br_phone_key(coalesce(phone, '')) = br_phone_key($3)
                ORDER BY created_at ASC LIMIT 1) l
        WHERE s.tenant_id = $1 AND s.canal = $2 AND s.chave_contato = l.k AND s.lead_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM origem_lead s2
                           WHERE s2.tenant_id = $1 AND s2.lead_id = l.id)`,
      [tenantId, via, contato.pn])).rowCount;
    });
    if (n) log.info('origem_lead.vinculado', { tenant_id: tenantId, linhas: n });
    return { vinculado: n };
  } catch (e) {
    log.warn('origem_lead.vinculo_falhou', { tenant_id: tenantId, error: e.message });
    return { vinculado: 0 };
  }
}

/** Origem de um lead (leitura). Retorna a linha ou null. */
async function origemDoLead(tenantId, leadId) {
  if (!tenantId || !leadId) return null;
  return withTenant(tenantId, async (c) => (await c.query(
    `SELECT metodo, anuncio_id, anuncio_url, anuncio_titulo, anuncio_texto, codigo_campanha,
            campanha_ref, motor, objetivo, publico, criativo, capturado_em
       FROM origem_lead WHERE tenant_id = $1 AND lead_id = $2`,
    [tenantId, leadId])).rows[0] || null);
}

module.exports = {
  registrarOrigem, vincularLead, origemDoLead,
  // puros, exportados p/ teste de unidade (sem banco)
  analisar, extrairAnuncio, extrairCodigoCampanha, resolverDePara, CODIGO_RE,
};
