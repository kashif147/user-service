const express = require("express");
const router = express.Router();
const TenantController = require("../controllers/tenant.controller");
const { authenticate, requirePermission } = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");

// Apply authentication to all routes
router.use(authenticate);

// Tenant CRUD operations (Super User only for create/update/delete)
router.post(
  "/tenants",
  defaultPolicyAdapter.middleware("tenant", "create"),
  TenantController.createTenant
);

router.get(
  "/tenants",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantController.getAllTenants
);

router.get(
  "/tenants/:id",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantController.getTenantById
);

router.get(
  "/tenants/code/:code",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantController.getTenantByCode
);

router.get(
  "/tenants/domain/:domain",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantController.getTenantByDomain
);

router.put(
  "/tenants/:id",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantController.updateTenant
);

router.delete(
  "/tenants/:id",
  defaultPolicyAdapter.middleware("tenant", "delete"),
  TenantController.deleteTenant
);

// Tenant management operations
router.get(
  "/tenants/:id/stats",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantController.getTenantStats
);

router.put(
  "/tenants/:id/status",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantController.updateTenantStatus
);

// Authentication Connection Management Routes
router.post(
  "/tenants/:id/auth-connections",
  defaultPolicyAdapter.middleware("tenant", "admin"),
  TenantController.addAuthenticationConnection
);

router.get(
  "/tenants/:id/auth-connections",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantController.getAuthenticationConnections
);

router.put(
  "/tenants/:id/auth-connections/:connectionId",
  defaultPolicyAdapter.middleware("tenant", "admin"),
  TenantController.updateAuthenticationConnection
);

router.delete(
  "/tenants/:id/auth-connections/:connectionId",
  defaultPolicyAdapter.middleware("tenant", "admin"),
  TenantController.removeAuthenticationConnection
);

module.exports = router;
