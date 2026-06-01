'use strict';

const { pool, withTenant } = require('./db');
const { isUuid } = require('./validation');
const logger = require('./logger');

// users não é tenant-scoped (sem RLS) — leitura direta pelo pool.
async function getUser(userId) {
  const { rows } = await pool.query(
    'SELECT id, is_platform_admin FROM users WHERE id = $1',
    [userId]
  );
  return rows[0] || null;
}

/**
 * Middleware de autorização por (tenant, role) — ADR-004, Decisão 4.
 * Deve rodar APÓS `authenticate` (precisa de req.user.sub = id do usuário).
 *
 *  - sem usuário autenticado            -> 401
 *  - tenantId inválido                  -> 400
 *  - PLATFORM_ADMIN                     -> impersonation auditada, acessa qualquer tenant
 *  - papel do user no tenant ∈ allowed  -> segue (req.tenantRole preenchido)
 *  - caso contrário                     -> 403
 *
 * O papel por tenant é resolvido no servidor (frescor imediato), sob RLS.
 */
function requireTenantRole(allowedRoles) {
  return async (req, res, next) => {
    const tenantId = req.params.tenantId;
    const userId = req.user?.sub;
    const log = logger.child({ tenant_id: tenantId, subject: userId ?? null });

    if (!userId) return res.status(401).json({ error: 'unauthenticated' });
    if (!isUuid(tenantId)) return res.status(400).json({ error: 'invalid tenantId' });

    try {
      const user = await getUser(userId);
      if (!user) return res.status(403).json({ error: 'forbidden' });

      // PLATFORM_ADMIN cruza a fronteira de tenant via impersonation auditada.
      if (user.is_platform_admin) {
        const action = `${req.method} ${req.originalUrl}`;
        await pool.query(
          'INSERT INTO impersonation_audit (platform_user_id, tenant_id, action) VALUES ($1, $2, $3)',
          [userId, tenantId, action]
        );
        req.tenantId = tenantId;
        req.tenantRole = 'PLATFORM_ADMIN';
        req.impersonation = true;
        log.info('rbac.impersonation', { action });
        return next();
      }

      // Demais papéis: resolvidos por (user, tenant) sob o contexto RLS do tenant.
      const role = await withTenant(tenantId, async (c) => {
        const { rows } = await c.query(
          'SELECT role FROM tenant_members WHERE user_id = $1 AND tenant_id = $2',
          [userId, tenantId]
        );
        return rows[0]?.role || null;
      });

      if (!role || !allowedRoles.includes(role)) {
        log.warn('rbac.forbidden', { role, allowed: allowedRoles });
        return res.status(403).json({ error: 'forbidden' });
      }

      req.tenantId = tenantId;
      req.tenantRole = role;
      req.impersonation = false;
      return next();
    } catch (err) {
      log.error('rbac.error', { error: err.message });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

module.exports = { requireTenantRole };
