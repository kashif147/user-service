const express = require("express");
const router = express.Router();
const lookuptypeController = require("../controllers/lookuptype.ontroller.js");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");

router
  .route("/")
  .get(
    defaultPolicyAdapter.middleware("lookupType", "read"),
    lookuptypeController.getAllLookupType
  )
  .post(
    defaultPolicyAdapter.middleware("lookupType", "write"),
    lookuptypeController.createNewLookupType
  )
  .put(
    defaultPolicyAdapter.middleware("lookupType", "write"),
    lookuptypeController.updateLookupType
  )
  .delete(
    defaultPolicyAdapter.middleware("lookupType", "delete"),
    lookuptypeController.deleteLookupType
  );

router
  .route("/:id")
  .get(
    defaultPolicyAdapter.middleware("lookupType", "read"),
    lookuptypeController.getLookupType
  );

module.exports = router;
