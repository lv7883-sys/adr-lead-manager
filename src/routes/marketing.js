'use strict';
//
// marketing.js — CONFIGURAÇÃO DA CAPTURA DE MÍDIA, PELA TELA.
//
//   GET    /tenant/:tenantId/marketing/ingestao          estado: contratou? tem grupo? entrou o quê?
//   GET    /tenant/:tenantId/marketing/grupos-candidatos grupos que a unidade tem, para escolher
//   POST   /tenant/:tenantId/marketing/grupos-fonte      { jid, nome }
//   DELETE /tenant/:tenantId/marketing/grupos-fonte/:jid
//
// POR QUÊ UMA TELA, E NÃO UM INSERT
//   Cada unidade tem o SEU grupo de professores. Um jid escrito à mão numa migração é
//   configuração de uma unidade fingindo ser código — e quem sabe qual é o grupo é a
//   recepção, não quem faz deploy.
//
// A RECEPÇÃO NÃO DIGITA JID. `grupos-candidatos` devolve os grupos que a unidade já tem,
// com QUEM FALA em cada um — que é como uma pessoa reconhece o próprio grupo. O nome do
// grupo não existe no nosso banco (o WhatsApp não o manda na mensagem), então quem o tiver
// em cache pode exibi-lo; sem ele, a lista de participantes resolve.
//
// DUAS CHAVES, NÃO UMA: a unidade precisa do módulo CONTRATADO **e** de um grupo escolhido.
// Faltando qualquer uma, a captura não roda — e a tela diz qual das duas falta, porque
// "configurei e não funciona" sem explicação é o pior resultado possível.
//
const express = require('express');
const { authenticate } = require('../auth');
const { requireTenantAccess } = require('../rbac');
const { withTenant } = require('../db');
const logger = require('../logger');
const licenca = require('../plataforma/licenca');
const ingestao = require('../marketing/ingestao');

const router = express.Router();
const READ_ROLES = ['TENANT_ADMIN', 'RECEPCAO', 'VISUALIZADOR'];
const WRITE_ROLES = ['TENANT_ADMIN', 'RECEPCAO'];   // a recepção configura a própria unidade
const MAX_GRUPOS = 20;

/** PURO: o jid é de grupo do WhatsApp? Único formato aceito — telefone aqui capturaria cliente. */
function _jidDeGrupo(raw) {
  const j = String(raw || '').trim();
  return /^[0-9]{5,30}@g\.us$/.test(j) ? j : null;
}

function _falha(res, err, evento, tenantId) {
  logger.error(evento, { tenant_id: tenantId, error: err && err.message });
  return res.status(500).json({ error: 'falha_interna' });
}

// ── estado da captura: o que a tela mostra no topo ─────────────────────────────────────
router.get('/:tenantId/marketing/ingestao', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  const tenantId = req.tenantId;
  try {
    let contratado = false;
    let motivoContrato = null;
    try {
      await licenca.garantirModulo(tenantId, ingestao.MODULO);
      contratado = true;
    } catch (e) {
      motivoContrato = e.motivo || 'sem contratação';
    }

    const dados = await withTenant(tenantId, async (c) => {
      const grupos = (await c.query(
        `SELECT jid, nome, ativo, criado_em FROM marketing.grupo_fonte
          WHERE tenant_id = $1 ORDER BY ativo DESC, nome NULLS LAST`, [tenantId])).rows;
      const cota = ((await c.query(
        'SELECT cota FROM marketing.config_unidade WHERE tenant_id = $1', [tenantId])).rows[0] || {}).cota || {};
      const mes = (await c.query(
        `SELECT situacao, count(*)::int AS n FROM marketing.raw_asset
          WHERE tenant_id = $1 AND criado_em >= date_trunc('month', now())
          GROUP BY situacao`, [tenantId])).rows;
      const ultima = (await c.query(
        `SELECT criado_em, tipo, remetente_nome, situacao FROM marketing.raw_asset
          WHERE tenant_id = $1 ORDER BY criado_em DESC LIMIT 1`, [tenantId])).rows[0] || null;
      return { grupos, cota, mes, ultima };
    });

    const porSituacao = { pendente_curadoria: 0, cota_excedida: 0, falhou: 0 };
    for (const m of dados.mes) porSituacao[m.situacao] = m.n;
    const temGrupo = dados.grupos.some((g) => g.ativo);

    // A pergunta que a tela responde: está capturando? Se não, POR QUÊ — com as duas chaves
    // separadas, porque são decisões de pessoas diferentes (contratar é comercial, escolher
    // o grupo é da recepção).
    res.json({
      tenant_id: tenantId,
      capturando: contratado && temGrupo,
      contratado,
      motivo_contrato: motivoContrato,
      tem_grupo: temGrupo,
      falta: !contratado ? 'modulo_nao_contratado' : (!temGrupo ? 'nenhum_grupo_escolhido' : null),
      grupos: dados.grupos,
      cota_mensal: dados.cota[ingestao.COTA_CHAVE] != null ? Number(dados.cota[ingestao.COTA_CHAVE]) : null,
      mes: porSituacao,
      ultima: dados.ultima,
    });
  } catch (err) {
    // 42P01 = migração 175 ainda não aplicada neste banco: dizer isso é mais útil que 500 seco.
    if (err && err.code === '42P01') return res.status(503).json({ error: 'ingestao_nao_instalada' });
    return _falha(res, err, 'marketing.ingestao.estado_error', tenantId);
  }
});

// ── candidatos: os grupos que a unidade tem, para a recepção reconhecer o seu ───────────
router.get('/:tenantId/marketing/grupos-candidatos', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  const tenantId = req.tenantId;
  try {
    const rows = await withTenant(tenantId, async (c) => (await c.query(
      `SELECT cv.external_id AS jid,
              count(m.id)::int AS mensagens,
              max(m.received_at) AS ultima_em,
              (array_agg(DISTINCT m.sender) FILTER (WHERE m.sender IS NOT NULL AND m.sender <> ''))[1:8] AS quem_fala,
              count(DISTINCT m.sender)::int AS pessoas
         FROM conversations cv
         JOIN messages m ON m.conversation_id = cv.id
        WHERE cv.tenant_id = $1 AND cv.conversation_kind = 'GROUP'
          AND m.received_at >= now() - interval '90 days'
        GROUP BY cv.external_id
        HAVING count(m.id) > 0
        ORDER BY max(m.received_at) DESC
        LIMIT 30`, [tenantId])).rows);

    const jaEscolhidos = await withTenant(tenantId, async (c) => new Set((await c.query(
      'SELECT jid FROM marketing.grupo_fonte WHERE tenant_id = $1', [tenantId])).rows.map((r) => r.jid)));

    res.json({
      tenant_id: tenantId,
      // `quem_fala` é o que permite reconhecer o grupo sem o nome: o WhatsApp não manda o
      // assunto do grupo na mensagem, então o nome só existe para quem o buscou e guardou.
      grupos: rows.map((r) => ({ ...r, ja_escolhido: jaEscolhidos.has(r.jid) })),
    });
  } catch (err) {
    if (err && err.code === '42P01') return res.status(503).json({ error: 'ingestao_nao_instalada' });
    return _falha(res, err, 'marketing.grupos_candidatos.error', tenantId);
  }
});

// ── escolher um grupo ──────────────────────────────────────────────────────────────────
router.post('/:tenantId/marketing/grupos-fonte', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const tenantId = req.tenantId;
  const jid = _jidDeGrupo(req.body && req.body.jid);
  const nome = typeof (req.body && req.body.nome) === 'string' ? req.body.nome.trim().slice(0, 120) : null;
  if (!jid) return res.status(400).json({ error: 'jid_invalido', detalhe: 'só grupo do WhatsApp (…@g.us)' });

  try {
    const row = await withTenant(tenantId, async (c) => {
      const n = (await c.query(
        'SELECT count(*)::int AS n FROM marketing.grupo_fonte WHERE tenant_id = $1 AND ativo', [tenantId])).rows[0].n;
      if (n >= MAX_GRUPOS) { const e = new Error('limite'); e.limite = true; throw e; }
      return (await c.query(
        `INSERT INTO marketing.grupo_fonte (tenant_id, jid, nome) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, jid)
           DO UPDATE SET nome = COALESCE(EXCLUDED.nome, marketing.grupo_fonte.nome),
                         ativo = true, atualizado_em = now()
         RETURNING jid, nome, ativo, criado_em`, [tenantId, jid, nome])).rows[0];
    });
    logger.info('marketing.grupo_fonte.escolhido', { tenant_id: tenantId, jid, by: req.tenantRole });
    res.json({ ok: true, grupo: row });
  } catch (err) {
    if (err && err.limite) return res.status(400).json({ error: 'limite_de_grupos', limite: MAX_GRUPOS });
    if (err && err.code === '42P01') return res.status(503).json({ error: 'ingestao_nao_instalada' });
    return _falha(res, err, 'marketing.grupo_fonte.escolher_error', tenantId);
  }
});

// ── parar de capturar de um grupo ──────────────────────────────────────────────────────
router.delete('/:tenantId/marketing/grupos-fonte/:jid', authenticate, requireTenantAccess(WRITE_ROLES), async (req, res) => {
  const tenantId = req.tenantId;
  const jid = _jidDeGrupo(req.params.jid);
  if (!jid) return res.status(400).json({ error: 'jid_invalido' });
  try {
    const n = await withTenant(tenantId, async (c) => (await c.query(
      'DELETE FROM marketing.grupo_fonte WHERE tenant_id = $1 AND jid = $2', [tenantId, jid])).rowCount);
    if (!n) return res.status(404).json({ error: 'nao_encontrado' });
    // A mídia JÁ capturada continua: tirar o grupo para de capturar daqui para frente, não
    // apaga o que os professores mandaram. (E a aplicação nem tem DELETE em raw_asset.)
    logger.info('marketing.grupo_fonte.removido', { tenant_id: tenantId, jid, by: req.tenantRole });
    res.json({ ok: true });
  } catch (err) {
    if (err && err.code === '42P01') return res.status(503).json({ error: 'ingestao_nao_instalada' });
    return _falha(res, err, 'marketing.grupo_fonte.remover_error', tenantId);
  }
});

module.exports = router;
module.exports._jidDeGrupo = _jidDeGrupo;
module.exports.MAX_GRUPOS = MAX_GRUPOS;
