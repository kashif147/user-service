const express = require("express");
const router = express.Router();
const Controller = require("../controllers/internalTenantCreditorProfile.controller");

/** PDP P3 (O6 / N3): organisation creditor details for server-side document generation. Mounted at /internal
 * (NOT under /api - the gateway does not proxy it) and gated by its own service secret
 * (INTERNAL_TENANT_PROFILE_SECRET; unset = every call 403). See the controller header. */
router.get(
  "/tenants/:tenantId/creditor-profile",
  Controller.requireTenantProfileSecret,
  Controller.getCreditorProfile
);

module.exports = router;
