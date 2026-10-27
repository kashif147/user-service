const express = require("express");
const router = express.Router();
const PermissionController = require("../controllers/permission.controller");
const {
  authenticate,
  requireTenant,
  requireSuperUser,
  tenantContextWarn,
} = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");
const { freezeGlobalWrites } = require("../middlewares/globalDataFreeze");
// Phase B / Z2: shadow-only platform authorization observers (never change the response; Z5 migrates).
const { observePlatformPermission } = require("../middlewares/requirePlatformPermission");

// Apply authentication to all routes
router.use(authenticate, tenantContextWarn);

// Permission CRUD operations (Super User only for create/update/delete)
// Phase A / A-5 review: the permission catalogue is platform-owned. requireSuperUser accepts the SU of ANY
// tenant (every tenant has one), so catalogue writes are frozen (423) and stay deployment/script controlled.
router.post(
  "/permissions",
  observePlatformPermission("platform:permission-catalogue:manage"),
  freezeGlobalWrites("permission"),
  requireTenant,
  requireSuperUser, // Phase 1C-2D: platform-level write (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("permission", "admin"),
  PermissionController.createPermission
);

router.get(
  "/permissions",
  defaultPolicyAdapter.middleware("permission", "admin"),
  PermissionController.getAllPermissions
);

// Permission management operations - must come before parameterized routes
router.get(
  "/permissions/stats",
  defaultPolicyAdapter.middleware("permission", "admin"),
  PermissionController.getPermissionStats
);

router.get(
  "/permissions/:id",
  defaultPolicyAdapter.middleware("permission", "admin"),
  PermissionController.getPermissionById
);

router.get(
  "/permissions/code/:code",
  defaultPolicyAdapter.middleware("permission", "admin"),
  PermissionController.getPermissionByCode
);

router.get(
  "/permissions/resource/:resource",
  defaultPolicyAdapter.middleware("permission", "admin"),
  PermissionController.getPermissionsByResource
);

router.get(
  "/permissions/category/:category",
  defaultPolicyAdapter.middleware("permission", "admin"),
  PermissionController.getPermissionsByCategory
);

router.put(
  "/permissions/:id",
  observePlatformPermission("platform:permission-catalogue:manage"),
  freezeGlobalWrites("permission"),
  requireTenant,
  requireSuperUser, // Phase 1C-2D: platform-level write (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("permission", "admin"),
  PermissionController.updatePermission
);

router.delete(
  "/permissions/:id",
  observePlatformPermission("platform:permission-catalogue:manage"),
  freezeGlobalWrites("permission"),
  requireTenant,
  requireSuperUser, // Phase 1C-2D: platform-level write (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("permission", "admin"),
  PermissionController.deletePermission
);

router.post(
  "/permissions/initialize",
  observePlatformPermission("platform:permission-catalogue:manage"),
  freezeGlobalWrites("permission"),
  requireTenant,
  requireSuperUser, // Phase 1C-2D: platform-level write (SU only, trusted req.ctx roles)
  defaultPolicyAdapter.middleware("permission", "admin"),
  PermissionController.initializeDefaultPermissions
);

module.exports = router;
