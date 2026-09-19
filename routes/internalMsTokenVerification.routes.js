const express = require("express");
const router = express.Router();
const InternalMsTokenVerificationController = require("../controllers/internalMsTokenVerification.controller");

/** Scope internal auth to /api/internal/verify-ms-token only (not all /api/* mounts) -
 * same /api/internal prefix convention as routes/internalRoleAccess.routes.js, gated by
 * the same requireInternalSecret (shared secret) pattern since a successful call here
 * establishes a fully trusted identity for every downstream service. Only ever called via
 * the nginx `internal;` subrequest location in frontend/ProjectShell-1/default.conf, never
 * reachable directly through the public gateway locations. */
const internalRouter = express.Router();
internalRouter.use(InternalMsTokenVerificationController.requireInternalSecret);

internalRouter.post(
  "/verify-ms-token",
  InternalMsTokenVerificationController.verifyMsToken,
);

router.use("/internal", internalRouter);

module.exports = router;
