const express = require("express");
const router = express.Router();
const RoleController = require("../controllers/role.controller");
const { AppError } = require("../errors/AppError");

// NEW WAY: Use centralized policy system
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
// MIGRATED ROUTES USING POLICY MIDDLEWARE
// ============================================================================

// Test endpoint for default role assignment (Super User only)
// OLD: requireRole(["SU"])
// NEW: policy.middleware("role", "write") - equivalent to SU level access
router.post(
  "/test/default-role",
  policy.middleware("role", "write"),
  RoleController.testDefaultRoleAssignment
);

// Initialize roles (Super User only)
// OLD: requireRole(["SU"])
// NEW: policy.middleware("role", "admin") - equivalent to SU level access
router.post(
  "/roles/initialize",
  policy.middleware("role", "admin"),
  RoleController.initializeRoles
);

// ============================================================================
// ROLE CRUD OPERATIONS
// ============================================================================

// Get all roles
// OLD: requirePermission(["role:read"])
// NEW: policy.middleware("role", "read")
router.get(
  "/roles",
  policy.middleware("role", "read"),
  RoleController.getAllRoles
);

// Get role by ID
router.get(
  "/roles/:id",
  policy.middleware("role", "read"),
  RoleController.getRoleById
);

// Create new role
// OLD: requireRole(["SU", "GS"])
// NEW: policy.middleware("role", "write")
router.post(
  "/roles",
  policy.middleware("role", "write"),
  RoleController.createRole
);

// Update role
// OLD: requireRole(["SU", "GS"])
// NEW: policy.middleware("role", "write")
router.put(
  "/roles/:id",
  policy.middleware("role", "write"),
  RoleController.updateRole
);

// Delete role
// OLD: requireRole(["SU"])
// NEW: policy.middleware("role", "delete")
router.delete(
  "/roles/:id",
  policy.middleware("role", "delete"),
  RoleController.deleteRole
);

// ============================================================================
// ROLE ASSIGNMENT OPERATIONS
// ============================================================================

// Assign role to user
// OLD: requireRole(["SU", "GS", "DGS"])
// NEW: policy.middleware("role", "write")
router.post(
  "/roles/assign",
  policy.middleware("role", "write"),
  RoleController.assignRoleToUser
);

// Remove role from user
// OLD: requireRole(["SU", "GS", "DGS"])
// NEW: policy.middleware("role", "write")
router.post(
  "/roles/remove",
  policy.middleware("role", "write"),
  RoleController.removeRoleFromUser
);

// Get user roles
// OLD: requirePermission(["role:read"])
// NEW: policy.middleware("role", "read")
router.get(
  "/roles/user/:userId",
  policy.middleware("role", "read"),
  RoleController.getUserRoles
);

// ============================================================================
// ROLE HIERARCHY OPERATIONS
// ============================================================================

// Get role hierarchy
// OLD: requirePermission(["role:read"])
// NEW: policy.middleware("role", "read")
router.get(
  "/roles/hierarchy",
  policy.middleware("role", "read"),
  RoleController.getRoleHierarchy
);

// Update role hierarchy
// OLD: requireRole(["SU"])
// NEW: policy.middleware("role", "admin")
router.put(
  "/roles/hierarchy",
  policy.middleware("role", "admin"),
  RoleController.updateRoleHierarchy
);

// ============================================================================
// BULK OPERATIONS
// ============================================================================

// Bulk assign roles
// OLD: requireRole(["SU", "GS"])
// NEW: policy.middleware("role", "write")
router.post(
  "/roles/bulk-assign",
  policy.middleware("role", "write"),
  RoleController.bulkAssignRoles
);

// Bulk remove roles
// OLD: requireRole(["SU", "GS"])
// NEW: policy.middleware("role", "write")
router.post(
  "/roles/bulk-remove",
  policy.middleware("role", "write"),
  RoleController.bulkRemoveRoles
);

// ============================================================================
// ADMIN OPERATIONS
// ============================================================================

// Get role statistics
// OLD: requireRole(["SU", "GS"])
// NEW: policy.middleware("role", "read")
router.get(
  "/roles/stats",
  policy.middleware("role", "read"),
  RoleController.getRoleStats
);

// Export roles
// OLD: requireRole(["SU", "GS"])
// NEW: policy.middleware("role", "read")
router.get(
  "/roles/export",
  policy.middleware("role", "read"),
  RoleController.exportRoles
);

// Import roles
// OLD: requireRole(["SU"])
// NEW: policy.middleware("role", "admin")
router.post(
  "/roles/import",
  policy.middleware("role", "admin"),
  RoleController.importRoles
);

// ============================================================================
// POLICY-BASED CONTROLLER EXAMPLES
// ============================================================================

// Example: Controller using policy evaluation for complex logic
async function examplePolicyController(req, res) {
  const token = req.headers.authorization?.substring(7);

  // Check multiple permissions at once
  const requests = [
    { token, resource: "role", action: "read" },
    { token, resource: "role", action: "write" },
    { token, resource: "role", action: "delete" },
  ];

  const results = await policy.evaluateBatch(requests);

  const permissions = {
    canRead: results[0].success,
    canWrite: results[1].success,
    canDelete: results[2].success,
  };

  // Use permissions to determine what data to return
  const roleData = {
    id: req.params.id,
    name: "Example Role",
    // Only include sensitive data if user has write permission
    ...(permissions.canWrite && { sensitiveData: "secret" }),
  };

  res.json({
    role: roleData,
    permissions,
  });
}

// Example: Conditional endpoint based on permissions
router.get("/roles/:id/details", async (req, res, next) => {
  const token = req.headers.authorization?.substring(7);

  // Check if user can access detailed role information
  const result = await policy.evaluate(token, "role", "read");

  if (!result.success) {
    return next(AppError.forbidden("Access denied"));
  }

  // User has access, proceed with detailed information
  const roleDetails = {
    id: req.params.id,
    name: "Detailed Role",
    permissions: ["read", "write"],
    users: ["user1", "user2"],
    // Only include audit data for admin users
    ...(result.user.roles.some((r) => r.code === "SU") && {
      auditData: { created: "2024-01-01", modified: "2024-01-02" },
    }),
  };

  res.json(roleDetails);
});

module.exports = router;
