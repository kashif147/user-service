const express = require("express");
const router = express.Router();
const InternalRoleAccessController = require("../controllers/internalRoleAccess.controller");

/** Scope internal auth to /api/internal/role-access/* only (not all /api/* mounts) - same
 * /api/internal prefix convention as routes/tenantLifecycle.routes.js, but gated by
 * requireInternalSecret (shared secret) rather than that file's weaker header-flag
 * requireInternal, since this surface returns user PII. */
const internalRouter = express.Router();
internalRouter.use(InternalRoleAccessController.requireInternalSecret);

internalRouter.get("/role-access/users-by-role-codes", InternalRoleAccessController.getUsersByRoleCodes);
internalRouter.get("/role-access/users/:userId", InternalRoleAccessController.getUserById);

router.use("/internal", internalRouter);

module.exports = router;
