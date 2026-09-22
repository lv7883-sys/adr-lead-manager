'use strict';
//
// ingestao.js — O GRUPO DE WHATSAPP VIRA MATÉRIA-PRIMA DE CONTEÚDO.
//
// O professor já filma a aula. Qualquer coisa que exija dele um passo a mais — abrir um
// app, preencher formulário, lembrar de enviar depois — não acontece numa terça-feira
// cheia. Então a ingestão se pendura no gesto que ele JÁ faz: mandar a foto no grupo.
// Zero ação humana além disso.
//
// SEIS PORTÕES, nesta ordem (o barato antes do caro — só se baixa arquivo no fim):
//   1. é foto ou vídeo de verdade?  texto, áudio, documento e FIGURINHA saem aqui
//   2. o grupo é fonte da unidade?  grupo não configurado não é matéria-prima
//   3. a unidade contratou o módulo?
//   4. ainda cabe na cota do mês?   estourou -> linha 'cota_excedida' com o motivo escrito
//   5. o download funcionou?        falhou -> linha 'falhou' com o motivo
//   6. já temos este arquivo?       dedup por sha256 do CONTEÚDO
//
// NUNCA LANÇA. Roda no caminho do webhook: qualquer erro vira log estruturado e a entrega
// segue. E NUNCA toca no funil de lead — mensagem de grupo já não entra no funil (o webhook
// retorna antes), e nada aqui muda isso.
//
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withTenant } = require('../db');
const logger = require('../logger');
const licenca = require('../plataforma/licenca');
const consumo = require('../plataforma/consumo');
const midia = require('./midia');
const evolution = require('../evolution');
const mediaLM = require('../media');
const { decrypt } = require('../crypto');

const MODULO = 'MARKETING';
// Só o que vira conteúdo. Áudio é conversa do grupo, documento é papelada — nenhum dos dois
// é matéria-prima de post.
const TIPOS_ACEITOS = { image: 'imagem', video: 'video' };
const COTA_CHAVE = 'midias_mes';           // lida de marketing.config_unidade.cota
const TIMEOUT_MS = Number(process.env.INGESTAO_TIMEOUT_MS || 45_000);
const TENTATIVAS = 3;
const EMOJI_CONFIRMACAO = '📌';
const SUBPASTA = 'materia-prima';

/**
 * PURO: este conteúdo interessa à ingestão? Devolve 'imagem' | 'video' | null.
 *
 * A pegadinha é a FIGURINHA: o normalizador do webhook a entrega como kind 'image'
 * (webhook.js, "figurinha = webp; tratada como imagem"), porque na Caixa de Entrada ela
 * renderiza no mesmo <img>. Aqui ela não serve — figurinha é reação, não foto de aula.
 * Barramos pelos dois lados: o stickerMessage no cru e o webp no mime.
 */
function _tipoAceito(media) {
  if (!media || !media.kind) return null;
  const tipo = TIPOS_ACEITOS[media.kind];
  if (!tipo) return null;
  if (media.rawMessage && media.rawMessage.stickerMessage) return null;
  if (/webp/i.test(String(media.mimetype || ''))) return null;
  return tipo;
}

/** PURO: duração em segundos, quando o WhatsApp informa (vídeo). */
function _duracao(media) {
  const m = (media && media.rawMessage) || {};
  const v = m.videoMessage || m.ptvMessage;
  const s = v && v.seconds != null ? Number(v.seconds) : null;
  return Number.isFinite(s) && s >= 0 ? Math.round(s) : null;
}

/** PURO: estourou a cota? `null` = ainda cabe. Cota ausente = sem limite. */
function _excedeCota(cota, usadas) {
  const limite = cota && cota[COTA_CHAVE];
  if (limite == null) return null;
  const lim = Number(limite);
  if (!Number.isFinite(lim)) return null;
  return usadas >= lim ? { cota: COTA_CHAVE, limite: lim, usado: usadas } : null;
}

/** Promessa com prazo: download pendurado não pode segurar o webhook para sempre. */
function _comPrazo(promessa, ms, oQue) {
  let t;
  return Promise.race([
    Promise.resolve(promessa).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${oQue}: estourou ${ms}ms`)), ms); }),
  ]);
}

/**
 * Credenciais da Evolution desta unidade — do banco, cifradas, nunca do ambiente.
 * Ida CURTA ao banco de propósito: o cliente do pool não pode ficar preso durante um
 * download de vídeo de 45 s.
 */
async function _credenciaisEvolution(tenantId) {
  const linha = await withTenant(tenantId, async (c) => (await c.query(
    'SELECT evolution_instance, evolution_token_enc FROM tenants WHERE id = $1', [tenantId])).rows[0]);
  if (!linha || !linha.evolution_instance) return null;
  const apikey = decrypt(linha.evolution_token_enc);
  return apikey ? { instance: linha.evolution_instance, apikey } : null;
}

/**
 * Os bytes do arquivo. Reaproveita o download que o webhook JÁ fez para a bolha da Caixa de
 * Entrada (msg.media.diskPath) — baixar de novo seria pagar duas vezes pelo mesmo arquivo,
 * e a Evolution não guarda mídia velha. Só cai no download próprio se aquele não existir.
 */
async function _bytes(tenantId, msg, log) {
  const jaEmDisco = msg.media && msg.media.diskPath;
  if (jaEmDisco) {
    try {
      return { buffer: fs.readFileSync(jaEmDisco), mimetype: msg.media.mimetype || null };
    } catch (e) {
      log.warn('ingestao.disco_indisponivel', { tenant_id: tenantId, error: e.message });
    }
  }
  // Ler a credencial pode falhar por si (banco fora do ar, tabela ausente). Isso é uma
  // falha DESTA mídia, não do webhook: vira motivo escrito, não exceção subindo.
  let cred = null;
  try {
    cred = await _credenciaisEvolution(tenantId);
  } catch (e) {
    return { erro: `credencial indisponível: ${e.message}` };
  }
  if (!cred) return { erro: 'sem_credencial_evolution' };

  let ultimo = null;
  for (let i = 1; i <= TENTATIVAS; i += 1) {
    try {
      const saved = await _comPrazo(
        mediaLM.salvarMidia({ tenantId, instance: cred.instance, apikey: cred.apikey, media: msg.media }),
        TIMEOUT_MS, 'download da mídia');
      if (saved && saved.base64) {
        return { buffer: Buffer.from(saved.base64, 'base64'), mimetype: saved.mimetype || null };
      }
      ultimo = new Error('download sem conteúdo');
    } catch (e) {
      ultimo = e;
    }
    if (i < TENTATIVAS) {
      log.warn('ingestao.download_retentando', { tenant_id: tenantId, tentativa: i, error: ultimo.message });
      await new Promise((r) => { setTimeout(r, 800 * i); });   // espera crescente
    }
  }
  return { erro: (ultimo && ultimo.message) || 'download falhou' };
}

/**
 * Confirmação ao professor: um 📌 na mensagem dele. É a única resposta que ele recebe, e
 * por isso é best-effort de verdade — se a Evolution recusar a reação, a mídia JÁ está
 * guardada e perder a confirmação não pode desfazer isso.
 */
async function _confirmar(tenantId, rawBody, log) {
  try {
    const key = rawBody && rawBody.data && rawBody.data.key;
    if (!key || !key.id) return false;
    const cred = await _credenciaisEvolution(tenantId);
    if (!cred) return false;
    const r = await _comPrazo(evolution.sendReaction(cred, key, EMOJI_CONFIRMACAO), TIMEOUT_MS, 'reação');
    if (!r || r.ok === false) {
      log.info('ingestao.confirmacao_falhou', { tenant_id: tenantId, error: r && r.error });
      return false;
    }
    return true;
  } catch (e) {
    log.info('ingestao.confirmacao_falhou', { tenant_id: tenantId, error: e.message });
    return false;
  }
}

/** Grava a linha de recusa (cota/falha). Sem arquivo, com o motivo por escrito. */
async function _gravarRecusa(tenantId, base, situacao, motivo) {
  await withTenant(tenantId, (c) => c.query(
    `INSERT INTO marketing.raw_asset
       (tenant_id, grupo_jid, mensagem_id, remetente_jid, remetente_nome, tipo, mime,
        duracao_seg, situacao, motivo, payload_bruto, recebido_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
     -- Reentrega do mesmo evento não vira segunda recusa. E DO NOTHING (não UPDATE):
     -- uma recusa nunca pode rebaixar uma linha que já foi aceita.
     ON CONFLICT (tenant_id, mensagem_id) WHERE mensagem_id IS NOT NULL DO NOTHING`,
    [tenantId, base.jid, base.mensagemId, base.remetenteJid, base.remetenteNome, base.tipo,
      base.mime, base.duracao, situacao, motivo, JSON.stringify(base.rawBody), base.recebidoEm]));
}

/**
 * Captura uma mídia de grupo como matéria-prima.
 *
 * @param {{id: string}} tenant    unidade dona da instância
 * @param {object} msg             mensagem normalizada pelo webhook (com msg.media)
 * @param {object} rawBody         payload bruto do webhook
 * @returns {Promise<{situacao: string, motivo?: string, id?: string}>} nunca lança
 */
async function capturarMidia(tenant, msg, rawBody, log = logger) {
  const tenantId = tenant && tenant.id;
  if (!tenantId || !msg) return { situacao: 'ignorado', motivo: 'sem_contexto' };

  // Portão 1 — tipo. Antes de qualquer consulta: a esmagadora maioria das mensagens de
  // grupo é texto, e texto não pode custar nem uma ida ao banco.
  const tipo = _tipoAceito(msg.media);
  if (!tipo) return { situacao: 'ignorado', motivo: 'tipo_nao_aceito' };

  const jid = (rawBody && rawBody.data && rawBody.data.key && rawBody.data.key.remoteJid) || null;
  if (!jid || !/@g\.us$/i.test(String(jid))) return { situacao: 'ignorado', motivo: 'nao_e_grupo' };

  try {
    // Portão 2 — o grupo é fonte configurada DESTA unidade? (a RLS garante o "desta")
    const ehFonte = await withTenant(tenantId, async (c) => (await c.query(
      'SELECT 1 FROM marketing.grupo_fonte WHERE tenant_id = $1 AND jid = $2 AND ativo LIMIT 1',
      [tenantId, String(jid)])).rowCount > 0);
    if (!ehFonte) return { situacao: 'ignorado', motivo: 'grupo_nao_e_fonte' };

    // Portão 3 — contratação. Sem o módulo, nem começa.
    try {
      await licenca.garantirModulo(tenantId, MODULO);
    } catch (e) {
      log.info('ingestao.sem_contratacao', { tenant_id: tenantId, motivo: e.motivo || e.message });
      return { situacao: 'ignorado', motivo: 'sem_contratacao' };
    }

    const base = {
      jid: String(jid),
      mensagemId: msg.externalMessageId ? String(msg.externalMessageId) : null,
      remetenteJid: rawBody.data.key.participant || rawBody.data.participant || null,
      remetenteNome: msg.sender || null,
      tipo,
      mime: (msg.media && msg.media.mimetype) || null,
      duracao: _duracao(msg.media),
      rawBody: rawBody || {},
      recebidoEm: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date(),
    };

    // Portão 4 — cota. Recusa ANTES de baixar: cota estourada não gasta banda nem disco.
    const estourou = await withTenant(tenantId, async (c) => {
      const cfg = await c.query('SELECT cota FROM marketing.config_unidade WHERE tenant_id = $1', [tenantId]);
      const cota = (cfg.rows[0] && cfg.rows[0].cota) || {};
      const usadas = (await c.query(
        `SELECT count(*)::int AS n FROM marketing.raw_asset
          WHERE tenant_id = $1 AND situacao = 'pendente_curadoria'
            AND criado_em >= date_trunc('month', now())`, [tenantId])).rows[0].n;
      return _excedeCota(cota, usadas);
    });
    if (estourou) {
      const motivo = `${estourou.cota}: ${estourou.usado}/${estourou.limite}`;
      await _gravarRecusa(tenantId, base, 'cota_excedida', motivo);
      // warn, não info: é matéria-prima que o professor mandou e o sistema recusou.
      log.warn('ingestao.cota_excedida', { tenant_id: tenantId, ...estourou });
      return { situacao: 'cota_excedida', motivo };
    }

    // Portão 5 — os bytes.
    const bytes = await _bytes(tenantId, msg, log);
    if (bytes.erro) {
      await _gravarRecusa(tenantId, base, 'falhou', bytes.erro);
      log.error('ingestao.download_falhou', { tenant_id: tenantId, motivo: bytes.erro });
      return { situacao: 'falhou', motivo: bytes.erro };
    }

    // Portão 6 — dedup por CONTEÚDO. O professor reenvia o mesmo vídeo no dia seguinte
    // ("acho que não foi"): é o mesmo arquivo, uma linha só para curar.
    const sha256 = crypto.createHash('sha256').update(bytes.buffer).digest('hex');
    const jaTemos = await withTenant(tenantId, async (c) => (await c.query(
      'SELECT id FROM marketing.raw_asset WHERE tenant_id = $1 AND sha256 = $2 LIMIT 1',
      [tenantId, sha256])).rows[0]);
    if (jaTemos) {
      // Confirma de novo: ele precisa saber que chegou, mesmo sendo repetido.
      await _confirmar(tenantId, rawBody, log);
      log.info('ingestao.duplicado', { tenant_id: tenantId, sha256, asset_id: jaTemos.id });
      return { situacao: 'duplicado', id: jaTemos.id };
    }

    // O arquivo vai para a pasta DA UNIDADE, com o nome derivado do hash (não do que veio
    // no WhatsApp): mesmo conteúdo = mesmo caminho, então reescrever é inofensivo.
    const ext = tipo === 'imagem' ? 'jpg' : 'mp4';
    const caminho = midia.caminhoMidia(tenantId, `${sha256.slice(0, 16)}.${ext}`, { subpasta: SUBPASTA });
    fs.mkdirSync(path.posix.dirname(caminho), { recursive: true });
    fs.writeFileSync(caminho, bytes.buffer);

    let linha;
    try {
      linha = await withTenant(tenantId, async (c) => (await c.query(
        `INSERT INTO marketing.raw_asset
           (tenant_id, grupo_jid, mensagem_id, remetente_jid, remetente_nome, tipo, mime,
            duracao_seg, tamanho_bytes, sha256, caminho, situacao, payload_bruto, recebido_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pendente_curadoria',$12::jsonb,$13)
         -- Se a MESMA mensagem já tinha caído como 'falhou' ou 'cota_excedida', esta é a
         -- retentativa que deu certo: promove a linha em vez de estourar o índice único.
         ON CONFLICT (tenant_id, mensagem_id) WHERE mensagem_id IS NOT NULL DO UPDATE
           SET situacao = 'pendente_curadoria', motivo = NULL, sha256 = EXCLUDED.sha256,
               caminho = EXCLUDED.caminho, tamanho_bytes = EXCLUDED.tamanho_bytes,
               mime = EXCLUDED.mime
           WHERE marketing.raw_asset.situacao <> 'pendente_curadoria'
         RETURNING id`,
        [tenantId, base.jid, base.mensagemId, base.remetenteJid, base.remetenteNome, base.tipo,
          bytes.mimetype || base.mime, base.duracao, bytes.buffer.length, sha256, caminho,
          JSON.stringify(base.rawBody), base.recebidoEm])).rows[0]);
    } catch (e) {
      // 23505 = corrida no índice de conteúdo: outro processo gravou o mesmo arquivo entre
      // a checagem acima e agora. Não é erro — é o dedup funcionando.
      if (e.code !== '23505') throw e;
      log.info('ingestao.duplicado_na_corrida', { tenant_id: tenantId, sha256 });
      return { situacao: 'duplicado' };
    }
    if (!linha) {   // conflito de mensagem_id numa linha JÁ aceita: nada a fazer
      log.info('ingestao.ja_capturado', { tenant_id: tenantId, mensagem_id: base.mensagemId });
      return { situacao: 'duplicado' };
    }

    await consumo.registrarUso(tenantId, MODULO, consumo.TIPOS.MIDIA_INGERIDA, 1, { ref: linha.id });
    const confirmou = await _confirmar(tenantId, rawBody, log);

    log.info('ingestao.capturado', {
      tenant_id: tenantId, asset_id: linha.id, tipo, bytes: bytes.buffer.length,
      remetente: base.remetenteNome, confirmado: confirmou,
    });
    return { situacao: 'pendente_curadoria', id: linha.id };
  } catch (e) {
    // O webhook segue. Perdemos ESTA mídia — e o log é o que conta isso.
    log.error('ingestao.falhou', { tenant_id: tenantId, error: e.message });
    return { situacao: 'ignorado', motivo: 'erro' };
  }
}

module.exports = {
  capturarMidia, MODULO, COTA_CHAVE, TIPOS_ACEITOS, EMOJI_CONFIRMACAO, SUBPASTA,
  _tipoAceito, _duracao, _excedeCota, _comPrazo,
};
