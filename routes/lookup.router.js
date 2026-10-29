const express = require("express");
const router = express.Router();
const lookupController = require("../controllers/lookup.controller.js");
const {
  authenticate,
  tenantContextWarn,
  requireTenant,
} = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");
const { requireTrustedTenant } = require("../middlewares/requireTrustedTenant");
// Phase B / Z5: platform-owned writes are enforced platform authorization (route-enforce; global mode stays shadow).
const { requirePlatformPermission } = require("../middlewares/requirePlatformPermission");

// Apply authentication to all routes (validates gateway headers)
router.use(authenticate, tenantContextWarn);

router
  .route("/lookup")
  .get(
    requireTrustedTenant,
    defaultPolicyAdapter.middleware("lookup", "read"),
    lookupController.getAllLookup
  )
  .post(
    requirePlatformPermission("platform:reference-data:manage", { mode: "route-enforce", freeze: "lookup" }), // Phase B / Z5: platform authority, then the A14 freeze
    lookupController.createNewLookup
  )
  .put(
    requirePlatformPermission("platform:reference-data:manage", { mode: "route-enforce", freeze: "lookup" }), // Phase B / Z5: platform authority, then the A14 freeze
    lookupController.updateLookup
  )
  .delete(
    requirePlatformPermission("platform:reference-data:manage", { mode: "route-enforce", freeze: "lookup" }), // Phase B / Z5: platform authority, then the A14 freeze
    lookupController.deleteLookup
  );

// Bulk officer assignment (updates many lookups at once). Phase A / A14: frozen with the other
// global lookup writes (officer repair happens only in Phase D).
router.patch(
  "/lookups/officer",
  requirePlatformPermission("platform:reference-data:manage", { mode: "route-enforce", freeze: "lookup" }), // Phase B / Z5: platform authority, then the A14 freeze
  lookupController.bulkUpdateOfficer
);

router
  .route("/lookup/:id")
  .get(
    requireTrustedTenant,
    defaultPolicyAdapter.middleware("lookup", "read"),
    lookupController.getLookup
  );

// Get lookup hierarchy - returns lookup with complete parent chain
router
  .route("/lookup/:id/hierarchy")
  .get(
    requireTrustedTenant,
    defaultPolicyAdapter.middleware("lookup", "read"),
    lookupController.getLookupHierarchy
  );

// Get all lookups by type with their hierarchy
router
  .route("/lookup/by-type/:lookuptypeId/hierarchy")
  .get(
    requireTrustedTenant,
    defaultPolicyAdapter.middleware("lookup", "read"),
    lookupController.getLookupsByTypeWithHierarchy
  );

// Phase A / A10: all lookups of a lookup type by the type's stable code (e.g. WORKLOC, 001).
// Tenant from the trusted context only (requireTenant fails closed); same response as by-type.
router
  .route("/lookup/by-type-code/:typeCode/hierarchy")
  .get(
    requireTenant,
    requireTrustedTenant,
    defaultPolicyAdapter.middleware("lookup", "read"),
    lookupController.getLookupsByTypeCodeWithHierarchy
  );

module.exports = router;
