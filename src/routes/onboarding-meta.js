'use strict';
//
// onboarding-meta.js — endpoints de onboarding de Página do Facebook por-tenant.
//   GET /onboarding/meta/start    (autenticado: service JWT) -> { url } do dialog FLB
//   GET /onboarding/meta/callback (público; protegido pelo state HMAC) -> 302 ao dashboard
//   GET /onboarding/meta/status   (autenticado) -> estado legível da conexão
//
// O /start é chamado server-to-server pelo dashboard (que já gateia por gerente) e
// devolve a URL; o dashboard 302 o BROWSER pra ela. Nenhum segredo trafega no client.
//
const express = require('express');
const { authenticate } = require('../auth');
const { isUuid } = require('../validation');
const onb = require('../onboardingMeta');
const logger = require('../logger');

const router = express.Router();

// Acrescenta params de status à return_to e redireciona o browser de volta ao dashboard.
function redirectBack(res, returnTo, params) {
  if (!returnTo) {
    return res.status(200).type('text/html')
      .send('<p>Onboarding Meta finalizado. Pode fechar esta aba.</p>');
  }
  const u = new URL(returnTo);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return res.redirect(302, u.toString());
}

// GET /meta/start?tenant=<uuid>&return_to=<dashboard url>
router.get('/meta/start', authenticate, async (req, res) => {
  const tenantId = String(req.query.tenant || '');
  const returnTo = String(req.query.return_to || '');
  if (!isUuid(tenantId)) return res.status(400).json({ error: 'tenant inválido (uuid esperado)' });
  if (!returnTo) return res.status(400).json({ error: 'return_to obrigatório' });
  try {
    const url = await onb.buildStartUrl({ tenantId, returnTo });
    return res.json({ url });
  } catch (e) {
    if (e.code === 'env_missing') {
      logger.error('meta.onboarding.env_missing', { env: e.envName });
      return res.status(500).json({ error: `configuração ausente no servidor: ${e.envName}` });
    }
    if (e.code === 'bad_return_to') return res.status(400).json({ error: 'return_to não permitido' });
    logger.error('meta.onboarding.start_error', { error: e.message });
    return res.status(500).json({ error: 'falha ao iniciar onboarding' });
  }
});

// GET /meta/callback?code=...&state=...   (ou ?error=access_denied&state=... se cancelado)
router.get('/meta/callback', async (req, res) => {
  const { code, state, error: fbError } = req.query;
  if (fbError) {
    logger.warn('meta.onboarding.user_denied', { error: String(fbError) });
    return redirectBack(res, onb.returnToFromState(String(state || '')), { meta: 'erro', motivo: 'cancelado' });
  }
  if (!code || !state) return res.status(400).type('text/plain').send('parâmetros ausentes');
  try {
    const r = await onb.handleCallback({ code: String(code), state: String(state) });
    // Inscrição leadgen falha NÃO parece conexão saudável: status distinto, re-tentável.
    return redirectBack(res, r.returnTo, {
      meta: r.subscribed ? 'ok' : 'sub_pendente',
      pagina: r.pageName || '',
    });
  } catch (e) {
    logger.error('meta.onboarding.callback_error', { error: e.message, code: e.code });
    return redirectBack(res, onb.returnToFromState(String(state || '')), { meta: 'erro', motivo: e.code || 'falha' });
  }
});

// GET /meta/status?tenant=<uuid>
router.get('/meta/status', authenticate, async (req, res) => {
  const tenantId = String(req.query.tenant || '');
  if (!isUuid(tenantId)) return res.status(400).json({ error: 'tenant inválido (uuid esperado)' });
  try {
    return res.json(await onb.connectionStatus(tenantId));
  } catch (e) {
    logger.error('meta.onboarding.status_error', { error: e.message });
    return res.status(500).json({ error: 'falha ao consultar status' });
  }
});

module.exports = router;
