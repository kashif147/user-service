const crypto = require("crypto");
const { verifyProjectShellToken } = require("../middlewares/auth");
const { isPlatformPermission } = require("../constants/platformPermissions");
const { evaluatePlatformPermission } = require("../services/platformAuthorizationService");

/**
 * Phase B / Z5 (owner decision D4): the central platform-authorization check for NON-user services.
 *
 *   POST /internal/platform-auth/check            (mounted OUTSIDE /api: the gateway proxies only
 *   x-service-secret: <PLATFORM_AUTH_CHECK_SECRET>  /user-service/{api,auth,pkce}/..., so this path is not
 *   Authorization: Bearer <the end user's ProjectShell JWT, forwarded unchanged>   publicly reachable)
 *   { "permission": "<exact platform permission code>" }
 *
 * "Does this authenticated platform actor currently hold EXACT permission X?" - answered by the same
 * evaluator as requirePlatformPermission (services/platformAuthorizationService.js): verified HS256 ProjectShell
 * JWT, a well-formed `plat` claim, the LIVE PlatformPrincipal (active, current revision), the token user still
 * bound to the principal's Entra identity, the exact permission (no wildcard / prefix / hierarchy).
 *
 * Caller trust: a shared service secret (constant-time compare; unset / short secret = every call 403 - the
 * same fail-closed shape as the other /internal surfaces). The ACTOR is never taken from the caller: the
 * identity is the verified token's own user + tenant. Caller-supplied x-user-id / x-tenant-id headers are
 * allowed only if they equal the token's (otherwise denied as forgery); the body may carry only
 * `permission` (anything else - user, tenant, pid, plat, role - is refused).
 *
 * Response (minimum): 200 { allowed: true, permission, pid } | 403 { allowed: false } |
 *                     401 { allowed: false } (not a valid ProjectShell token) | 400 (bad request shape).
 * Never: oid, email, issuer, the principal record, its permission list, token contents, or the reason.
 * Any error = 403 { allowed: false } (fail closed: a caller must treat anything but 200 allowed:true as deny).
 * Log: one `[platform-authz-check]` line - allowed, reason, permission, masked pid / user, caller tenant,
 * calling service (x-service-name, informational), correlation id. Decision primitive only: the calling
 * service audits its own enforced operation.
 */
const MIN_SECRET_LENGTH = 32;
const mask = (v) => (v ? `…${String(v).slice(-6)}` : null);

function secretMatches(provided) {
  const secret = process.env.PLATFORM_AUTH_CHECK_SECRET;
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) return false;
  if (typeof provided !== "string") return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

function requirePlatformAuthCheckSecret(req, res, next) {
  if (!secretMatches(req.headers["x-service-secret"])) {
    return res.status(403).json({ allowed: false });
  }
  return next();
}

function log(req, fields) {
  console.info("[platform-authz-check]", JSON.stringify({
    event: "platform.authz.check",
    ...fields,
    caller: typeof req.headers["x-service-name"] === "string" ? req.headers["x-service-name"].slice(0, 64) : null,
    correlationId: req.headers["x-correlation-id"] || null,
  }));
}

async function checkPlatformPermission(req, res) {
  try {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
    if (!body || Object.keys(body).some((k) => k !== "permission")) {
      return res.status(400).json({ allowed: false, error: "only { permission } is accepted" });
    }
    const permission = body.permission;
    if (typeof permission !== "string" || !isPlatformPermission(permission)) {
      return res.status(400).json({ allowed: false, error: "permission must be an exact platform permission code" });
    }

    // The actor is the verified token's own identity - never a caller-supplied one.
    const authorization = req.headers.authorization;
    const token = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const verified = token ? verifyProjectShellToken(token) : { valid: false };
    if (!verified.valid || !verified.payload) {
      log(req, { allowed: false, reason: token ? "jwt_invalid" : "jwt_missing", permission });
      return res.status(401).json({ allowed: false });
    }
    const userId = verified.payload.id || verified.payload.sub;
    const tenantId = verified.payload.tenantId;
    const hintedUser = req.headers["x-user-id"];
    const hintedTenant = req.headers["x-tenant-id"];
    if ((hintedUser !== undefined && String(hintedUser) !== String(userId)) ||
        (hintedTenant !== undefined && String(hintedTenant) !== String(tenantId))) {
      log(req, { allowed: false, reason: "caller_identity_mismatch", permission, actorUserId: mask(userId), actorTenantId: tenantId || null });
      return res.status(403).json({ allowed: false });
    }

    const d = await evaluatePlatformPermission({
      authorization,
      ctx: { userId: userId ? String(userId) : undefined, tenantId: tenantId ? String(tenantId) : undefined },
      permission,
      verifyToken: verifyProjectShellToken,
    });
    log(req, { allowed: d.allowed, reason: d.reason, permission, pid: mask(d.pid), tokenRev: d.tokenRev, currentRev: d.currentRev, actorUserId: mask(userId), actorTenantId: tenantId || null });
    if (d.allowed) return res.status(200).json({ allowed: true, permission, pid: String(d.pid) });
    return res.status(d.status === 401 ? 401 : 403).json({ allowed: false });
  } catch (err) {
    try { log(req, { allowed: false, reason: "check_error" }); } catch (_) { /* never let logging break the answer */ }
    return res.status(403).json({ allowed: false });
  }
}

module.exports = { requirePlatformAuthCheckSecret, checkPlatformPermission, MIN_SECRET_LENGTH };
