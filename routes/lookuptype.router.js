const express = require("express");
const router = express.Router();
const lookuptypeController = require("../controllers/lookuptype.ontroller.js");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");
const { requireTrustedTenant } = require("../middlewares/requireTrustedTenant");
const { freezeGlobalWrites } = require("../middlewares/globalDataFreeze");

router
  .route("/lookuptype")
  .get(
    requireTrustedTenant,
    defaultPolicyAdapter.middleware("lookupType", "read"),
    lookuptypeController.getAllLookupType
  )
  .post(
    freezeGlobalWrites("lookupType"),
    defaultPolicyAdapter.middleware("lookupType", "write"),
    lookuptypeController.createNewLookupType
  )
  .put(
    freezeGlobalWrites("lookupType"),
    defaultPolicyAdapter.middleware("lookupType", "write"),
    lookuptypeController.updateLookupType
  )
  .delete(
    freezeGlobalWrites("lookupType"),
    defaultPolicyAdapter.middleware("lookupType", "delete"),
    lookuptypeController.deleteLookupType
  );

router
  .route("/lookuptype/:id")
  .get(
    requireTrustedTenant,
    defaultPolicyAdapter.middleware("lookupType", "read"),
    lookuptypeController.getLookupType
  );

module.exports = router;
