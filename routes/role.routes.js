const express = require("express");
const router = express.Router();
const RoleController = require("../controllers/role.controller");
const {
  authenticate,
  requireTenant,
  requireRole,
  requirePermission,
} = require("../middlewares/auth");
// Note: Permissions are now fetched from API endpoints as needed

// Apply authentication and tenant enforcement to all routes
router.use(authenticate);
router.use(requireTenant);

// Test endpoint for default role assignment (Super User only)
router.post(
  "/test/default-role",
  requireRole(["SU"]),
  RoleController.testDefaultRoleAssignment
);

// Initialize roles (Super User only)
router.post(
  "/roles/initialize",
  requireRole(["SU"]),
  RoleController.initializeRoles
);

// Role CRUD operations
router.post("/roles", requireRole(["SU"]), RoleController.createRole);
router.get("/roles", requireRole(["SU", "ASU"]), RoleController.getAllRoles);
router.get(
  "/roles/:id",
  requireRole(["SU", "ASU"]),
  RoleController.getRoleById
);
router.put("/roles/:id", requireRole(["SU"]), RoleController.updateRole);
router.delete("/roles/:id", requireRole(["SU"]), RoleController.deleteRole);

// Role permissions (Super User only - ASU uses tenant-scoped endpoint)
router.put(
  "/roles/:id/permissions",
  requireRole(["SU"]),
  RoleController.updateRolePermissions
);

// User role management (Super User only - ASU uses tenant-scoped endpoint)
router.post(
  "/users/assign-role",
  requireRole(["SU"]),
  RoleController.assignRolesToUser
);
router.post(
  "/users/remove-role",
  requireRole(["SU"]),
  RoleController.removeRoleFromUser
);

// Batch role management (Super User only)
router.post(
  "/users/assign-roles-batch",
  requireRole(["SU"]),
  RoleController.assignRolesToUser
);
router.post(
  "/users/remove-roles-batch",
  requireRole(["SU"]),
  RoleController.removeRolesFromUser
);

// User information endpoints (ASU can read users in their tenant)
router.get(
  "/users/:userId/roles",
  requireRole(["SU", "ASU"]),
  RoleController.getUserRoles
);
router.get(
  "/users/:userId/permissions",
  requireRole(["SU", "ASU"]),
  RoleController.getUserPermissions
);
router.get(
  "/users/:userId/has-role/:roleCode",
  requireRole(["SU", "ASU"]),
  RoleController.hasRole
);
router.get("/users", requireRole(["SU", "ASU"]), RoleController.getAllUsers);

// Get users by role (ASU can read users in their tenant)
router.get(
  "/roles/:roleId/users",
  requireRole(["SU", "ASU"]),
  RoleController.getUsersByRole
);

module.exports = router;
