/**
 * Phase B / Z6: cross-tenant tenant administration by a platform principal (owner brief Z6).
 *
 * The Z6 routes (routes/tenant.routes.js) are SHARED: tenant actors keep their existing own-tenant chain
 * byte-for-byte, a platform principal is authorized by platform authority alone. Each shared route is registered
 * twice on the same method + path: first `platformTenantAdmin(code, ...)` + the controller, then the unchanged
 * tenant chain + the controller. This guard decides which one runs:
 *
 *   no verified platform claim (no_plat, or no / invalid / context-mismatched Bearer) -> next("route"): the tenant
 *        chain runs exactly as before (legacy SU with "*", ASU, ordinary users: own tenant only). Not audited
 *        here - the caller attempted no platform action.
 *   PLATFORM_AUTH_MODE=off -> next("route") too: nobody holds platform authority, the tenant chain decides.
 *   a platform claim is present -> the platform decision is FINAL (no fallback to tenant roles):
 *        deny (permission_missing, stale_rev, disabled, binding_lost, malformed, lookup_error) -> 403
 *        PLATFORM_AUTHORITY_REQUIRED; allow -> target validation -> the controller.
 *   The global mode stays shadow; these routes enforce for platform principals regardless (as Z5 route-enforce).
 *
 * Target tenant: ONLY the explicit route parameter (`target`, e.g. :id) - never x-target-tenant-id, a body or
 * query value, the org code or the Entra tid. Authority is evaluated first and separately (may P do X to ANY
 * tenant?); then the target (24-hex -> else 400; exists -> else 404). The target is not a credential.
 * On allow: req.platform = { pid, permission, targetTenantId, loginTenantId } (frozen, non-enumerable).
 * req.ctx.tenantId is NOT touched: it stays the authenticated sign-in tenant (context only, never privileged).
 *
 * Audit (services/platformAuditService.js): every platform decision -> platform.authz.decision.v1 with the
 * target (reads and denials are platform-only). Mutations (`change`) additionally emit the outcome on response
 * finish -> platform.tenant.admin.changed.v1 (+ the approved tenant copy on success).
 */
const Tenant = require("../models/tenant.model");
const { verifyProjectShellToken } = require("./auth");
const { isPlatformPermission } = require("../constants/platformPermissions");
const { platformAuthMode } = require("../services/platformClaimService");
const { evaluatePlatformPermission, REASONS } = require("../services/platformAuthorizationService");
const { auditAuthzDecision, auditTenantAdminChange } = require("../services/platformAuditService");

const OBJECT_ID = /^[0-9a-f]{24}$/;
const NOT_A_PLATFORM_ACTOR = new Set([REASONS.NO_PLAT, REASONS.JWT_MISSING, REASONS.JWT_INVALID, REASONS.JWT_CTX_MISMATCH]);
const STATUSES = new Set(["ACTIVE", "INACTIVE", "SUSPENDED", "PENDING"]);
const mask = (v) => (v ? `…${String(v).slice(-6)}` : null);

const fail = (res, status, message, code) => res.status(status).json({ error: { message, code, status } });

function logDecision(req, permission, mode, d, target, status) {
  console.info("[platform-authz]", JSON.stringify({
    event: "platform.authz.decision",
    mode,
    effective: "enforce",
    allowed: d.allowed,
    reason: d.reason,
    permission,
    pid: mask(d.pid),
    tokenRev: d.tokenRev,
    currentRev: d.currentRev,
    revMatch: d.revMatch,
    actorTenantId: req.ctx?.tenantId || null,
    actorUserId: mask(req.ctx?.userId),
    targetTenantId: target || null,
    status,
    route: `${req.method} ${(req.baseUrl || "") + (req.route?.path || "")}`,
    correlationId: req.correlationId || req.headers?.["x-correlation-id"] || null,
  }));
}

/** Status change -> lifecycle action (from the tenant's status before the change). */
function statusAction(fromStatus, toStatus) {
  if (toStatus === "SUSPENDED") return "TENANT_SUSPENDED";
  if (toStatus === "ACTIVE" && (fromStatus === "SUSPENDED" || fromStatus === "INACTIVE")) return "TENANT_REACTIVATED";
  return "TENANT_STATUS_CHANGED";
}

/**
 * @param {string} code    exact platform permission (constants/platformPermissions.js)
 * @param {object} [opts]
 * @param {string} [opts.target]   route parameter naming the target tenant (omit only for the global list)
 * @param {string|"status"} [opts.change]  mutation action recorded on finish ("status" = derived from the change);
 *                                         omit for reads
 * @param {string} [opts.section]  safe section label for the outcome / tenant copy
 */
function platformTenantAdmin(code, { target, change, section } = {}) {
  if (!isPlatformPermission(code)) throw new Error(`platform tenant admin: unknown platform permission code "${code}"`);
  if (target !== undefined && (typeof target !== "string" || !target)) throw new Error("platform tenant admin: target must be a route parameter name");
  if (change !== undefined && !target) throw new Error("platform tenant admin: a mutation needs a target tenant");

  return async function platformTenantAdminGuard(req, res, next) {
    const mode = platformAuthMode();
    if (mode === "off") return next("route");
    let d;
    try {
      d = await evaluatePlatformPermission({ authorization: req.headers?.authorization, ctx: req.ctx, permission: code, verifyToken: verifyProjectShellToken });
    } catch (err) {
      d = { allowed: false, status: 403, reason: REASONS.LOOKUP_ERROR, pid: null, tokenRev: null, currentRev: null, revMatch: null };
    }
    if (!d.allowed && NOT_A_PLATFORM_ACTOR.has(d.reason)) return next("route");

    // Platform actor: authority decided; now the explicit target (never before authority is known).
    const requested = target ? String(req.params?.[target] ?? "") : null;
    let tenant = null;
    let status = d.allowed ? 200 : 403;
    if (target) {
      if (!OBJECT_ID.test(requested)) {
        if (d.allowed) status = 400;
      } else {
        try {
          tenant = await Tenant.findOne({ _id: requested }).select({ _id: 1, status: 1 }).lean();
        } catch (err) {
          tenant = null;
          if (d.allowed) { d = { ...d, allowed: false, reason: REASONS.LOOKUP_ERROR }; status = 403; }
        }
        if (d.allowed && !tenant) status = 404;
      }
    }
    const targetTenantId = tenant ? String(tenant._id) : null;
    logDecision(req, code, mode, d, targetTenantId, status);
    auditAuthzDecision({ req, permission: code, mode, decision: d, status, targetTenantId });
    if (status === 403) return fail(res, 403, "Platform authority required", "PLATFORM_AUTHORITY_REQUIRED");
    if (status === 400) return fail(res, 400, "Invalid tenant id", "INVALID_TENANT_ID");
    if (status === 404) return fail(res, 404, "Tenant not found", "NOT_FOUND");

    Object.defineProperty(req, "platform", {
      value: Object.freeze({ pid: d.pid, permission: code, targetTenantId, loginTenantId: req.ctx?.tenantId ? String(req.ctx.tenantId) : null }),
      enumerable: false,
      configurable: true,
    });

    if (change) {
      const fromStatus = STATUSES.has(tenant?.status) ? tenant.status : undefined;
      res.on("finish", () => {
        try {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          const requestedStatus = change === "status" ? req.body?.status : undefined; // the status label only
          const toStatus = STATUSES.has(requestedStatus) ? requestedStatus : undefined;
          auditTenantAdminChange({
            req,
            action: change === "status" ? statusAction(fromStatus, toStatus) : change,
            result: ok ? "success" : "failure",
            status: res.statusCode,
            ...(ok ? {} : { reason: `http_${res.statusCode}` }),
            section,
            connectionId: req.params?.connectionId,
            ...(change === "status" ? { fromStatus, toStatus } : {}),
          });
        } catch (_) { /* audit never breaks the response */ }
      });
    }
    return next();
  };
}

module.exports = { platformTenantAdmin, statusAction };
