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
 */
const GLOBAL_DATA_FROZEN = "GLOBAL_DATA_FROZEN";
const GLOBAL_DATA_FROZEN_MESSAGE = "Shared metadata is temporarily read-only during tenant migration";

const isGlobalDataFrozen = () => process.env.GLOBAL_DATA_WRITES !== "open";

const freezeGlobalWrites = (resource) => (req, res, next) => {
  if (!isGlobalDataFrozen()) return next();
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
};

module.exports = {
  GLOBAL_DATA_FROZEN,
  GLOBAL_DATA_FROZEN_MESSAGE,
  isGlobalDataFrozen,
  freezeGlobalWrites,
};
