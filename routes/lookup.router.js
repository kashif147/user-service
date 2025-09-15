const express = require("express");
const router = express.Router();
const lookupController = require("../controllers/lookup.controller.js");
const { ROLE_HIERARCHY } = require("../config/roleHierarchy.js");
const verifyRoles = require("../middlewares/verifyRoles.js");

router
  .route("/")
  .get(lookupController.getAllLookup)
  .post(
    verifyRoles(ROLE_HIERARCHY.SU, ROLE_HIERARCHY.ASU),
    lookupController.createNewLookup
  )
  .put(
    verifyRoles(ROLE_HIERARCHY.SU, ROLE_HIERARCHY.ASU),
    lookupController.updateLookup
  )
  .delete(verifyRoles(ROLE_HIERARCHY.SU), lookupController.deleteLookup);

router.route("/:id").get(lookupController.getLookup);

module.exports = router;
