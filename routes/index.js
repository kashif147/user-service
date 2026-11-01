const express = require("express");
const router = express.Router();

router.use("/auth", require("./auth.routes"));
router.use("/token", require("./token.routes"));
router.use("/pkce", require("./pkce.routes"));
// Phase 1C-2Y: POST /sessions (B2C id_token -> internal JWT) was removed. It never worked
// (createSession was registered unbound), had no live caller, and duplicated the hardened
// /auth/azure-portal PKCE + nonce login with weaker checks.

// Centralized RBAC Policy Evaluation API
router.use("/policy", require("./policy.routes"));

// =====================================================
// Internal service-to-service APIs
// IMPORTANT: keep these before generic /api routers
// that apply authenticate globally.
// =====================================================

// B2C connector first: Basic-auth only, must not pass through the JWT router.use() of the routers below.
router.use("/api", require("./b2cConnector.routes"));
router.use("/api", require("./tenantLifecycle.routes"));
router.use("/api", require("./internalRoleAccess.routes"));
router.use("/api", require("./internalMsTokenVerification.routes"));
// Phase B / Z5 (D4): central platform-auth check - outside /api on purpose (not proxied by the gateway).
router.use("/internal", require("./internalPlatformAuth.routes"));

// Phase B / Z2: DEV-only platform authorization probe (PLATFORM_AUTHZ_PROBE=on at boot; absent otherwise).
// Its middleware is per-route, so it changes nothing for any other request.
{
  const platformProbe = require("./platformProbe.routes");
  if (platformProbe.probeEnabled()) router.use("/api", platformProbe.router);
}

// =====================================================
// Standard authenticated APIs
// =====================================================

// Phase B / P1: platform provisioning control plane (platform:provisioning:admin only). Before the tenant
// routers: its own authenticate is scoped to /api/platform/provisioning.
router.use("/api", require("./provisioning.routes"));

// Role management API routes (for ProjectShell-1 to consume)
router.use("/api", require("./role.routes"));

// Tenant management API routes
router.use("/api", require("./tenant.routes"));
router.use("/api", require("./tenantOffice.routes"));
router.use("/api", require("./tenantPublicHoliday.routes"));
router.use("/api", require("./tenantDepartment.routes"));
router.use("/api", require("./tenantContact.routes"));

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
router.use("/api", require("./contact.routes"));
router.use("/api", require("./contactType.routes"));
// router.use("/countries", require("./country.routes"));

// User management API routes
router.use("/api", require("./user.routes"));

// User profile endpoint
router.use("/", require("./me.routes"));

module.exports = router;
