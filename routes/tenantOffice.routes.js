const express = require("express");
const router = express.Router();
const TenantOfficeController = require("../controllers/tenantOffice.controller");
const { authenticate, requireTenant } = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");

router.use(authenticate);

router.get(
  "/tenant-offices/defaults",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantOfficeController.getOfficeDefaults
);

router.get(
  "/tenant/offices",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantOfficeController.getOffices
);

router.get(
  "/tenant/offices/:id",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantOfficeController.getOfficeById
);

router.post(
  "/tenant/offices",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantOfficeController.createOffice
);

router.put(
  "/tenant/offices/:id",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantOfficeController.updateOffice
);

router.patch(
  "/tenant/offices/:id/primary",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantOfficeController.setPrimaryOffice
);

router.delete(
  "/tenant/offices/:id",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "delete"),
  TenantOfficeController.deactivateOffice
);

router.get(
  "/tenants/:tenantId/offices",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantOfficeController.getOffices
);

router.get(
  "/tenants/:tenantId/offices/:id",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantOfficeController.getOfficeById
);

router.post(
  "/tenants/:tenantId/offices",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantOfficeController.createOffice
);

router.put(
  "/tenants/:tenantId/offices/:id",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantOfficeController.updateOffice
);

router.patch(
  "/tenants/:tenantId/offices/:id/primary",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantOfficeController.setPrimaryOffice
);

router.delete(
  "/tenants/:tenantId/offices/:id",
  defaultPolicyAdapter.middleware("tenant", "delete"),
  TenantOfficeController.deactivateOffice
);

module.exports = router;
