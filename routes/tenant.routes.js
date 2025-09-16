const express = require("express");
const router = express.Router();
const TenantController = require("../controllers/tenant.controller");
const {
  authenticate,
  requireRole,
  requirePermission,
} = require("../middlewares/auth");

// Apply authentication to all routes
router.use(authenticate);

// Tenant CRUD operations (Super User only for create/update/delete)
router.post("/tenants", requireRole(["SU"]), TenantController.createTenant);

router.get("/tenants", requireRole(["SU"]), TenantController.getAllTenants);

router.get("/tenants/:id", requireRole(["SU"]), TenantController.getTenantById);

router.get(
  "/tenants/code/:code",
  requireRole(["SU"]),
  TenantController.getTenantByCode
);

router.get(
  "/tenants/domain/:domain",
  requireRole(["SU"]),
  TenantController.getTenantByDomain
);

router.put("/tenants/:id", requireRole(["SU"]), TenantController.updateTenant);

router.delete(
  "/tenants/:id",
  requireRole(["SU"]),
  TenantController.deleteTenant
);

// Tenant management operations
router.get(
  "/tenants/:id/stats",
  requireRole(["SU"]),
  TenantController.getTenantStats
);

router.put(
  "/tenants/:id/status",
  requireRole(["SU"]),
  TenantController.updateTenantStatus
);

// Authentication Connection Management Routes
router.post(
  "/tenants/:id/auth-connections",
  requireRole(["SU"]),
  TenantController.addAuthenticationConnection
);

router.get(
  "/tenants/:id/auth-connections",
  requireRole(["SU"]),
  TenantController.getAuthenticationConnections
);

router.put(
  "/tenants/:id/auth-connections/:connectionId",
  requireRole(["SU"]),
  TenantController.updateAuthenticationConnection
);

router.delete(
  "/tenants/:id/auth-connections/:connectionId",
  requireRole(["SU"]),
  TenantController.removeAuthenticationConnection
);

module.exports = router;
