'use strict';
//
// media.js — ADR-016 P0. Serve os arquivos de mídia recebidos, do disco.
// Autenticado: o token precisa ter acesso ao tenant da URL (requireTenantAccess).
// Mídia é servida pelo dashboard via proxy (o browser não alcança o LM direto).
//
const fs = require('fs');
const express = require('express');
const { authenticate } = require('../auth');
const { requireTenantAccess } = require('../rbac');
const mediaLib = require('../media');
const logger = require('../logger');

const router = express.Router();
const READ_ROLES = ['TENANT_ADMIN', 'RECEPCAO', 'VISUALIZADOR'];

// GET /media/:tenantId/:filename — serve o arquivo (content-type por extensão).
router.get('/:tenantId/:filename', authenticate, requireTenantAccess(READ_ROLES), (req, res) => {
  try {
    const full = mediaLib.resolverArquivo(req.params.tenantId, req.params.filename);
    if (!full) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Type', mediaLib.contentType(req.params.filename));
    res.setHeader('Cache-Control', 'private, max-age=86400');
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    logger.error('media.serve_error', { tenant_id: req.params.tenantId, error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
