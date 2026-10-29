const express = require("express");
const router = express.Router();
const PermissionController = require("../controllers/permission.controller");
const {
  authenticate,
  tenantContextWarn,
} = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");
// Phase B / Z5: platform-owned writes are enforced platform authorization (route-enforce; global mode stays shadow).
const { requirePlatformPermission } = require("../middlewares/requirePlatformPermission");

// Apply authentication to all routes
router.use(authenticate, tenantContextWarn);

// Permission catalogue writes (create/update/delete/initialize).
// Phase A / A-5 review: the permission catalogue is platform-owned; writes are frozen (423) and stay
// deployment/script controlled. Phase B / Z5: platform:permission-catalogue:manage is required FIRST (legacy
// SU / "*" no longer count), then the A14 freeze (layering in middlewares/globalDataFreeze.js).
router.post(
  "/permissions",
  requirePlatformPermission("platform:permission-catalogue:manage", { mode: "route-enforce", freeze: "permission" }), // Phase B / Z5: platform authority, then the A14 freeze
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
  requirePlatformPermission("platform:permission-catalogue:manage", { mode: "route-enforce", freeze: "permission" }), // Phase B / Z5: platform authority, then the A14 freeze
  PermissionController.updatePermission
);

router.delete(
  "/permissions/:id",
  requirePlatformPermission("platform:permission-catalogue:manage", { mode: "route-enforce", freeze: "permission" }), // Phase B / Z5: platform authority, then the A14 freeze
  PermissionController.deletePermission
);

router.post(
  "/permissions/initialize",
  requirePlatformPermission("platform:permission-catalogue:manage", { mode: "route-enforce", freeze: "permission" }), // Phase B / Z5: platform authority, then the A14 freeze
  PermissionController.initializeDefaultPermissions
);

module.exports = router;
