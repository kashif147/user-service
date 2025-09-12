const express = require("express");
const router = express.Router();

router.use("/auth", require("./auth.routes"));
router.use("/token", require("./token.routes"));
router.use("/pkce", require("./pkce.routes"));

// Centralized RBAC Policy Evaluation API
router.use("/policy", require("./policy.routes"));

// Role management API routes (for ProjectShell-1 to consume)
router.use("/api", require("./role.routes"));

// Tenant management API routes
router.use("/api", require("./tenant.routes"));

// Permission management API routes
router.use("/api", require("./permission.routes"));

// Tenant-scoped management API routes (for ASU users)
router.use("/api", require("./tenantScoped.routes"));

module.exports = router;
