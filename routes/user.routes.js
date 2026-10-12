const express = require("express");
const router = express.Router();
const UserController = require("../controllers/user.controller");
const { authenticate, requireTenant, tenantContextWarn } = require("../middlewares/auth");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");

// Phase 1C-2A: POST /users/register and /users/login were removed. Their handlers resolve the
// tenant from req.body.tenantId (caller-controlled), so they must not be reachable here; the
// gateway also denies both paths. Local CRM sign-in is Entra/B2C only.

// POST /users/validate (Azure B2C API connector) lives in routes/b2cConnector.routes.js, mounted
// in routes/index.js before every other "/api" router so their JWT router.use() cannot intercept it.

// Protected user management endpoints (require authentication)
router.use(authenticate, tenantContextWarn);
router.use(requireTenant);

router.get(
  "/users/by-email/:email",
  defaultPolicyMiddleware.requirePermission("user", "read"),
  UserController.getUserByEmail
);

module.exports = router;
