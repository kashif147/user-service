const express = require("express");
const router = express.Router();
const lookuptypeController = require("../controllers/lookuptype.ontroller.js");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter.js");
const { requireTrustedTenant } = require("../middlewares/requireTrustedTenant");
// Phase B / Z5: platform-owned writes are enforced platform authorization (route-enforce; global mode stays shadow).
const { requirePlatformPermission } = require("../middlewares/requirePlatformPermission");

router
  .route("/lookuptype")
  .get(
    requireTrustedTenant,
    defaultPolicyAdapter.middleware("lookupType", "read"),
    lookuptypeController.getAllLookupType
  )
  .post(
    requirePlatformPermission("platform:reference-data:manage", { mode: "route-enforce", freeze: "lookupType" }), // Phase B / Z5: platform authority, then the A14 freeze
    lookuptypeController.createNewLookupType
  )
  .put(
    requirePlatformPermission("platform:reference-data:manage", { mode: "route-enforce", freeze: "lookupType" }), // Phase B / Z5: platform authority, then the A14 freeze
    lookuptypeController.updateLookupType
  )
  .delete(
    requirePlatformPermission("platform:reference-data:manage", { mode: "route-enforce", freeze: "lookupType" }), // Phase B / Z5: platform authority, then the A14 freeze
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
