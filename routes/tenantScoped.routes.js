const express = require("express");
const router = express.Router();
const TenantScopedController = require("../controllers/tenantScoped.controller");
const {
  authenticate,
  requireTenant,
} = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");

// Apply authentication and tenant enforcement to all routes
router.use(authenticate);
router.use(requireTenant);

// Tenant-scoped role assignment (ASU only)
router.post(
  "/tenant/users/assign-role",
  defaultPolicyAdapter.middleware("role", "write"),
  TenantScopedController.assignRoleToUserInTenant
);

router.post(
  "/tenant/users/remove-role",
  defaultPolicyAdapter.middleware("role", "write"),
  TenantScopedController.removeRoleFromUserInTenant
);

// Tenant-scoped permission management (ASU only)
router.put(
  "/tenant/roles/:id/permissions",
  defaultPolicyAdapter.middleware("role", "admin"),
  TenantScopedController.assignPermissionsToRoleInTenant
);

// Tenant-scoped data access (ASU only)
router.get(
  "/tenant/users",
  defaultPolicyAdapter.middleware("user", "read"),
  TenantScopedController.getUsersInTenant
);

router.get(
  "/tenant/roles",
  defaultPolicyAdapter.middleware("role", "read"),
  TenantScopedController.getRolesInTenant
);

router.get(
  "/tenant/permissions",
  defaultPolicyAdapter.middleware("permission", "read"),
  TenantScopedController.getAvailablePermissions
);

module.exports = router;
