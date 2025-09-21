const express = require("express");
const router = express.Router();
const lookupController = require("../controllers/lookup.controller.js");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");

router
  .route("/")
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

router
  .route("/:id")
  .get(
    defaultPolicyAdapter.middleware("lookup", "read"),
    lookupController.getLookup
  );

// Get lookup hierarchy - returns lookup with complete parent chain
router
  .route("/:id/hierarchy")
  .get(
    defaultPolicyAdapter.middleware("lookup", "read"),
    lookupController.getLookupHierarchy
  );

// Get all lookups by type with their hierarchy
router
  .route("/by-type/:lookuptypeId/hierarchy")
  .get(
    defaultPolicyAdapter.middleware("lookup", "read"),
    lookupController.getLookupsByTypeWithHierarchy
  );

module.exports = router;
