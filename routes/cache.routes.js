const express = require("express");
const router = express.Router();
const CacheController = require("../controllers/cache.controller");
const {
  authenticate,
  requireTenant,
  requireSuperUser,
  tenantContextWarn,
} = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");
// Phase B / Z2: shadow-only platform authorization observers (never change the response; Z5 migrates).
const { observePlatformPermission } = require("../middlewares/requirePlatformPermission");

// Apply authentication to all routes
router.use(authenticate, tenantContextWarn);

// Cache management routes (Super User only)
router.post(
  "/cache/clear",
  observePlatformPermission("platform:cache:admin"),
  requireTenant,
  requireSuperUser, // Phase 1C-2D: platform-level write (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "write"),
  CacheController.clearAllCaches
);

router.post(
  "/cache/refresh/role-hierarchy",
  observePlatformPermission("platform:cache:admin"),
  requireTenant,
  requireSuperUser, // Phase 1C-2D: platform-level write (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "write"),
  CacheController.refreshRoleHierarchyCache
);

router.post(
  "/cache/refresh/permissions",
  observePlatformPermission("platform:cache:admin"),
  requireTenant,
  requireSuperUser, // Phase 1C-2D: platform-level write (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "write"),
  CacheController.refreshPermissionsCache
);

router.get(
  "/cache/stats",
  observePlatformPermission("platform:cache:admin"),
  requireTenant,
  requireSuperUser, // Phase 1C-2H: platform-level read (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "read"),
  CacheController.getCacheStats
);

router.get(
  "/cache/performance/test",
  observePlatformPermission("platform:cache:admin"),
  requireTenant,
  requireSuperUser, // Phase 1C-2H: platform-level read (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "read"),
  CacheController.testCachePerformance
);

// Data access routes (Super User only)
router.get(
  "/role-hierarchy",
  observePlatformPermission("platform:cache:admin"),
  requireTenant,
  requireSuperUser, // Phase 1C-2H: platform-level read (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "read"),
  CacheController.getRoleHierarchy
);

router.get(
  "/permissions-map",
  observePlatformPermission("platform:cache:admin"),
  requireTenant,
  requireSuperUser, // Phase 1C-2H: platform-level read (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "read"),
  CacheController.getPermissionsMap
);

router.get(
  "/role-permissions/:roleCode",
  observePlatformPermission("platform:cache:admin"),
  requireTenant,
  requireSuperUser, // Phase 1C-2H: platform-level read (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "read"),
  CacheController.getRolePermissions
);

// Lookup cache management routes
router.post(
  "/lookup/clear",
  observePlatformPermission("platform:cache:admin"),
  requireTenant,
  requireSuperUser, // Phase 1C-2D: platform-level write (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "write"),
  CacheController.clearLookupCaches
);

router.get(
  "/lookup/stats",
  observePlatformPermission("platform:cache:admin"),
  requireTenant,
  requireSuperUser, // Phase 1C-2H: platform-level read (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "read"),
  CacheController.getLookupCacheStats
);

// Country cache management routes
router.post(
  "/country/clear",
  observePlatformPermission("platform:cache:admin"),
  requireTenant,
  requireSuperUser, // Phase 1C-2D: platform-level write (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "write"),
  CacheController.clearCountryCaches
);

module.exports = router;
