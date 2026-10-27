const { AppError } = require("../errors/AppError");
const { cacheTenant } = require("../services/lookupCacheService");

/**
 * Phase A / A-3 review: lookup / lookup-type / country reads need a TRUSTED tenant.
 *
 * requireTenant only checks that req.ctx.tenantId is truthy, so a signed token carrying a placeholder
 * tenant ("default", "unknown", "system", ...) or a malformed one passed it and was served the shared
 * (global until Phase D/E) reference rows. This guard applies the same rule as the lookup cache keys
 * (cacheTenant) and answers with requireTenant's 400 shape. Mount it per route (after the
 * authenticate/requireTenant chain), never via router.use: a router-level use here would run for every
 * /api request that passes through the router.
 */
const requireTrustedTenant = (req, res, next) => {
  if (cacheTenant(req.ctx?.tenantId)) return next();
  const authError = AppError.badRequest("Tenant context required", {
    authError: true,
    missingTenant: true,
  });
  return res.status(authError.status).json({
    error: {
      message: authError.message,
      code: authError.code,
      status: authError.status,
      authError: authError.authError,
      missingTenant: authError.missingTenant,
    },
  });
};

module.exports = { requireTrustedTenant };
