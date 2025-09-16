const express = require("express");
const router = express.Router();
const PermissionController = require("../controllers/permission.controller");
const { authenticate } = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");

// Apply authentication to all routes
router.use(authenticate);

// Permission CRUD operations (Super User only for create/update/delete)
router.post(
  "/permissions",
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
  defaultPolicyAdapter.middleware("permission", "admin"),
  PermissionController.updatePermission
);

router.delete(
  "/permissions/:id",
  defaultPolicyAdapter.middleware("permission", "admin"),
  PermissionController.deletePermission
);

router.post(
  "/permissions/initialize",
  defaultPolicyAdapter.middleware("permission", "admin"),
  PermissionController.initializeDefaultPermissions
);

module.exports = router;
