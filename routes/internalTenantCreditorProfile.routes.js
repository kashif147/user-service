const express = require("express");
const { createServiceSignatureAuth } = require("../middlewares/serviceSignatureAuth");
const { getCreditorProfile } = require("../controllers/internalTenantCreditorProfile.controller");

/**
 * PDP P3 (O6 / N3): organisation creditor details for server-side document generation (profile-service).
 * Mounted at /internal (NOT under /api - the gateway does not proxy it). The only authority is the p5-svc-sig/1
 * signature (middlewares/serviceSignatureAuth.js, operation tenant_creditor_profile, caller profile-service,
 * mode TENANT_CREDITOR_SERVICE_AUTH_MODE, default off = 503). No user token, no shared secret.
 */
function createCreditorProfileRouter(deps = {}) {
  const router = express.Router({ caseSensitive: true, strict: true });
  router.get(
    "/tenants/:tenantId/creditor-profile",
    createServiceSignatureAuth("tenant_creditor_profile", deps),
    getCreditorProfile
  );
  return router;
}

module.exports = createCreditorProfileRouter();
module.exports.createCreditorProfileRouter = createCreditorProfileRouter;
