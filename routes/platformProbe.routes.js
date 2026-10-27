/**
 * Phase B / Z2: DEV-only platform authorization probe - the ONLY enforcing consumer of
 * requirePlatformPermission in Z2 (owner decision D5: kept in DEV through Z5, never enabled on UAT).
 *
 *   GET /api/platform/authz-probe/:permission
 *     400 - :permission is not an exact catalogue code (nothing evaluated)
 *     401 - no / invalid ProjectShell JWT, or token identity != request identity
 *     403 PLATFORM_AUTHORITY_REQUIRED - any other reason (same body for all)
 *     200 { allowed: true, permission } - nothing else: no principal details, no business or platform data
 *
 * Mounted only when PLATFORM_AUTHZ_PROBE=on (exact value) at boot; otherwise the path does not exist.
 * Middleware is attached to this one route (not router.use) so no other request is affected.
 */
const express = require("express");
const { authenticate, tenantContextWarn } = require("../middlewares/auth");
const { requirePlatformPermission } = require("../middlewares/requirePlatformPermission");
const { PLATFORM_PERMISSIONS, isPlatformPermission } = require("../constants/platformPermissions");

const router = express.Router();
const guards = Object.fromEntries(PLATFORM_PERMISSIONS.map((code) => [code, requirePlatformPermission(code, { mode: "route-enforce" })]));

router.get(
  "/platform/authz-probe/:permission",
  authenticate,
  tenantContextWarn,
  (req, res, next) => {
    const code = req.params.permission;
    if (!isPlatformPermission(code)) {
      return res.status(400).json({ error: { message: "Unknown platform permission", code: "UNKNOWN_PLATFORM_PERMISSION", status: 400 } });
    }
    return guards[code](req, res, next);
  },
  (req, res) => {
    if (!req.platform || req.platform.permission !== req.params.permission) {
      return res.status(403).json({ error: { message: "Platform authority required", code: "PLATFORM_AUTHORITY_REQUIRED", status: 403 } });
    }
    return res.status(200).json({ allowed: true, permission: req.platform.permission });
  }
);

const probeEnabled = () => process.env.PLATFORM_AUTHZ_PROBE === "on";

module.exports = { router, probeEnabled };
