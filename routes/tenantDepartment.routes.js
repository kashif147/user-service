const express = require("express");
const router = express.Router();
const TenantDepartmentController = require("../controllers/tenantDepartment.controller");
const { authenticate, requireTenant } = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");

router.use(authenticate);

router.get(
  "/tenant/departments",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantDepartmentController.getDepartments
);

router.get(
  "/tenant/departments/:id",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantDepartmentController.getDepartmentById
);

router.post(
  "/tenant/departments",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantDepartmentController.createDepartment
);

router.put(
  "/tenant/departments/:id",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantDepartmentController.updateDepartment
);

router.delete(
  "/tenant/departments/:id",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "delete"),
  TenantDepartmentController.deactivateDepartment
);

router.get(
  "/tenants/:tenantId/departments",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantDepartmentController.getDepartments
);

router.get(
  "/tenants/:tenantId/departments/:id",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantDepartmentController.getDepartmentById
);

router.post(
  "/tenants/:tenantId/departments",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantDepartmentController.createDepartment
);

router.put(
  "/tenants/:tenantId/departments/:id",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantDepartmentController.updateDepartment
);

router.delete(
  "/tenants/:tenantId/departments/:id",
  defaultPolicyAdapter.middleware("tenant", "delete"),
  TenantDepartmentController.deactivateDepartment
);

module.exports = router;
