const express = require("express");
const router = express.Router();
const TenantLifecycleController = require("../controllers/tenantLifecycle.controller");

/** Scope internal auth to /api/internal/* only (not all /api/* mounts). */
const internalRouter = express.Router();
internalRouter.use(TenantLifecycleController.requireInternal);

internalRouter.get(
  "/tenant-lifecycle-configs",
  TenantLifecycleController.getAllLifecycleConfigs
);

internalRouter.get(
  "/tenants/:tenantId/lifecycle-config",
  TenantLifecycleController.getLifecycleConfig
);

internalRouter.get(
  "/tenants/:tenantId/notification-recipients",
  TenantLifecycleController.getNotificationRecipients
);

router.use("/internal", internalRouter);

module.exports = router;
