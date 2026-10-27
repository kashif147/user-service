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
const { freezeGlobalWrites } = require("../middlewares/globalDataFreeze");
// Phase B / Z2: shadow-only platform authorization observers (never change the response; Z5 migrates).
const { observePlatformPermission } = require("../middlewares/requirePlatformPermission");

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
    observePlatformPermission("platform:reference-data:manage"),
    freezeGlobalWrites("lookup"),
    defaultPolicyAdapter.middleware("lookup", "write"),
    lookupController.createNewLookup
  )
  .put(
    observePlatformPermission("platform:reference-data:manage"),
    freezeGlobalWrites("lookup"),
    defaultPolicyAdapter.middleware("lookup", "write"),
    lookupController.updateLookup
  )
  .delete(
    observePlatformPermission("platform:reference-data:manage"),
    freezeGlobalWrites("lookup"),
    defaultPolicyAdapter.middleware("lookup", "delete"),
    lookupController.deleteLookup
  );

// Bulk officer assignment (updates many lookups at once). Phase A / A14: frozen with the other
// global lookup writes (officer repair happens only in Phase D).
router.patch(
  "/lookups/officer",
  observePlatformPermission("platform:reference-data:manage"),
  freezeGlobalWrites("lookup"),
  defaultPolicyAdapter.middleware("lookup", "write"),
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
