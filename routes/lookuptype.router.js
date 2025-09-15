const express = require("express");
const router = express.Router();
const lookuptypeController = require("../controllers/lookuptype.ontroller.js");
const { ROLE_HIERARCHY } = require("../config/roleHierarchy.js");
const verifyRoles = require("../middlewares/verifyRoles.js");

router
  .route("/")
  .get(lookuptypeController.getAllLookupType)
  .post(
    verifyRoles(ROLE_HIERARCHY.SU, ROLE_HIERARCHY.ASU),
    lookuptypeController.createNewLookupType
  )
  .put(
    verifyRoles(ROLE_HIERARCHY.SU, ROLE_HIERARCHY.ASU),
    lookuptypeController.updateLookupType
  )
  .delete(
    verifyRoles(ROLE_HIERARCHY.SU),
    lookuptypeController.deleteLookupType
  );

router.route("/:id").get(lookuptypeController.getLookupType);

module.exports = router;
