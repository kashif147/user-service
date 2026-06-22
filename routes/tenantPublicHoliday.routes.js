const express = require("express");
const router = express.Router();
const TenantPublicHolidayController = require("../controllers/tenantPublicHoliday.controller");
const { authenticate, requireTenant } = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");

router.use(authenticate);

router.get(
  "/tenant/public-holidays",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantPublicHolidayController.getPublicHolidays
);

router.post(
  "/tenant/public-holidays",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantPublicHolidayController.createPublicHoliday
);

router.put(
  "/tenant/public-holidays/:id",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantPublicHolidayController.updatePublicHoliday
);

router.delete(
  "/tenant/public-holidays/:id",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "delete"),
  TenantPublicHolidayController.deactivatePublicHoliday
);

router.get(
  "/tenants/:tenantId/public-holidays",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantPublicHolidayController.getPublicHolidays
);

router.post(
  "/tenants/:tenantId/public-holidays",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantPublicHolidayController.createPublicHoliday
);

router.put(
  "/tenants/:tenantId/public-holidays/:id",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantPublicHolidayController.updatePublicHoliday
);

router.delete(
  "/tenants/:tenantId/public-holidays/:id",
  defaultPolicyAdapter.middleware("tenant", "delete"),
  TenantPublicHolidayController.deactivatePublicHoliday
);

module.exports = router;
