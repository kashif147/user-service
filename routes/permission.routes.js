const express = require("express");
const router = express.Router();
const PermissionController = require("../controllers/permission.controller");
const {
  authenticate,
  requireRole,
  requirePermission,
} = require("../middlewares/auth");

// Apply authentication to all routes
router.use(authenticate);

// Permission CRUD operations (Super User only for create/update/delete)
router.post(
  "/permissions",
  requireRole(["SU"]),
  PermissionController.createPermission
);

router.get(
  "/permissions",
  requireRole(["SU"]),
  PermissionController.getAllPermissions
);

// Permission management operations - must come before parameterized routes
router.get(
  "/permissions/stats",
  requireRole(["SU"]),
  PermissionController.getPermissionStats
);

router.get(
  "/permissions/:id",
  requireRole(["SU"]),
  PermissionController.getPermissionById
);

router.get(
  "/permissions/code/:code",
  requireRole(["SU"]),
  PermissionController.getPermissionByCode
);

router.get(
  "/permissions/resource/:resource",
  requireRole(["SU"]),
  PermissionController.getPermissionsByResource
);

router.get(
  "/permissions/category/:category",
  requireRole(["SU"]),
  PermissionController.getPermissionsByCategory
);

router.put(
  "/permissions/:id",
  requireRole(["SU"]),
  PermissionController.updatePermission
);

router.delete(
  "/permissions/:id",
  requireRole(["SU"]),
  PermissionController.deletePermission
);

router.post(
  "/permissions/initialize",
  requireRole(["SU"]),
  PermissionController.initializeDefaultPermissions
);

module.exports = router;
