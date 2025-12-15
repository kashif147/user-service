const express = require("express");
const router = express.Router();
const lookupController = require("../controllers/lookup.controller.js");
const { authenticate } = require("../middlewares/auth");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");

// Apply authentication to all routes (validates gateway headers)
router.use(authenticate);

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

module.exports = router;
