/**
 * Phase B / Z2: the platform authorization evaluator - "may this request exercise platform permission X?"
 *
 * Platform authority comes ONLY from, in this order:
 *   1. the request's ProjectShell JWT (Authorization: Bearer), verified here again (HS256, JWT_SECRET) -
 *      the gateway never forwards `plat` as a header and strips every client x-platform-* header;
 *   2. that token's user/tenant being the trusted request identity (req.ctx from authenticate);
 *   3. a `plat` claim of exactly { v, pid, rev } with v === 1;
 *   4. a live PlatformPrincipal read by pid: it exists, status "active", revision === rev;
 *   5. the token's user STILL bound to that principal's immutable Entra identity (issuer + oid) -
 *      owner decision D3, one extra indexed read;
 *   6. the exact requested permission among the principal's permissions.
 * Never consulted: tenant roles (SU, ASU), role level, the tenant wildcard "*", tenant permissions,
 * organisation code, email, x-* headers, request body, query or any client-supplied target tenant.
 * Matching is exact: no wildcard, no prefix, no hierarchy - one permission never implies another.
 *
 * Outcome: { allowed, status, reason, ... }. status 401 = not an authenticated ProjectShell request
 * (Bearer missing/invalid, or token identity != request identity); 403 = authenticated but no valid
 * platform authority (every other reason, including a lookup failure: fail closed). Reasons are for
 * logs only; callers get one public body (see middlewares/requirePlatformPermission.js).
 *
 * Read-only: it never writes anything.
 */
const mongoose = require("mongoose");
const PlatformPrincipal = require("../models/platformPrincipal.model");
const User = require("../models/user.model");
const { isPlatformPermission } = require("../constants/platformPermissions");
const { CLAIM_NAME, CLAIM_VERSION } = require("./platformClaimService");

const PID = /^[0-9a-f]{24}$/;
const CLAIM_KEYS = ["pid", "rev", "v"];

const REASONS = Object.freeze({
  ALLOWED: "allowed",
  JWT_MISSING: "jwt_missing",
  JWT_INVALID: "jwt_invalid",
  JWT_CTX_MISMATCH: "jwt_ctx_mismatch",
  NO_PLAT: "no_plat",
  MALFORMED_PLAT: "malformed_plat",
  BAD_VERSION: "bad_version",
  NOT_FOUND: "not_found",
  DISABLED: "disabled",
  STALE_REV: "stale_rev",
  BINDING_LOST: "binding_lost",
  PERMISSION_MISSING: "permission_missing",
  LOOKUP_ERROR: "lookup_error",
});

const isPlainObject = (v) => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

// Exactly { v, pid, rev }: integer v, 24-hex pid, integer rev >= 1. Anything else is malformed.
function wellFormedClaim(plat) {
  if (!isPlainObject(plat)) return false;
  const keys = Object.keys(plat).sort();
  if (keys.length !== CLAIM_KEYS.length || keys.some((k, i) => k !== CLAIM_KEYS[i])) return false;
  return Number.isInteger(plat.v) && typeof plat.pid === "string" && PID.test(plat.pid) && Number.isInteger(plat.rev) && plat.rev >= 1;
}

function bearerToken(authorization) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  return token || null;
}

/**
 * @param {{ authorization?: string, ctx?: {userId?: string, tenantId?: string}, permission: string,
 *           verifyToken: (token: string) => {valid: boolean, payload?: object} }} input
 * @returns {Promise<{ allowed: boolean, status: number, reason: string, pid: string|null,
 *           tokenRev: number|null, currentRev: number|null, revMatch: boolean|null }>}
 */
async function evaluatePlatformPermission({ authorization, ctx, permission, verifyToken }) {
  const out = (allowed, status, reason, extra = {}) => ({
    allowed, status, reason, pid: null, tokenRev: null, currentRev: null, revMatch: null, ...extra,
  });
  if (!isPlatformPermission(permission)) throw new Error("not a platform permission code");

  // 1. A verified ProjectShell JWT.
  const token = bearerToken(authorization);
  if (!token) return out(false, 401, REASONS.JWT_MISSING);
  const verified = verifyToken(token);
  if (!verified || !verified.valid || !isPlainObject(verified.payload)) return out(false, 401, REASONS.JWT_INVALID);
  const payload = verified.payload;

  // 2. The token is the trusted request identity (blocks one user's Bearer with another identity's context).
  const tokenUser = payload.id || payload.sub;
  if (!ctx || !ctx.userId || !ctx.tenantId || !tokenUser || String(tokenUser) !== String(ctx.userId) || String(payload.tenantId) !== String(ctx.tenantId)) {
    return out(false, 401, REASONS.JWT_CTX_MISMATCH);
  }

  // 3. The platform claim, exactly as user-service issues it.
  if (!Object.prototype.hasOwnProperty.call(payload, CLAIM_NAME)) return out(false, 403, REASONS.NO_PLAT);
  const plat = payload[CLAIM_NAME];
  if (!wellFormedClaim(plat)) return out(false, 403, REASONS.MALFORMED_PLAT);
  if (plat.v !== CLAIM_VERSION) return out(false, 403, REASONS.BAD_VERSION, { pid: plat.pid, tokenRev: plat.rev });
  const ids = { pid: plat.pid, tokenRev: plat.rev };

  // 4. The live principal.
  let principal;
  try {
    principal = await PlatformPrincipal.findById(plat.pid).select({ _id: 1, issuer: 1, oid: 1, status: 1, revision: 1, permissions: 1 }).lean();
  } catch (err) {
    return out(false, 403, REASONS.LOOKUP_ERROR, ids);
  }
  if (!principal) return out(false, 403, REASONS.NOT_FOUND, ids);
  const revs = { ...ids, currentRev: principal.revision, revMatch: principal.revision === plat.rev };
  if (principal.status !== "active") return out(false, 403, REASONS.DISABLED, revs);
  if (!revs.revMatch) return out(false, 403, REASONS.STALE_REV, revs);

  // 5. The token's (tenant-local) user is still bound to the principal's Entra identity.
  if (!mongoose.isValidObjectId(String(tokenUser))) return out(false, 403, REASONS.BINDING_LOST, revs);
  let user;
  try {
    user = await User.findOne({ _id: String(tokenUser), tenantId: String(payload.tenantId) })
      .select({ _id: 1, userType: 1, userMicrosoftId: 1, userIssuer: 1, isActive: 1 })
      .lean();
  } catch (err) {
    return out(false, 403, REASONS.LOOKUP_ERROR, revs);
  }
  if (!user || user.isActive === false || user.userType !== "CRM" ||
      typeof user.userMicrosoftId !== "string" || user.userMicrosoftId !== principal.oid ||
      typeof user.userIssuer !== "string" || user.userIssuer !== principal.issuer) {
    return out(false, 403, REASONS.BINDING_LOST, revs);
  }

  // 6. The exact permission.
  const held = Array.isArray(principal.permissions) ? principal.permissions : [];
  if (!held.includes(permission)) return out(false, 403, REASONS.PERMISSION_MISSING, revs);
  return out(true, 200, REASONS.ALLOWED, revs);
}

module.exports = { evaluatePlatformPermission, REASONS };
