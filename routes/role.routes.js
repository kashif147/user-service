const express = require("express");
const router = express.Router();
const RoleController = require("../controllers/role.controller");

// Test endpoint for default role assignment
router.post("/test/default-role", RoleController.testDefaultRoleAssignment);

// Initialize roles (one-time setup)
router.post("/roles/initialize", RoleController.initializeRoles);

// Role CRUD operations
router.post("/roles", RoleController.createRole);
router.get("/roles", RoleController.getAllRoles);
router.get("/roles/:id", RoleController.getRoleById);
router.put("/roles/:id", RoleController.updateRole);
router.delete("/roles/:id", RoleController.deleteRole);

// Role permissions
router.put("/roles/:id/permissions", RoleController.updateRolePermissions);

// User role management
router.post("/users/assign-role", RoleController.assignRoleToUser);
router.post("/users/remove-role", RoleController.removeRoleFromUser);
router.get("/users/:userId/roles", RoleController.getUserRoles);
router.get("/users/:userId/permissions", RoleController.getUserPermissions);
router.get("/users/:userId/has-role/:roleCode", RoleController.hasRole);
router.get("/users", RoleController.getAllUsers);

// Get users by role
router.get("/roles/:roleId/users", RoleController.getUsersByRole);

module.exports = router;
