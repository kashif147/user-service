/**
 * Migration Guide: From Old Auth Middleware to Centralized Policy System
 *
 * This file demonstrates how to migrate from the old authentication/authorization
 * middleware to the new centralized RBAC policy evaluation system.
 */

const express = require("express");
const router = express.Router();
const RoleController = require("../controllers/role.controller");

// OLD WAY: Multiple middleware imports and complex role/permission checks
// const {
//   authenticate,
//   requireTenant,
//   requireRole,
//   requirePermission,
// } = require("../middlewares/auth");

// NEW WAY: Single policy client import
const PolicyClient = require("../sdks/node-policy-client");

// Initialize policy client
const policy = new PolicyClient(
  process.env.POLICY_SERVICE_URL || "http://localhost:3000",
  {
    timeout: process.env.POLICY_TIMEOUT || 5000,
    retries: process.env.POLICY_RETRIES || 3,
    cacheTimeout: process.env.POLICY_CACHE_TIMEOUT || 300000,
  }
);

// ============================================================================
// MIGRATION EXAMPLES
// ============================================================================

// OLD WAY: Multiple middleware layers
// router.use(authenticate);
// router.use(requireTenant);
// router.post("/test/default-role", requireRole(["SU"]), RoleController.testDefaultRoleAssignment);

// NEW WAY: Single policy middleware
router.post(
  "/test/default-role",
  policy.middleware("role", "write"), // Equivalent to requireRole(["SU"])
  RoleController.testDefaultRoleAssignment
);

// OLD WAY: Complex role and permission checks
// router.post("/roles/initialize", requireRole(["SU"]), RoleController.initializeRoles);

// NEW WAY: Simple resource-action based protection
router.post(
  "/roles/initialize",
  policy.middleware("role", "admin"), // Equivalent to requireRole(["SU"])
  RoleController.initializeRoles
);

// OLD WAY: Permission-based protection
// router.get("/roles", requirePermission(["role:read"]), RoleController.getAllRoles);

// NEW WAY: Resource-action based protection
router.get(
  "/roles",
  policy.middleware("role", "read"), // Equivalent to requirePermission(["role:read"])
  RoleController.getAllRoles
);

// OLD WAY: Multiple middleware for different operations
// router.post("/roles", authenticate, requireTenant, requireRole(["SU", "GS"]), RoleController.createRole);
// router.put("/roles/:id", authenticate, requireTenant, requireRole(["SU", "GS"]), RoleController.updateRole);
// router.delete("/roles/:id", authenticate, requireTenant, requireRole(["SU"]), RoleController.deleteRole);

// NEW WAY: Consistent policy middleware
router.post(
  "/roles",
  policy.middleware("role", "write"),
  RoleController.createRole
);

router.put(
  "/roles/:id",
  policy.middleware("role", "write"),
  RoleController.updateRole
);

router.delete(
  "/roles/:id",
  policy.middleware("role", "delete"),
  RoleController.deleteRole
);

// ============================================================================
// MANUAL AUTHORIZATION CHECKS
// ============================================================================

// OLD WAY: Manual role/permission checking in controllers
async function oldWayController(req, res) {
  const token = req.headers.authorization?.substring(7);

  // Manual role checking
  if (
    !req.ctx.roles.includes("SU") &&
    !req.ctx.permissions.includes("role:write")
  ) {
    return res.status(403).json({ error: "Access denied" });
  }

  // Manual tenant checking
  if (!req.ctx.tenantId) {
    return res.status(400).json({ error: "Tenant context required" });
  }

  // Handle request
  res.json({ success: true });
}

// NEW WAY: Policy-based authorization in controllers
async function newWayController(req, res) {
  const token = req.headers.authorization?.substring(7);

  // Single policy evaluation
  const result = await policy.evaluate(token, "role", "write");

  if (!result.success) {
    return res.status(403).json({
      error: "Access denied",
      reason: result.reason,
    });
  }

  // result.user contains user info and tenantId
  // Handle request
  res.json({ success: true });
}

// ============================================================================
// BATCH PERMISSION CHECKS
// ============================================================================

// OLD WAY: Multiple individual checks
async function oldWayBatchCheck(req, res) {
  const token = req.headers.authorization?.substring(7);

  // Multiple individual checks
  const canReadRoles = req.ctx.permissions.includes("role:read");
  const canWriteRoles = req.ctx.permissions.includes("role:write");
  const canDeleteRoles = req.ctx.permissions.includes("role:delete");

  res.json({
    permissions: {
      canReadRoles,
      canWriteRoles,
      canDeleteRoles,
    },
  });
}

// NEW WAY: Single batch evaluation
async function newWayBatchCheck(req, res) {
  const token = req.headers.authorization?.substring(7);

  // Single batch request
  const requests = [
    { token, resource: "role", action: "read" },
    { token, resource: "role", action: "write" },
    { token, resource: "role", action: "delete" },
  ];

  const results = await policy.evaluateBatch(requests);

  res.json({
    permissions: {
      canReadRoles: results[0].success,
      canWriteRoles: results[1].success,
      canDeleteRoles: results[2].success,
    },
  });
}

// ============================================================================
// TENANT ISOLATION
// ============================================================================

// OLD WAY: Manual tenant enforcement
// router.use(authenticate);
// router.use(requireTenant);

// NEW WAY: Automatic tenant isolation in policy middleware
// The policy middleware automatically sets req.user and req.tenantId
// No need for separate tenant middleware

// ============================================================================
// ERROR HANDLING
// ============================================================================

// OLD WAY: Complex error handling for different auth failures
function oldWayErrorHandling(error, req, res, next) {
  if (error.tokenError) {
    return res.status(401).json({ error: "Invalid token" });
  }
  if (error.missingTenant) {
    return res.status(400).json({ error: "Missing tenant context" });
  }
  if (error.forbidden) {
    return res.status(403).json({ error: "Insufficient permissions" });
  }
  next(error);
}

// NEW WAY: Simplified error handling
function newWayErrorHandling(error, req, res, next) {
  if (error.message === "Authorization check failed") {
    return res.status(500).json({ error: "Authorization service unavailable" });
  }
  next(error);
}

// ============================================================================
// MIGRATION CHECKLIST
// ============================================================================

/*
Migration Steps:

1. ✅ Install dependencies (redis, jsonwebtoken) - Already done
2. ✅ Copy node-policy-client.js to your service - Already done
3. ✅ Add environment variables - Already done
4. ✅ Initialize PolicyClient - Done in this example
5. 🔄 Replace authenticate middleware with policy.middleware()
6. 🔄 Replace requireRole middleware with policy.middleware()
7. 🔄 Replace requirePermission middleware with policy.middleware()
8. 🔄 Replace manual role checks with policy.evaluate()
9. 🔄 Update error handling for policy responses
10. 🔄 Test all protected endpoints
11. 🔄 Remove old auth middleware imports

Benefits After Migration:
- ✅ Simplified code: No more complex role/permission logic
- ✅ Consistent security: Same authorization across all services
- ✅ Better performance: Cached policy decisions
- ✅ Easy maintenance: Update policies without code changes
- ✅ Audit trail: Complete logging of authorization decisions
*/

module.exports = router;
