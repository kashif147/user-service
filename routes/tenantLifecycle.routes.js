const express = require("express");
const router = express.Router();
const TenantLifecycleController = require("../controllers/tenantLifecycle.controller");

router.use(TenantLifecycleController.requireInternal);

router.get(
  "/internal/tenant-lifecycle-configs",
  TenantLifecycleController.getAllLifecycleConfigs
);

router.get(
  "/internal/tenants/:tenantId/lifecycle-config",
  TenantLifecycleController.getLifecycleConfig
);

router.get(
  "/internal/tenants/:tenantId/notification-recipients",
  TenantLifecycleController.getNotificationRecipients
);

module.exports = router;
