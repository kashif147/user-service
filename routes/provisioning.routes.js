/**
 * Phase B / P1: platform provisioning control plane. Every route needs the EXACT platform permission
 * platform:provisioning:admin through a live PlatformPrincipal (route-enforce: denied when platform
 * authorization is off). Tenant roles (ASU, legacy SU "*", tenant permissions) never pass.
 * Not under the A14 freeze: these are per-tenant control-plane records, not shared tenant metadata; templates
 * are not written here at all (scripts/platform-template.js publishes them from reviewed code).
 */
const express = require("express");
const { authenticate, tenantContextWarn } = require("../middlewares/auth");
const { requirePlatformPermission } = require("../middlewares/requirePlatformPermission");
const ProvisioningController = require("../controllers/provisioning.controller");

const router = express.Router();
const BASE = "/platform/provisioning";
const guard = () => requirePlatformPermission("platform:provisioning:admin", { mode: "route-enforce" });

router.use(BASE, authenticate, tenantContextWarn);
router.get(`${BASE}/components`, guard(), ProvisioningController.listComponents);
router.get(`${BASE}/templates`, guard(), ProvisioningController.listTemplates);
router.get(`${BASE}/templates/:key/:version`, guard(), ProvisioningController.getTemplate);
// The target tenant is a PATH parameter, never a `tenantId` key: the enforce-mode tenant-context guard
// (policy-middleware) refuses any body / query / params `tenantId` that differs from the caller's trusted tenant,
// and a platform principal provisions tenants other than the one it signed in to (Z6 path-target pattern).
router.post(`${BASE}/tenants/:targetTenantId/runs`, guard(), ProvisioningController.createRun);
router.get(`${BASE}/runs`, guard(), ProvisioningController.listRuns);
router.get(`${BASE}/runs/:runId`, guard(), ProvisioningController.getRun);
router.post(`${BASE}/runs/:runId/resume`, guard(), ProvisioningController.resumeRun);
// P3 recovery: fail a running step whose request event is dead (fixed code OUTBOX_DELIVERY_EXHAUSTED); then resume.
router.post(`${BASE}/tenants/:targetTenantId/runs/:runId/recover-delivery`, guard(), ProvisioningController.recoverDelivery);

module.exports = router;
