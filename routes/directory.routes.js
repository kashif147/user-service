/**
 * P5 CRM user directory (catalogue code DIRECTORY_READ -> token string directory:read).
 *
 * Auth chain, per route: the standard router-level authenticate / tenantContextWarn /
 * requireTenant (scoped to /directory here), then requireVerifiedUserToken("directory", "read")
 * - the PDP verifies the caller's ORIGINAL user JWT (HS256) and evaluates directory:read from
 * the verified claims; tenant and identity come only from that result, a forwarded x-tenant-id
 * that differs is refused - then requireVerifiedCrmCaller (verified userType must be "CRM";
 * PORTAL / unknown -> 403 whatever permissions the token lists). Data: [{ id, displayName }] of
 * the verified tenant only. Lookup is POST so id lists never land in gateway access logs.
 */
const express = require("express");
const router = express.Router();
const { authenticate, requireTenant, tenantContextWarn } = require("../middlewares/auth");
const { requireVerifiedUserToken } = require("../middlewares/requireVerifiedUserToken");
const DirectoryController = require("../controllers/directory.controller");

router.use("/directory", authenticate, tenantContextWarn, requireTenant);

router.post(
  "/directory/users/lookup",
  requireVerifiedUserToken("directory", "read"),
  DirectoryController.requireVerifiedCrmCaller,
  DirectoryController.lookupDirectoryUsers
);

router.get(
  "/directory/users",
  requireVerifiedUserToken("directory", "read"),
  DirectoryController.requireVerifiedCrmCaller,
  DirectoryController.listDirectoryUsers
);

module.exports = router;
