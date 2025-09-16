const express = require("express");
const router = express.Router();
const RoleController = require("../controllers/role.controller");
const { authenticate, requireTenant } = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");

// Apply authentication and tenant enforcement to all routes
router.use(authenticate);
router.use(requireTenant);

// Test endpoint for default role assignment (Super User only)
router.post(
  "/test/default-role",
  defaultPolicyAdapter.middleware("role", "admin"),
  RoleController.testDefaultRoleAssignment
);

// Initialize roles (Super User only)
router.post(
  "/roles/initialize",
  defaultPolicyAdapter.middleware("role", "admin"),
  RoleController.initializeRoles
);

// Role CRUD operations
router.post(
  "/roles",
  defaultPolicyAdapter.middleware("role", "create"),
  RoleController.createRole
);
router.get(
  "/roles",
  defaultPolicyAdapter.middleware("role", "read"),
  RoleController.getAllRoles
);
router.get(
  "/roles/:id",
  defaultPolicyAdapter.middleware("role", "read"),
  RoleController.getRoleById
);
router.put(
  "/roles/:id",
  defaultPolicyAdapter.middleware("role", "update"),
  RoleController.updateRole
);
router.delete(
  "/roles/:id",
  defaultPolicyAdapter.middleware("role", "delete"),
  RoleController.deleteRole
);

// Role permissions (Super User only - ASU uses tenant-scoped endpoint)
router.put(
  "/roles/:id/permissions",
  defaultPolicyAdapter.middleware("role", "admin"),
  RoleController.updateRolePermissions
);

// User role management (Super User only - ASU uses tenant-scoped endpoint)
router.post(
  "/users/assign-role",
  defaultPolicyAdapter.middleware("role", "admin"),
  RoleController.assignRolesToUser
);
router.post(
  "/users/remove-role",
  defaultPolicyAdapter.middleware("role", "admin"),
  RoleController.removeRoleFromUser
);

// Batch role management (Super User only)
router.post(
  "/users/assign-roles-batch",
  defaultPolicyAdapter.middleware("role", "admin"),
  RoleController.assignRolesToUser
);
router.post(
  "/users/remove-roles-batch",
  defaultPolicyAdapter.middleware("role", "admin"),
  RoleController.removeRolesFromUser
);

// User information endpoints (ASU can read users in their tenant)
router.get(
  "/users/:userId/roles",
  defaultPolicyAdapter.middleware("role", "read"),
  RoleController.getUserRoles
);
router.get(
  "/users/:userId/permissions",
  defaultPolicyAdapter.middleware("role", "read"),
  RoleController.getUserPermissions
);
router.get(
  "/users/:userId/has-role/:roleCode",
  defaultPolicyAdapter.middleware("role", "read"),
  RoleController.hasRole
);
router.get(
  "/users",
  defaultPolicyAdapter.middleware("user", "read"),
  RoleController.getAllUsers
);

// Get users by role (ASU can read users in their tenant)
router.get(
  "/roles/:roleId/users",
  defaultPolicyAdapter.middleware("role", "read"),
  RoleController.getUsersByRole
);

module.exports = router;
