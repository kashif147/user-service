const express = require("express");
const router = express.Router();
const lookupController = require("../controllers/lookup.controller.js");
const {
  authenticate,
  tenantContextWarn,
  requireTenant,
} = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");

// Apply authentication to all routes (validates gateway headers)
router.use(authenticate, tenantContextWarn);

router
  .route("/lookup")
  .get(
    defaultPolicyAdapter.middleware("lookup", "read"),
    lookupController.getAllLookup
  )
  .post(
    defaultPolicyAdapter.middleware("lookup", "write"),
    lookupController.createNewLookup
  )
  .put(
    defaultPolicyAdapter.middleware("lookup", "write"),
    lookupController.updateLookup
  )
  .delete(
    defaultPolicyAdapter.middleware("lookup", "delete"),
    lookupController.deleteLookup
  );

// Bulk officer assignment (updates many lookups at once)
router.patch(
  "/lookups/officer",
  defaultPolicyAdapter.middleware("lookup", "write"),
  lookupController.bulkUpdateOfficer
);

router
  .route("/lookup/:id")
  .get(
    defaultPolicyAdapter.middleware("lookup", "read"),
    lookupController.getLookup
  );

// Get lookup hierarchy - returns lookup with complete parent chain
router
  .route("/lookup/:id/hierarchy")
  .get(
    defaultPolicyAdapter.middleware("lookup", "read"),
    lookupController.getLookupHierarchy
  );

// Get all lookups by type with their hierarchy
router
  .route("/lookup/by-type/:lookuptypeId/hierarchy")
  .get(
    defaultPolicyAdapter.middleware("lookup", "read"),
    lookupController.getLookupsByTypeWithHierarchy
  );

// Phase A / A10: all lookups of a lookup type by the type's stable code (e.g. WORKLOC, 001).
// Tenant from the trusted context only (requireTenant fails closed); same response as by-type.
router
  .route("/lookup/by-type-code/:typeCode/hierarchy")
  .get(
    requireTenant,
    defaultPolicyAdapter.middleware("lookup", "read"),
    lookupController.getLookupsByTypeCodeWithHierarchy
  );

module.exports = router;
