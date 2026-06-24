'use strict';

// ============================================================================
// Surface A (ADR-022) — ingestão do evento canônico de progressão.
// Endpoint TENANT-IGNORANTE: o adapter carimba o evento com `id_unidade_extranet`
// e NÃO conhece tenant (ADR §8.1/§8.2). O tenant é resolvido aqui via
// `extranet_unit_map` — SEM fallback: unidade fora do mapa = evento ÓRFÃO,
// rejeitado (422) e logado, nunca atribuído a Valinhos por default.
//
// Auth serviço-a-serviço (ADR-005): Bearer JWT com role 'service'.
// ============================================================================

const express = require('express');
const { authenticate } = require('../auth');
const { pool, withTenant } = require('../db');
const { processarEvento } = require('../eventosProgressao');
const logger = require('../logger');

const router = express.Router();

function requireService(req, res, next) {
  const roles = Array.isArray(req.user?.roles)
    ? req.user.roles : (req.user?.role ? [req.user.role] : []);
  if (!roles.includes('service')) {
    return res.status(403).json({ error: 'service token required' });
  }
  return next();
}

router.post('/eventos-progressao', authenticate, requireService, async (req, res) => {
  const ev = req.body || {};
  const unidade = String(ev.id_unidade_extranet || '').trim();
  if (!unidade) return res.status(400).json({ error: 'id_unidade_extranet required' });

  // Resolve tenant FORA do withTenant: extranet_unit_map é global (sem RLS), lido
  // antes de saber o tenant. Órfão → rejeita + loga, nunca default.
  let tenantId;
  try {
    const r = await pool.query(
      'SELECT tenant_id FROM extranet_unit_map WHERE id_unidade_extranet = $1 AND ativo = true',
      [unidade]);
    if (!r.rowCount) {
      logger.warn('eventos.evento_orfao', { id_unidade_extranet: unidade, tipo: ev.tipo });
      return res.status(422).json({ error: 'evento_orfao', id_unidade_extranet: unidade });
    }
    tenantId = r.rows[0].tenant_id;
  } catch (err) {
    logger.error('eventos.resolve_tenant_error', { id_unidade_extranet: unidade, error: err.message });
    return res.status(500).json({ error: 'internal error' });
  }

  try {
    const out = await withTenant(tenantId, (c) => processarEvento(c, { tenantId, evento: ev }));
    if (out.status === 'invalid') return res.status(400).json({ error: 'evento inválido', reason: out.reason });
    logger.info('eventos.progressao', {
      tenant_id: tenantId, tipo: ev.tipo, resultado: out.resultado, lead_id: out.lead_id || null, match: out.match,
    });
    return res.json({ ok: true, ...out });
  } catch (err) {
    logger.error('eventos.progressao_error', { tenant_id: tenantId, tipo: ev.tipo, error: err.message });
    return res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
