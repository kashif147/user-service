const express = require("express");
const router = express.Router();
const UserController = require("../controllers/user.controller");
const { azureB2CBasicAuth } = require("../middlewares/basicAuth.middleware");

// Azure B2C API connector: Basic auth only, no JWT chain (AZURE_B2C_INTEGRATION.md).
// Mounted in routes/index.js BEFORE every other "/api" router: those routers run
// router.use(authenticate, ...) for any /api/* path, which rejected the connector with
// 400 "Authorization header required" before this chain ran. Declares only this one route,
// so mounting it first exposes nothing else. The connector's tenant is resolved from the
// B2C client id (helpers/b2cConnectorTenant.js), never from the body or headers.

// Protected with Basic Auth (B2C_API_USERNAME / B2C_API_PASSWORD; fails closed outside development/test)
// Wrapped to ensure no errors escape to global handler
router.post(
  "/users/validate",
  // CRITICAL: Set Content-Type header BEFORE processing
  (req, res, next) => {
    res.setHeader('Content-Type', 'application/json');
    next();
  },
  azureB2CBasicAuth(), // Basic Auth (see middlewares/basicAuth.middleware.js)
  async (req, res, next) => {
    try {
      await UserController.validateUser(req, res, next);
    } catch (error) {
      // Final safety net - ensure we never return unhandled errors to Azure B2C
      console.error("FATAL: validateUser error escaped:", error);
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).json({
          version: "1.0.0",
          action: "ShowBlockPage",
          userMessage: "An error occurred during validation. Please try again.",
        });
      }
    }
  }
);

module.exports = router;
