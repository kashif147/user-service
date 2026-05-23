const express = require("express");
const router = express.Router();
const TenantContactController = require("../controllers/tenantContact.controller");
const { authenticate, requireTenant } = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");

router.use(authenticate);

router.get(
  "/tenant/departments/:departmentId/contacts",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantContactController.getContacts
);

router.get(
  "/tenant/departments/:departmentId/contacts/:id",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantContactController.getContactById
);

router.post(
  "/tenant/departments/:departmentId/contacts",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantContactController.createContact
);

router.put(
  "/tenant/departments/:departmentId/contacts/:id",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantContactController.updateContact
);

router.patch(
  "/tenant/departments/:departmentId/contacts/:id/primary",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantContactController.setPrimaryContact
);

router.delete(
  "/tenant/departments/:departmentId/contacts/:id",
  requireTenant,
  defaultPolicyAdapter.middleware("tenant", "delete"),
  TenantContactController.deactivateContact
);

router.get(
  "/tenants/:tenantId/departments/:departmentId/contacts",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantContactController.getContacts
);

router.get(
  "/tenants/:tenantId/departments/:departmentId/contacts/:id",
  defaultPolicyAdapter.middleware("tenant", "read"),
  TenantContactController.getContactById
);

router.post(
  "/tenants/:tenantId/departments/:departmentId/contacts",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantContactController.createContact
);

router.put(
  "/tenants/:tenantId/departments/:departmentId/contacts/:id",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantContactController.updateContact
);

router.patch(
  "/tenants/:tenantId/departments/:departmentId/contacts/:id/primary",
  defaultPolicyAdapter.middleware("tenant", "update"),
  TenantContactController.setPrimaryContact
);

router.delete(
  "/tenants/:tenantId/departments/:departmentId/contacts/:id",
  defaultPolicyAdapter.middleware("tenant", "delete"),
  TenantContactController.deactivateContact
);

module.exports = router;
