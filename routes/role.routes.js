const express = require("express");
const router = express.Router();
const RoleController = require("../controllers/role.controller");
const {
  authenticate,
  requireRole,
  requirePermission,
} = require("../middlewares/auth.mw");

// Apply authentication to all routes
router.use(authenticate);

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
router.get(
  "/roles",
  requirePermission(["read:roles"]),
  RoleController.getAllRoles
);
router.get(
  "/roles/:id",
  requirePermission(["read:roles"]),
  RoleController.getRoleById
);
router.put("/roles/:id", requireRole(["SU"]), RoleController.updateRole);
router.delete("/roles/:id", requireRole(["SU"]), RoleController.deleteRole);

// Role permissions (Super User only)
router.put(
  "/roles/:id/permissions",
  requireRole(["SU"]),
  RoleController.updateRolePermissions
);

// User role management (Super User only)
router.post(
  "/users/assign-role",
  requireRole(["SU"]),
  RoleController.assignRoleToUser
);
router.post(
  "/users/remove-role",
  requireRole(["SU"]),
  RoleController.removeRoleFromUser
);

// User information endpoints
router.get(
  "/users/:userId/roles",
  requirePermission(["read:users"]),
  RoleController.getUserRoles
);
router.get(
  "/users/:userId/permissions",
  requirePermission(["read:users"]),
  RoleController.getUserPermissions
);
router.get(
  "/users/:userId/has-role/:roleCode",
  requirePermission(["read:users"]),
  RoleController.hasRole
);
router.get(
  "/users",
  requirePermission(["read:users"]),
  RoleController.getAllUsers
);

// Get users by role
router.get(
  "/roles/:roleId/users",
  requirePermission(["read:users"]),
  RoleController.getUsersByRole
);

module.exports = router;
