const express = require("express");
const router = express.Router();
const TenantController = require("../controllers/tenant.controller");
const TenantBrandingController = require("../controllers/tenantBranding.controller");
const { brandingAssetUploadMw } = require("../middlewares/upload.mw");
const { authenticate } = require("../middlewares/auth");
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
  "/tenants/branding/placeholders",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantBrandingController.getBrandingPlaceholders
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

router.patch(
  "/tenants/:id/organisation-profile",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantController.updateOrganisationProfile
);

router.patch(
  "/tenants/:id/branding",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantController.updateBranding
);

router.patch(
  "/tenants/:id/regional-settings",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantController.updateRegionalSettings
);

router.post(
  "/tenants/:id/branding/assets",
  defaultPolicyAdapter.middleware("tenant", "update"),
  brandingAssetUploadMw,
  TenantBrandingController.uploadBrandingAsset
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
