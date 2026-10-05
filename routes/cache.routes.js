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

// Apply authentication to all routes
router.use(authenticate, tenantContextWarn);

// Cache management routes (Super User only)
router.post(
  "/cache/clear",
  requireTenant,
  requireSuperUser, // Phase 1C-2D: platform-level write (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "write"),
  CacheController.clearAllCaches
);

router.post(
  "/cache/refresh/role-hierarchy",
  requireTenant,
  requireSuperUser, // Phase 1C-2D: platform-level write (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "write"),
  CacheController.refreshRoleHierarchyCache
);

router.post(
  "/cache/refresh/permissions",
  requireTenant,
  requireSuperUser, // Phase 1C-2D: platform-level write (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "write"),
  CacheController.refreshPermissionsCache
);

router.get(
  "/cache/stats",
  defaultPolicyAdapter.middleware("admin", "read"),
  CacheController.getCacheStats
);

router.get(
  "/cache/performance/test",
  defaultPolicyAdapter.middleware("admin", "read"),
  CacheController.testCachePerformance
);

// Data access routes (Super User only)
router.get(
  "/role-hierarchy",
  defaultPolicyAdapter.middleware("admin", "read"),
  CacheController.getRoleHierarchy
);

router.get(
  "/permissions-map",
  defaultPolicyAdapter.middleware("admin", "read"),
  CacheController.getPermissionsMap
);

router.get(
  "/role-permissions/:roleCode",
  defaultPolicyAdapter.middleware("admin", "read"),
  CacheController.getRolePermissions
);

// Lookup cache management routes
router.post(
  "/lookup/clear",
  requireTenant,
  requireSuperUser, // Phase 1C-2D: platform-level write (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "write"),
  CacheController.clearLookupCaches
);

router.get(
  "/lookup/stats",
  defaultPolicyAdapter.middleware("admin", "read"),
  CacheController.getLookupCacheStats
);

// Country cache management routes
router.post(
  "/country/clear",
  requireTenant,
  requireSuperUser, // Phase 1C-2D: platform-level write (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("admin", "write"),
  CacheController.clearCountryCaches
);

module.exports = router;
