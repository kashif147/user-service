const express = require("express");
const router = express.Router();
const lookuptypeController = require("../controllers/lookuptype.ontroller.js");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");
const { requireTrustedTenant } = require("../middlewares/requireTrustedTenant");
const { freezeGlobalWrites } = require("../middlewares/globalDataFreeze");
// Phase B / Z2: shadow-only platform authorization observers (never change the response; Z5 migrates).
const { observePlatformPermission } = require("../middlewares/requirePlatformPermission");

router
  .route("/lookuptype")
  .get(
    requireTrustedTenant,
    defaultPolicyAdapter.middleware("lookupType", "read"),
    lookuptypeController.getAllLookupType
  )
  .post(
    observePlatformPermission("platform:reference-data:manage"),
    freezeGlobalWrites("lookupType"),
    defaultPolicyAdapter.middleware("lookupType", "write"),
    lookuptypeController.createNewLookupType
  )
  .put(
    observePlatformPermission("platform:reference-data:manage"),
    freezeGlobalWrites("lookupType"),
    defaultPolicyAdapter.middleware("lookupType", "write"),
    lookuptypeController.updateLookupType
  )
  .delete(
    observePlatformPermission("platform:reference-data:manage"),
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
