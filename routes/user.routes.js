const express = require("express");
const router = express.Router();
const UserController = require("../controllers/user.controller");
const { authenticate, requireTenant } = require("../middlewares/auth");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");

// Apply tenant enforcement to all routes (authentication is applied globally)
router.use(requireTenant);

// User CRUD operations
router.post(
  "/users",
  defaultPolicyMiddleware.requirePermission("user", "create"),
  UserController.createUser
);
router.get(
  "/users",
  defaultPolicyMiddleware.requirePermission("user", "read"),
  UserController.getAllUsers
);
router.get(
  "/users/:id",
  defaultPolicyMiddleware.requirePermission("user", "read"),
  UserController.getUserById
);
router.put(
  "/users/:id",
  defaultPolicyMiddleware.requirePermission("user", "update"),
  UserController.updateUser
);
router.delete(
  "/users/:id",
  defaultPolicyMiddleware.requirePermission("user", "delete"),
  UserController.deleteUser
);

// User profile operations
router.get(
  "/users/:id/profile",
  defaultPolicyMiddleware.requirePermission("user", "read"),
  UserController.getUserProfile
);
router.put(
  "/users/:id/profile",
  defaultPolicyMiddleware.requirePermission("user", "update"),
  UserController.updateUserProfile
);

// User status management
router.put(
  "/users/:id/status",
  defaultPolicyMiddleware.requirePermission("user", "update"),
  UserController.updateUserStatus
);
router.put(
  "/users/:id/activate",
  defaultPolicyMiddleware.requirePermission("user", "update"),
  UserController.activateUser
);
router.put(
  "/users/:id/deactivate",
  defaultPolicyMiddleware.requirePermission("user", "update"),
  UserController.deactivateUser
);

// User search and filtering
router.get(
  "/users/search",
  defaultPolicyMiddleware.requirePermission("user", "read"),
  UserController.searchUsers
);
router.get(
  "/users/by-email/:email",
  defaultPolicyMiddleware.requirePermission("user", "read"),
  UserController.getUserByEmail
);
router.get(
  "/users/by-tenant/:tenantId",
  defaultPolicyMiddleware.requirePermission("user", "read"),
  UserController.getUsersByTenant
);

// User statistics
router.get(
  "/users/stats",
  defaultPolicyMiddleware.requirePermission("user", "read"),
  UserController.getUserStats
);
router.get(
  "/users/:id/stats",
  defaultPolicyMiddleware.requirePermission("user", "read"),
  UserController.getUserStatsById
);

// Bulk operations
router.post(
  "/users/bulk-create",
  defaultPolicyMiddleware.requirePermission("user", "create"),
  UserController.bulkCreateUsers
);
router.post(
  "/users/bulk-update",
  defaultPolicyMiddleware.requirePermission("user", "update"),
  UserController.bulkUpdateUsers
);
router.post(
  "/users/bulk-delete",
  defaultPolicyMiddleware.requirePermission("user", "delete"),
  UserController.bulkDeleteUsers
);

// User export/import
router.get(
  "/users/export",
  defaultPolicyMiddleware.requirePermission("user", "read"),
  UserController.exportUsers
);
router.post(
  "/users/import",
  defaultPolicyMiddleware.requirePermission("user", "create"),
  UserController.importUsers
);

module.exports = router;
