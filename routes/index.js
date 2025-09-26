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

// Cache management API routes (Super User only)
router.use("/api", require("./cache.routes"));

router.use("/api", require("./lookup.router"));
router.use("/api", require("./lookuptype.router"));
router.use("/api", require("./productType.routes"));
router.use("/api", require("./product.routes"));
router.use("/api", require("./pricing.routes"));
router.use("/api", require("./country.routes"));
// router.use("/countries", require("./country.routes"));

// User profile endpoint
router.use("/", require("./me.routes"));

module.exports = router;
