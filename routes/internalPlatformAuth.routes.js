const express = require("express");
const router = express.Router();
const InternalPlatformAuthController = require("../controllers/internalPlatformAuth.controller");

/** Phase B / Z5 (D4): central platform-authorization check for non-user services. Mounted at
 * /internal (NOT under /api - the gateway does not proxy it) and gated by its own service secret
 * (PLATFORM_AUTH_CHECK_SECRET; unset = every call 403). See the controller header. */
router.post(
  "/platform-auth/check",
  InternalPlatformAuthController.requirePlatformAuthCheckSecret,
  InternalPlatformAuthController.checkPlatformPermission
);

module.exports = router;
