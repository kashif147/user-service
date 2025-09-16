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

module.exports = router;
