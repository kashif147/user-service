const express = require("express");
const router = express.Router();
const CacheController = require("../controllers/cache.controller");
const {
  authenticate,
  tenantContextWarn,
} = require("../middlewares/auth");
// Phase B / Z5: platform-owned writes are enforced platform authorization (route-enforce; global mode stays shadow).
const { requirePlatformPermission } = require("../middlewares/requirePlatformPermission");

// Apply authentication to all routes
router.use(authenticate, tenantContextWarn);

// Cache management routes: platform operations (Phase B / Z5: platform:cache:admin only - legacy SU and admin:* grants no longer pass)
router.post(
  "/cache/clear",
  requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }), // Phase B / Z5: platform authority only (no SU / admin:*)
  CacheController.clearAllCaches
);

router.post(
  "/cache/refresh/role-hierarchy",
  requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }), // Phase B / Z5: platform authority only (no SU / admin:*)
  CacheController.refreshRoleHierarchyCache
);

router.post(
  "/cache/refresh/permissions",
  requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }), // Phase B / Z5: platform authority only (no SU / admin:*)
  CacheController.refreshPermissionsCache
);

router.get(
  "/cache/stats",
  requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }), // Phase B / Z5: platform authority only (no SU / admin:*)
  CacheController.getCacheStats
);

router.get(
  "/cache/performance/test",
  requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }), // Phase B / Z5: platform authority only (no SU / admin:*)
  CacheController.testCachePerformance
);

// Data access routes (Super User only)
router.get(
  "/role-hierarchy",
  requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }), // Phase B / Z5: platform authority only (no SU / admin:*)
  CacheController.getRoleHierarchy
);

router.get(
  "/permissions-map",
  requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }), // Phase B / Z5: platform authority only (no SU / admin:*)
  CacheController.getPermissionsMap
);

router.get(
  "/role-permissions/:roleCode",
  requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }), // Phase B / Z5: platform authority only (no SU / admin:*)
  CacheController.getRolePermissions
);

// Lookup cache management routes
router.post(
  "/lookup/clear",
  requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }), // Phase B / Z5: platform authority only (no SU / admin:*)
  CacheController.clearLookupCaches
);

router.get(
  "/lookup/stats",
  requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }), // Phase B / Z5: platform authority only (no SU / admin:*)
  CacheController.getLookupCacheStats
);

// Country cache management routes
router.post(
  "/country/clear",
  requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }), // Phase B / Z5: platform authority only (no SU / admin:*)
  CacheController.clearCountryCaches
);

module.exports = router;
