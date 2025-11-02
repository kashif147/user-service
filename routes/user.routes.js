const express = require("express");
const router = express.Router();
const UserController = require("../controllers/user.controller");
const { authenticate, requireTenant } = require("../middlewares/auth");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");
const { azureB2CBasicAuth } = require("../middlewares/basicAuth.middleware");

// User registration and login endpoints (no auth required)
router.post(
  "/users/register",
  defaultPolicyMiddleware.requirePermission("user", "create"),
  UserController.handleRegistration
);
router.post("/users/login", UserController.handleLogin);

// Public user validation endpoint for Azure B2C custom policies
// Protected with Basic Auth (optional - set B2C_API_USERNAME and B2C_API_PASSWORD)
// Wrapped to ensure no errors escape to global handler (Azure B2C requires HTTP 200 always)
router.post(
  "/users/validate",
  azureB2CBasicAuth(), // Basic Auth middleware (no-op if password not configured)
  async (req, res, next) => {
    try {
      await UserController.validateUser(req, res, next);
    } catch (error) {
      // Final safety net - ensure we never return 400/500 to Azure B2C
      console.error("FATAL: validateUser error escaped:", error);
      if (!res.headersSent) {
        return res.status(200).json({
          version: "1.0.0",
          action: "ValidationError",
          userMessage: "An error occurred during validation. Please try again.",
        });
      }
    }
  }
);

// Protected user management endpoints (require authentication)
router.use(authenticate);
router.use(requireTenant);

router.get(
  "/users/by-email/:email",
  defaultPolicyMiddleware.requirePermission("user", "read"),
  UserController.getUserByEmail
);

module.exports = router;
