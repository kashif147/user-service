/**
 * Phase B / Z2: platform authorization middleware (decision logic: services/platformAuthorizationService.js).
 *
 *   requirePlatformPermission(code, { mode })   - an enforcing guard (Z2: the DEV probe only; Z5: real routes)
 *   observePlatformPermission(code)             - a shadow observer for routes Z5 will migrate
 *
 * Mount after `authenticate` (needs req.ctx). `code` must be an exact catalogue code
 * (constants/platformPermissions.js); anything else throws when the route is defined, never per request.
 *
 * Modes (PLATFORM_AUTH_MODE: off | shadow | enforce, see services/platformClaimService.js):
 *   observePlatformPermission - off: next(), no evaluation, no log.
 *                               shadow / enforce: evaluate, log, ALWAYS next() - the route's status and body
 *                               are exactly what they would be without it; it is hard-capped at shadow, so it
 *                               can never deny, whatever the global mode. Evaluator errors are caught.
 *   requirePlatformPermission(code)                      - follows the global mode: off = next() (not
 *                               evaluated; the route's own guards decide), shadow = as the observer,
 *                               enforce = deny unless allowed.
 *   requirePlatformPermission(code, { mode: "route-enforce" }) - always enforces; off = deny without any
 *                               lookup (platform authorization switched off means nobody holds platform authority).
 * On an enforced allow it sets req.platform = { pid, permission } (frozen, non-enumerable); handlers use that,
 * never the token. Shadow never sets it.
 *
 * Public responses never say why: 401 is the usual unauthenticated body; every platform-authority failure
 * is the same 403 PLATFORM_AUTHORITY_REQUIRED body. The reason goes to the log line only.
 *
 * Audit (Phase B / Z4): enforced allow / 403 decisions are also published as platform.authz.decision.v1
 * (services/platformAuditService.js); shadow evaluations and 401s are not.
 *
 * Log: one `[platform-authz]` line per evaluation - mode, effective, allowed, reason, permission, masked pid,
 * token / current revision, caller tenant, masked user, method + route pattern, correlation id. Never the
 * JWT, the Authorization header, the claim object, oid, issuer, email or a full id.
 */
const { verifyProjectShellToken } = require("./auth");
const { isPlatformPermission } = require("../constants/platformPermissions");
const { platformAuthMode } = require("../services/platformClaimService");
const { evaluatePlatformPermission } = require("../services/platformAuthorizationService");
const { auditAuthzDecision } = require("../services/platformAuditService");

const PLATFORM_AUTHORITY_REQUIRED = "PLATFORM_AUTHORITY_REQUIRED";
const mask = (v) => (v ? `…${String(v).slice(-6)}` : null);

function forbidden(res) {
  return res.status(403).json({
    error: { message: "Platform authority required", code: PLATFORM_AUTHORITY_REQUIRED, status: 403 },
  });
}

function unauthorized(res) {
  return res.status(401).json({
    error: { message: "Authentication required", code: "AUTH_REQUIRED", status: 401, tokenError: true },
  });
}

function logDecision(req, permission, mode, effective, d) {
  console.info("[platform-authz]", JSON.stringify({
    event: "platform.authz.decision",
    mode,
    effective,
    allowed: d.allowed,
    reason: d.reason,
    permission,
    pid: mask(d.pid),
    tokenRev: d.tokenRev,
    currentRev: d.currentRev,
    revMatch: d.revMatch,
    actorTenantId: req.ctx?.tenantId || null,
    actorUserId: mask(req.ctx?.userId),
    route: `${req.method} ${(req.baseUrl || "") + (req.route?.path || "")}`,
    correlationId: req.correlationId || req.headers?.["x-correlation-id"] || null,
  }));
}

async function evaluate(req, permission) {
  return evaluatePlatformPermission({
    authorization: req.headers?.authorization,
    ctx: req.ctx,
    permission,
    verifyToken: verifyProjectShellToken,
  });
}

function assertCode(code) {
  if (!isPlatformPermission(code)) throw new Error(`platform authorization: unknown platform permission code "${code}"`);
}

function observePlatformPermission(code) {
  assertCode(code);
  return async function platformAuthzObserver(req, res, next) {
    const mode = platformAuthMode();
    if (mode === "off") return next();
    try {
      logDecision(req, code, mode, "shadow", await evaluate(req, code));
    } catch (err) {
      try {
        logDecision(req, code, mode, "shadow", { allowed: false, reason: "lookup_error", pid: null, tokenRev: null, currentRev: null, revMatch: null });
      } catch (_) { /* never let logging break the route */ }
    }
    return next();
  };
}

function requirePlatformPermission(code, { mode: routeMode } = {}) {
  assertCode(code);
  if (routeMode !== undefined && routeMode !== "route-enforce") throw new Error(`platform authorization: unknown route mode "${routeMode}"`);
  const observer = observePlatformPermission(code);
  return async function platformAuthzGuard(req, res, next) {
    const mode = platformAuthMode();
    if (routeMode !== "route-enforce") {
      if (mode === "off") return next();
      if (mode === "shadow") return observer(req, res, next);
    } else if (mode === "off") {
      return forbidden(res);
    }
    let d;
    try {
      d = await evaluate(req, code);
    } catch (err) {
      d = { allowed: false, status: 403, reason: "lookup_error", pid: null, tokenRev: null, currentRev: null, revMatch: null };
    }
    logDecision(req, code, mode, "enforce", d);
    // Phase B / Z4: an ENFORCED allow / 403 deny is a durable audit event (401 = unauthenticated, log only;
    // shadow observers stay log only). Fire-and-forget: never changes the response.
    if (d.allowed || d.status !== 401) auditAuthzDecision({ req, permission: code, mode, decision: d });
    if (!d.allowed) return d.status === 401 ? unauthorized(res) : forbidden(res);
    Object.defineProperty(req, "platform", { value: Object.freeze({ pid: d.pid, permission: code }), enumerable: false, configurable: true });
    return next();
  };
}

module.exports = { requirePlatformPermission, observePlatformPermission, PLATFORM_AUTHORITY_REQUIRED };
