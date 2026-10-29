const bizLogger = require("../config/bizLogger.js");

/**
 * Phase A / A14 - temporary write freeze on still-global (shared) metadata.
 *
 * Lookups and lookup types have no owning tenant until the Phase D/E tenant cutover, so a write by
 * any tenant's user (SU included - every tenant has an SU role) would change every tenant's data.
 * Until cutover their whole write surface answers 423 GLOBAL_DATA_FROZEN. Reads are unchanged.
 *
 * There is no exemption: not for SU/ASU of any tenant, internal callers, headers, body flags or token
 * claims. Necessary platform changes go through reviewed platform scripts below the API.
 * Ops rollback only: GLOBAL_DATA_WRITES=open (exact value) in the service environment. Any other
 * value, or unset, keeps the freeze.
 *
 * Mount per write route BEFORE the policy check, so a frozen write never reaches the PDP, the
 * controller, the database or a cache invalidation.
 *
 * Phase B / Z5: the platform-owned surfaces (lookups, lookup types, countries, contact types, contacts, the
 * permission catalogue) no longer mount freezeGlobalWrites directly: requirePlatformPermission(code,
 * { mode: "route-enforce", freeze: resource }) authorizes FIRST and applies this freeze only afterwards:
 *   tenant actor (no platform claim)   -> 423 while frozen (unchanged), 403 PLATFORM_AUTHORITY_REQUIRED if
 *                                         GLOBAL_DATA_WRITES=open (the switch is never a tenant-access bypass)
 *   platform actor without permission  -> 403 PLATFORM_AUTHORITY_REQUIRED
 *   platform actor with the permission -> 423 while frozen; the controller only when GLOBAL_DATA_WRITES=open
 * GLOBAL_DATA_WRITES=open therefore only lifts the freeze after platform authorization has succeeded.
 */
const GLOBAL_DATA_FROZEN = "GLOBAL_DATA_FROZEN";
const GLOBAL_DATA_FROZEN_MESSAGE = "Shared metadata is temporarily read-only during tenant migration";

const isGlobalDataFrozen = () => process.env.GLOBAL_DATA_WRITES !== "open";

/** The 423 refusal itself (log line + body). Also used by the Z5 platform guard (requirePlatformPermission). */
function refuseFrozenWrite(req, res, resource) {
  const correlationId = req.correlationId || req.headers["x-correlation-id"];
  bizLogger.business("Global data write refused (frozen)", {
    eventType: "global_data.write_frozen",
    resource,
    method: req.method,
    tenantId: req.ctx?.tenantId,
    userId: req.ctx?.userId,
    correlationId,
  });
  return res.status(423).json({
    success: false,
    error: { message: GLOBAL_DATA_FROZEN_MESSAGE, code: GLOBAL_DATA_FROZEN, status: 423, resource },
    ...(correlationId ? { correlationId } : {}),
  });
}

const freezeGlobalWrites = (resource) => function globalDataFreeze(req, res, next) {
  if (!isGlobalDataFrozen()) return next();
  return refuseFrozenWrite(req, res, resource);
};

module.exports = {
  GLOBAL_DATA_FROZEN,
  GLOBAL_DATA_FROZEN_MESSAGE,
  isGlobalDataFrozen,
  freezeGlobalWrites,
  refuseFrozenWrite,
};
