const express = require("express");
const router = express.Router();
const RoleController = require("../controllers/role.controller");
const {
  authenticate,
  requireTenant,
  requireRole,
  requirePermission,
} = require("../middlewares/auth.mw");
const PERMISSIONS = require("@membership/shared-constants/permissions");

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
router.get(
  "/roles",
  requirePermission([PERMISSIONS.ROLE.READ]),
  RoleController.getAllRoles
);
router.get(
  "/roles/:id",
  requirePermission([PERMISSIONS.ROLE.READ]),
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
  requirePermission([PERMISSIONS.USER.READ]),
  RoleController.getUserRoles
);
router.get(
  "/users/:userId/permissions",
  requirePermission([PERMISSIONS.USER.READ]),
  RoleController.getUserPermissions
);
router.get(
  "/users/:userId/has-role/:roleCode",
  requirePermission([PERMISSIONS.USER.READ]),
  RoleController.hasRole
);
router.get(
  "/users",
  requirePermission([PERMISSIONS.USER.READ]),
  RoleController.getAllUsers
);

// Get users by role
router.get(
  "/roles/:roleId/users",
  requirePermission([PERMISSIONS.USER.READ]),
  RoleController.getUsersByRole
);

module.exports = router;
