'use strict';
//
// boas-vindas.js — ADR-050 (E17-03/04). Rotas da régua de boas-vindas.
//
//   Recepção (aba Boas-vindas da Caixa de Entrada)
//     GET  /tenant/:tenantId/boas-vindas/fila                       mensagens prontas agora
//     GET  /tenant/:tenantId/boas-vindas/toques/:toqueId            uma mensagem (inclui as futuras em aberto)
//     POST /tenant/:tenantId/boas-vindas/toques/:toqueId/enviar     { texto?, com_anexo? }
//     POST /tenant/:tenantId/boas-vindas/toques/:toqueId/descartar  { motivo?, por? }
//     POST /tenant/:tenantId/boas-vindas/alertas/:alertaId/dispensar { observacao?, por? }   (E17-05)
//
//   Gestão da unidade (tela de configuração)
//     GET  /tenant/:tenantId/boas-vindas/config
//     PUT  /tenant/:tenantId/boas-vindas/config                     { modo, alerta_dias, variaveis }
//     POST /tenant/:tenantId/boas-vindas/copiar-modelo              { slug, por? }
//     POST /tenant/:tenantId/boas-vindas/etapas                     { nome, ancora, quando, repeticoes, texto_titular, texto_responsavel, contrato_curto, por? }
//     PUT  /tenant/:tenantId/boas-vindas/etapas-ordem               { ids: [...] }   (lista completa, na nova ordem)
//     PUT  /tenant/:tenantId/boas-vindas/etapas/:etapaId            { nome, texto_titular, texto_responsavel, ativo, contrato_curto, ancora, quando, repeticoes, por? }
//     DELETE /tenant/:tenantId/boas-vindas/etapas/:etapaId          só mensagem sem histórico
//     POST /tenant/:tenantId/boas-vindas/etapas/:etapaId/anexo      multipart: file (+ por)
//     DELETE /tenant/:tenantId/boas-vindas/etapas/:etapaId/anexo
//
// O arquivo anexado é servido pela rota /media já existente (o dashboard faz o proxy).
//
const express = require('express');
const multer = require('multer');
const { authenticate } = require('../auth');
const { requireTenantAccess } = require('../rbac');
const { isUuid } = require('../validation');
const logger = require('../logger');
const recepcao = require('../boasVindas/recepcao');
const configuracao = require('../boasVindas/configuracao');
const R = require('../boasVindasRegua');

const router = express.Router();
const READ_ROLES = ['TENANT_ADMIN', 'RECEPCAO', 'VISUALIZADOR'];
const WRITE_ROLES = ['TENANT_ADMIN', 'RECEPCAO'];
const ADMIN_ROLES = ['TENANT_ADMIN'];
// O maior anexo aceito (documento, 100 MB); o limite por tipo é validado na regra.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: R.ANEXO.documento.maxBytes } });

const _por = (req) => String((req.body && req.body.por) || (req.query && req.query.por) || req.tenantRole || '').slice(0, 80) || null;

function _falha(res, err, evento, tenantId) {
  if (err && err.status === 422) return res.status(422).json({ error: err.codigo || 'invalido', erros: err.erros || [] });
  if (err && err.status === 404) return res.status(404).json({ error: err.message });
  logger.error(evento, { tenant_id: tenantId, error: err && err.message });
  return res.status(500).json({ error: 'falha_interna' });
}

const _uuid = (...nomes) => (req, res, next) => {
  for (const n of nomes) if (!isUuid(req.params[n])) return res.status(400).json({ error: `invalid_${n}` });
  return next();
};

// ── Recepção ────────────────────────────────────────────────────────────────────────────────────
router.get('/:tenantId/boas-vindas/fila', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  try {
    const conversationId = isUuid(req.query.conversation_id) ? req.query.conversation_id : null;
    const itens = await recepcao.listarFila(req.tenantId, { limite: Number(req.query.limite) || 200, conversationId });
    // Alertas de cliente que não começou só na lista geral (não no cartão de uma conversa).
    const alertas = conversationId ? [] : await recepcao.listarAlertas(req.tenantId);
    res.json({ itens, total: itens.length, alertas });
  } catch (err) { _falha(res, err, 'boas_vindas.fila.error', req.tenantId); }
});

router.get('/:tenantId/boas-vindas/toques/:toqueId', authenticate, requireTenantAccess(READ_ROLES), _uuid('toqueId'), async (req, res) => {
  try {
    const item = await recepcao.detalhe(req.tenantId, req.params.toqueId);
    if (!item) return res.status(404).json({ error: 'mensagem_nao_encontrada' });
    res.json({ item });
  } catch (err) { _falha(res, err, 'boas_vindas.toque.error', req.tenantId); }
});

router.post('/:tenantId/boas-vindas/toques/:toqueId/enviar', authenticate, requireTenantAccess(WRITE_ROLES), _uuid('toqueId'), async (req, res) => {
  try {
    const b = req.body || {};
    const out = await recepcao.enviar(req.tenantId, req.params.toqueId, {
      texto: typeof b.texto === 'string' ? b.texto : undefined,
      comAnexo: b.com_anexo !== false && b.com_anexo !== 'false',
      sender: req.tenantRole,
    });
    if (out.erro) return res.status(out.status || 400).json({ error: out.erro });
    res.json(out);
  } catch (err) { _falha(res, err, 'boas_vindas.enviar.error', req.tenantId); }
});

router.post('/:tenantId/boas-vindas/toques/:toqueId/descartar', authenticate, requireTenantAccess(WRITE_ROLES), _uuid('toqueId'), async (req, res) => {
  try {
    const out = await recepcao.descartar(req.tenantId, req.params.toqueId, { motivo: req.body && req.body.motivo, por: _por(req) });
    if (out.erro) return res.status(out.status || 400).json({ error: out.erro });
    res.json(out);
  } catch (err) { _falha(res, err, 'boas_vindas.descartar.error', req.tenantId); }
});

router.post('/:tenantId/boas-vindas/alertas/:alertaId/dispensar', authenticate, requireTenantAccess(WRITE_ROLES), _uuid('alertaId'), async (req, res) => {
  try {
    const b = req.body || {};
    const r = await recepcao.dispensarAlerta(req.tenantId, req.params.alertaId, { observacao: b.observacao, por: _por(req) });
    if (r.erro) return res.status(r.status).json({ error: r.erro });
    res.json(r);
  } catch (err) { _falha(res, err, 'boas_vindas.alerta_dispensar.error', req.tenantId); }
});

// ── Gestão da unidade ───────────────────────────────────────────────────────────────────────────
router.get('/:tenantId/boas-vindas/config', authenticate, requireTenantAccess(READ_ROLES), async (req, res) => {
  try { res.json(await configuracao.obter(req.tenantId)); } catch (err) { _falha(res, err, 'boas_vindas.config.error', req.tenantId); }
});

router.put('/:tenantId/boas-vindas/config', authenticate, requireTenantAccess(ADMIN_ROLES), async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await configuracao.salvarConfig(req.tenantId, {
      modo: b.modo, alertaDias: b.alerta_dias, variaveis: b.variaveis,
    }));
  } catch (err) { _falha(res, err, 'boas_vindas.config_salvar.error', req.tenantId); }
});

router.post('/:tenantId/boas-vindas/copiar-modelo', authenticate, requireTenantAccess(ADMIN_ROLES), async (req, res) => {
  try {
    const slug = String((req.body && req.body.slug) || '');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return res.status(400).json({ error: 'invalid_slug' });
    res.json(await configuracao.copiarModelo(req.tenantId, slug, _por(req)));
  } catch (err) { _falha(res, err, 'boas_vindas.copiar_modelo.error', req.tenantId); }
});

router.post('/:tenantId/boas-vindas/etapas', authenticate, requireTenantAccess(ADMIN_ROLES), async (req, res) => {
  try { res.json(await configuracao.criarEtapa(req.tenantId, req.body || {}, _por(req))); }
  catch (err) { _falha(res, err, 'boas_vindas.etapa_criar.error', req.tenantId); }
});

router.put('/:tenantId/boas-vindas/etapas-ordem', authenticate, requireTenantAccess(ADMIN_ROLES), async (req, res) => {
  try {
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || !ids.every(isUuid)) return res.status(400).json({ error: 'invalid_ids' });
    res.json(await configuracao.reordenarEtapas(req.tenantId, ids));
  } catch (err) { _falha(res, err, 'boas_vindas.etapa_ordem.error', req.tenantId); }
});

router.delete('/:tenantId/boas-vindas/etapas/:etapaId', authenticate, requireTenantAccess(ADMIN_ROLES), _uuid('etapaId'), async (req, res) => {
  try { res.json(await configuracao.apagarEtapa(req.tenantId, req.params.etapaId, _por(req))); }
  catch (err) { _falha(res, err, 'boas_vindas.etapa_apagar.error', req.tenantId); }
});

router.put('/:tenantId/boas-vindas/etapas/:etapaId', authenticate, requireTenantAccess(ADMIN_ROLES), _uuid('etapaId'), async (req, res) => {
  try { res.json(await configuracao.salvarEtapa(req.tenantId, req.params.etapaId, req.body || {}, _por(req))); }
  catch (err) { _falha(res, err, 'boas_vindas.etapa.error', req.tenantId); }
});

router.post('/:tenantId/boas-vindas/etapas/:etapaId/anexo', authenticate, requireTenantAccess(ADMIN_ROLES), _uuid('etapaId'), (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(422).json({ error: 'anexo_invalido', erros: ['Arquivo acima do limite do WhatsApp.'] });
    if (err) return res.status(400).json({ error: 'upload_falhou' });
    return next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    res.json(await configuracao.anexar(req.tenantId, req.params.etapaId, req.file, _por(req)));
  } catch (err) { _falha(res, err, 'boas_vindas.anexo.error', req.tenantId); }
});

router.delete('/:tenantId/boas-vindas/etapas/:etapaId/anexo', authenticate, requireTenantAccess(ADMIN_ROLES), _uuid('etapaId'), async (req, res) => {
  try { res.json(await configuracao.removerAnexo(req.tenantId, req.params.etapaId, _por(req))); }
  catch (err) { _falha(res, err, 'boas_vindas.anexo_remover.error', req.tenantId); }
});

module.exports = router;
