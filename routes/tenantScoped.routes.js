const express = require("express");
const router = express.Router();
const TenantScopedController = require("../controllers/tenantScoped.controller");
const {
  authenticate,
  requireTenant,
  requireRole,
  requirePermission,
} = require("../middlewares/auth");

// Apply authentication and tenant enforcement to all routes
router.use(authenticate);
router.use(requireTenant);

// Tenant-scoped role assignment (ASU only)
router.post(
  "/tenant/users/assign-role",
  requireRole(["ASU"]),
  TenantScopedController.assignRoleToUserInTenant
);

router.post(
  "/tenant/users/remove-role",
  requireRole(["ASU"]),
  TenantScopedController.removeRoleFromUserInTenant
);

// Tenant-scoped permission management (ASU only)
router.put(
  "/tenant/roles/:id/permissions",
  requireRole(["ASU"]),
  TenantScopedController.assignPermissionsToRoleInTenant
);

// Tenant-scoped data access (ASU only)
router.get(
  "/tenant/users",
  requireRole(["ASU"]),
  TenantScopedController.getUsersInTenant
);

router.get(
  "/tenant/roles",
  requireRole(["ASU"]),
  TenantScopedController.getRolesInTenant
);

router.get(
  "/tenant/permissions",
  requireRole(["ASU"]),
  TenantScopedController.getAvailablePermissions
);

module.exports = router;
