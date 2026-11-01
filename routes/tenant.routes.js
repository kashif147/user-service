const express = require("express");
const router = express.Router();
const TenantController = require("../controllers/tenant.controller");
const TenantBrandingController = require("../controllers/tenantBranding.controller");
const { brandingAssetUploadMw } = require("../middlewares/upload.mw");
const {
  authenticate,
  requireTenant,
  requireTenantPathAccess,
  tenantContextWarn,
} = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");
// Phase B: POST /tenants is enforced platform authorization (Z5). Code / domain lookups are organisation
// locators and stay tenant / login-locator scoped (owner decision, Z7): they keep a shadow observer only and
// never grant platform:tenant:read:any access.
const { observePlatformPermission, requirePlatformPermission } = require("../middlewares/requirePlatformPermission");
// Phase B / Z6: cross-tenant tenant administration by a platform principal. Each shared route below is
// registered twice: `platform(...)` first (platform principal: exact platform permission, explicit :id target),
// then the UNCHANGED tenant chain (tenant actors - legacy SU "*", ASU, ordinary users: own tenant only), reached
// via next("route") whenever the caller carries no verified platform claim. See middlewares/platformTenantAdmin.js.
const { platformTenantAdmin } = require("../middlewares/platformTenantAdmin");
// P5 / D6: tenant lifecycle (delete / decommission / status) is platform-only - tenant actors (ASU included) are
// refused on their own tenant too. See middlewares/tenantLifecycleGuard.js.
const { refuseTenantLifecycle, refuseTenantLifecycleFields } = require("../middlewares/tenantLifecycleGuard");
const READ_ANY = "platform:tenant:read:any";
const UPDATE_ANY = "platform:tenant:update:any";
const DELETE_ANY = "platform:tenant:delete:any";
const CONNECTIONS_ANY = "platform:tenant:auth-connections:manage:any";
const platform = (method, path, guard, ...handlers) => router[method](path, guard, ...handlers);

// Apply authentication to all routes
router.use(authenticate, tenantContextWarn);

// Tenant CRUD operations (Super User only for create/update/delete)
router.post(
  "/tenants",
  // Phase B / Z5: creating a tenant is a PLATFORM action - platform authority only (legacy SU / "*" / ASU no
  // longer pass; the tenant PDP is not consulted).
  requirePlatformPermission("platform:tenant:create", { mode: "route-enforce" }),
  TenantController.createTenant
);

platform("get", "/tenants", platformTenantAdmin(READ_ANY), TenantController.getAllTenants);
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

platform("get", "/tenants/:id", platformTenantAdmin(READ_ANY, { target: "id" }), TenantController.getTenantById);
router.get(
  "/tenants/:id",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantController.getTenantById
);

router.get(
  "/tenants/code/:code",
  observePlatformPermission("platform:tenant:read:any"),
  requireTenant, // Phase 1C-2B: non-SU result is confined to the trusted tenant in the controller
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantController.getTenantByCode
);

router.get(
  "/tenants/domain/:domain",
  observePlatformPermission("platform:tenant:read:any"),
  requireTenant, // Phase 1C-2B: non-SU result is confined to the trusted tenant in the controller
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantController.getTenantByDomain
);

platform("put", "/tenants/:id", platformTenantAdmin(UPDATE_ANY, { target: "id", change: "TENANT_UPDATED", section: "profile" }), TenantController.updateTenant);
router.put(
  "/tenants/:id",
  requireTenant,
  requireTenantPathAccess("id"),
  refuseTenantLifecycleFields,
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantController.updateTenant
);

// Z6: the existing delete is a SOFT delete (isActive false, status INACTIVE); platform record only (no tenant copy:
// an inactive tenant can no longer sign anyone in to read its own history).
platform("delete", "/tenants/:id", platformTenantAdmin(DELETE_ANY, { target: "id", change: "TENANT_DELETED" }), TenantController.deleteTenant);
router.delete(
  "/tenants/:id",
  requireTenant,
  requireTenantPathAccess("id"),
  refuseTenantLifecycle
);

// Tenant management operations
platform("get", "/tenants/:id/stats", platformTenantAdmin(READ_ANY, { target: "id" }), TenantController.getTenantStats);
router.get(
  "/tenants/:id/stats",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantController.getTenantStats
);

platform("put", "/tenants/:id/status", platformTenantAdmin(UPDATE_ANY, { target: "id", change: "status", section: "status" }), TenantController.updateTenantStatus);
router.put(
  "/tenants/:id/status",
  requireTenant,
  requireTenantPathAccess("id"),
  refuseTenantLifecycle
);

platform("patch", "/tenants/:id/organisation-profile", platformTenantAdmin(UPDATE_ANY, { target: "id", change: "TENANT_UPDATED", section: "organisation-profile" }), TenantController.updateOrganisationProfile);
router.patch(
  "/tenants/:id/organisation-profile",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantController.updateOrganisationProfile
);

platform("patch", "/tenants/:id/branding", platformTenantAdmin(UPDATE_ANY, { target: "id", change: "TENANT_UPDATED", section: "branding" }), TenantController.updateBranding);
router.patch(
  "/tenants/:id/branding",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantController.updateBranding
);

platform("patch", "/tenants/:id/regional-settings", platformTenantAdmin(UPDATE_ANY, { target: "id", change: "TENANT_UPDATED", section: "regional-settings" }), TenantController.updateRegionalSettings);
router.patch(
  "/tenants/:id/regional-settings",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantController.updateRegionalSettings
);

platform("post", "/tenants/:id/branding/assets", platformTenantAdmin(UPDATE_ANY, { target: "id", change: "TENANT_UPDATED", section: "branding-asset" }), brandingAssetUploadMw, TenantBrandingController.uploadBrandingAsset);
router.post(
  "/tenants/:id/branding/assets",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "update"),
  brandingAssetUploadMw,
  TenantBrandingController.uploadBrandingAsset
);

// Authentication Connection Management Routes
// Z6: every auth-connection route (reads included) needs platform:tenant:auth-connections:manage:any for a
// platform principal - read:any / update:any never reach another tenant's connections.
platform("post", "/tenants/:id/auth-connections", platformTenantAdmin(CONNECTIONS_ANY, { target: "id", change: "AUTH_CONNECTION_ADDED", section: "auth-connections" }), TenantController.addAuthenticationConnection);
router.post(
  "/tenants/:id/auth-connections",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "admin"),
  TenantController.addAuthenticationConnection
);

platform("get", "/tenants/:id/auth-connections", platformTenantAdmin(CONNECTIONS_ANY, { target: "id" }), TenantController.getAuthenticationConnections);
router.get(
  "/tenants/:id/auth-connections",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantController.getAuthenticationConnections
);

platform("get", "/tenants/:id/auth-connections/default-role-options", platformTenantAdmin(CONNECTIONS_ANY, { target: "id" }), TenantController.getDefaultRoleOptions);
router.get(
  "/tenants/:id/auth-connections/default-role-options",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "admin"),
  TenantController.getDefaultRoleOptions
);

platform("put", "/tenants/:id/auth-connections/:connectionId", platformTenantAdmin(CONNECTIONS_ANY, { target: "id", change: "AUTH_CONNECTION_UPDATED", section: "auth-connections" }), TenantController.updateAuthenticationConnection);
router.put(
  "/tenants/:id/auth-connections/:connectionId",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "admin"),
  TenantController.updateAuthenticationConnection
);

// Connect Microsoft Entra (Stage 5c-1): prove the connection's directory with a Microsoft
// administrator sign-in and record a verified directory claim. Does not activate the connection.
platform("post", "/tenants/:id/auth-connections/:connectionId/connect", platformTenantAdmin(CONNECTIONS_ANY, { target: "id", change: "AUTH_CONNECTION_CONNECT_STARTED", section: "auth-connections" }), TenantController.startEntraConnect);
router.post(
  "/tenants/:id/auth-connections/:connectionId/connect",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "admin"),
  TenantController.startEntraConnect
);

platform("post", "/tenants/:id/auth-connections/:connectionId/connect/complete", platformTenantAdmin(CONNECTIONS_ANY, { target: "id", change: "AUTH_CONNECTION_CONNECTED", section: "auth-connections" }), TenantController.completeEntraConnect);
router.post(
  "/tenants/:id/auth-connections/:connectionId/connect/complete",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "admin"),
  TenantController.completeEntraConnect
);

// Test Connection (Stage 5c-2): configuration / connectivity health check of a connected Entra
// directory and the shared CRM application. Records lastTestedAt / lastTestResult only.
platform("post", "/tenants/:id/auth-connections/:connectionId/test", platformTenantAdmin(CONNECTIONS_ANY, { target: "id", change: "AUTH_CONNECTION_TESTED", section: "auth-connections" }), TenantController.testEntraConnection);
router.post(
  "/tenants/:id/auth-connections/:connectionId/test",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "admin"),
  TenantController.testEntraConnection
);

// Disconnect Microsoft Entra (Stage 5c-3): connection inactive + its verified claim revoked, in one
// transaction. Users, roles and the directory are untouched; reconnect via /connect.
platform("post", "/tenants/:id/auth-connections/:connectionId/disconnect", platformTenantAdmin(CONNECTIONS_ANY, { target: "id", change: "AUTH_CONNECTION_DISCONNECTED", section: "auth-connections" }), TenantController.disconnectEntraConnection);
router.post(
  "/tenants/:id/auth-connections/:connectionId/disconnect",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "admin"),
  TenantController.disconnectEntraConnection
);

platform("get", "/tenants/:id/auth-connections/:connectionId/status", platformTenantAdmin(CONNECTIONS_ANY, { target: "id" }), TenantController.getEntraConnectionStatus);
router.get(
  "/tenants/:id/auth-connections/:connectionId/status",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantController.getEntraConnectionStatus
);

platform("delete", "/tenants/:id/auth-connections/:connectionId", platformTenantAdmin(CONNECTIONS_ANY, { target: "id", change: "AUTH_CONNECTION_REMOVED", section: "auth-connections" }), TenantController.removeAuthenticationConnection);
router.delete(
  "/tenants/:id/auth-connections/:connectionId",
  requireTenant,
  requireTenantPathAccess("id"),
  defaultPolicyAdapter.middleware("tenant", "admin"),
  TenantController.removeAuthenticationConnection
);

module.exports = router;
