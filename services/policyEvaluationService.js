const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { AppError } = require("../errors/AppError");
// Remove old hardcoded imports - now using database-driven services
const axios = require("axios");
const roleHierarchyService = require("./roleHierarchyService");
const permissionsService = require("./permissionsService");
const {
  isPlatformNamespace,
  tenantPermissionGranted,
  tenantWildcardCovers,
} = require("../constants/permissionClassification");

// Removed hardcoded DEFAULT_PERMISSIONS - now using database-driven permissionsService

// Removed old fetchPermissions function - now using database-driven permissionsService
const PolicyCache = require("./policyCache");

/**
 * Centralized RBAC Policy Evaluation Service
 *
 * This service implements a Policy Decision Point (PDP) that evaluates
 * authorization requests from various clients (mobile, web, microservices)
 * and returns policy decisions without exposing authorization logic.
 */

// Initialize cache
const cache = new PolicyCache({
  enabled: process.env.REDIS_ENABLED !== "false",
  ttl: parseInt(process.env.POLICY_CACHE_TTL) || 300, // 5 minutes
  prefix: "policy:",
});

// Initialize cache on startup
cache.initialize().catch((err) => {
  console.error("Failed to initialize policy cache:", err);
});

// Policy version management
const POLICY_VERSION = process.env.POLICY_VERSION || "1.0.0";

/**
 * Get current policy version
 */
const getPolicyVersion = () => POLICY_VERSION;
// Part of every decision-cache key (see evaluatePolicy). Phase B / Z9: tenant SU retired.
// P0 (PDP tenant invariant): bumped so no decision cached before the universal tenant invariant is reused.
const PDP_DECISION_EPOCH = "p5-audience"; // P5: catalogue audience; the mode is added per call (decisionEpoch)
// Phase B / Z9: SU is no longer a role. A token that still carries it predates the SU -> ASU migration
// and must not be honoured at all (not even as a tenant wildcard): the user signs in again and gets
// their current role (ASU). Never a reason to grant anything.
const RETIRED_ROLE_CODES = Object.freeze(["SU"]);
const carriesRetiredRole = (roles) =>
  Array.isArray(roles) && roles.some((r) => RETIRED_ROLE_CODES.includes(String(typeof r === "string" ? r : r && r.code).trim().toUpperCase()));

/**
 * P0 TENANT INVARIANT (owner-approved). The tenant PDP decides only for a request whose target tenant equals
 * the principal's VERIFIED tenant, for EVERY caller (ASU and non-ASU) and EVERY resource (including `tenant`):
 *   - target or principal tenant missing/empty  -> DENY MISSING_TENANT_CONTEXT
 *   - String(target) !== String(principal)      -> DENY TENANT_SCOPE_VIOLATION
 * There is no platform branch here: platform authority is decided only by the platform evaluator
 * (middlewares/requirePlatformPermission.js, middlewares/platformTenantAdmin.js) against the explicit
 * allow-list constants/platformPermissions.js, and Rule 0 below denies the platform namespace in this PDP.
 *
 * PDP_TENANT_INVARIANT_MODE (read per call; unknown value -> enforce, fail closed):
 *   enforce (default) - the invariant denies.
 *   shadow            - the pre-P0 decision is returned and every invariant violation is logged as
 *                       pdp.tenant_invariant.shadow: FULL principal and target tenant ids (tenant ids are not
 *                       secrets or personal data; full ids so two tenants can never collide), resource, action,
 *                       userType, old decision/reason -> new decision/reason. Never tokens, emails, names, roles or
 *                       permission lists. (A cross-tenant `tenant` request on the token path is logged here with the
 *                       invariant reason; under enforce the token entry check reports it as TENANT_MISMATCH.)
 *                       and a PERMIT the invariant would deny is NOT cached.
 *   off               - exactly the pre-P0 behaviour (rollback only).
 * The flag only gates the NEW denials: the ASU own-tenant rule and the token-path TENANT_MISMATCH check for
 * non-`tenant` resources are enforced in every mode, as before.
 */
const TENANT_INVARIANT_MODES = Object.freeze(["off", "shadow", "enforce"]);
let warnedInvalidInvariantMode = false;
function tenantInvariantMode() {
  const raw = process.env.PDP_TENANT_INVARIANT_MODE;
  if (raw === undefined || raw === "") return "enforce";
  const mode = String(raw).trim().toLowerCase();
  if (TENANT_INVARIANT_MODES.includes(mode)) return mode;
  if (!warnedInvalidInvariantMode) {
    warnedInvalidInvariantMode = true;
    console.warn("[PDP] PDP_TENANT_INVARIANT_MODE has an unknown value; treated as enforce");
  }
  return "enforce";
}
const isBlankTenant = (v) => v === undefined || v === null || String(v).trim() === "";
/** @returns {null|"MISSING_TENANT_CONTEXT"|"TENANT_SCOPE_VIOLATION"} */
function tenantInvariantViolation(targetTenantId, principalTenantId) {
  if (isBlankTenant(targetTenantId) || isBlankTenant(principalTenantId)) return "MISSING_TENANT_CONTEXT";
  if (String(targetTenantId) !== String(principalTenantId)) return "TENANT_SCOPE_VIOLATION";
  return null;
}
// Log value for a tenant id / short enum: String, capped (a caller-supplied target can be any value).
const logValue = (v) => (isBlankTenant(v) ? null : String(v).slice(0, 64));
function logInvariantShadow(ctx, violation, oldDecision) {
  console.warn("[PDP] tenant-invariant shadow", JSON.stringify({
    event: "pdp.tenant_invariant.shadow",
    principalTenantId: logValue(ctx.userTenantId),
    targetTenantId: logValue(ctx.tenantId),
    resource: logValue(ctx.resource),
    action: logValue(ctx.action),
    userType: logValue(ctx.userType),
    oldDecision: oldDecision.decision || null,
    oldReason: oldDecision.reason || null,
    newDecision: "DENY",
    newReason: violation,
    divergent: oldDecision.decision !== "DENY",
    correlationId: logValue(ctx.correlationId),
  }));
}

/**
 * P4/P5 PERMISSION AUDIENCE (bounded-pdp-implementation-proposal §1 P4, P5).
 *
 * Audience rule: for the EXACT resource:action requested, the caller's verified userType must be admitted by the
 * code's audience (CRM -> CRM; PORTAL/MEMBER -> PORTAL; BOTH -> both; SYSTEM / missing -> none), otherwise DENY
 * AUDIENCE_MISMATCH. It replaces the legacy per-resource category rule for that action only, at the category
 * rule's position - after the "holds a permission on this resource" gate and before the action / exact-permission
 * stages, so it can never skip them. Rules 0-1 (platform namespace, retired SU, tenant invariant, ASU own-tenant
 * admin) run before it and are unchanged in every mode.
 *
 * PDP_AUDIENCE_MODE (read per call):
 *   off (unset / "")  the audience is ignored (legacy category rule).
 *   shadow            the legacy decision is RETURNED (and cached); the PROPOSED audience decision (stored catalogue
 *                     audience, else constants/permissionAudience.js; stored LEGACY = legacy rule) is computed
 *                     alongside and logged as pdp.audience.shadow only when the final decisions differ.
 *   enforce           the CATALOGUE-ONLY audience decision is returned (catalogueAudienceDecision): the committed
 *                     map is never consulted. Per exact resource:action, over the active rows:
 *                       all rows LEGACY                      -> legacy category rule (deliberate)
 *                       all rows one typed value             -> the audience rule
 *                       any row with no audience             -> DENY AUDIENCE_DATA_MISSING   (not back-filled)
 *                       any row with an unknown value        -> DENY AUDIENCE_DATA_INVALID
 *                       rows disagree (incl. LEGACY + typed) -> DENY AUDIENCE_ALIAS_CONFLICT
 *                       no row for the exact action          -> DENY AUDIENCE_DATA_MISSING
 *                       the in-code fallback catalogue       -> DENY CATALOGUE_UNAVAILABLE (fallback rows are
 *                                                               tagged source:"fallback" by permissionsService)
 *                     None of these can fall back to the broader legacy rule; each data-quality denial is logged
 *                     as pdp.audience.enforce.data (rate-limited).
 *   anything else     -> enforce, with a one-time warning (fail closed; same as PDP_TENANT_INVARIANT_MODE).
 * Decision cache: the mode is part of the token-path cache identity (see decisionEpoch()), so switching mode in either
 * direction never reads back a decision cached under the other mode. Calling services' policy clients keep their own
 * in-memory 5-minute caches and must be recreated on every switch (rollout procedure).
 * Cache hits are never shadow-evaluated: the token path answers from its decision cache before applyPolicyRules,
 * and the calling services' policy clients answer from their own caches without reaching this service.
 */
const {
  PROPOSED_AUDIENCE,
  audienceClassOf,
  audienceAdmits,
} = require("../constants/permissionAudience");

const AUDIENCE_MODES = Object.freeze(["off", "shadow", "enforce"]);
const CATALOGUE_AUDIENCE_VALUES = Object.freeze(["CRM", "PORTAL", "BOTH", "LEGACY"]);
const AUDIENCE_DATA_REASONS = Object.freeze([
  "AUDIENCE_DATA_MISSING",
  "AUDIENCE_DATA_INVALID",
  "AUDIENCE_ALIAS_CONFLICT",
  "CATALOGUE_UNAVAILABLE",
]);

let warnedAudienceMode = false;
function audienceMode() {
  const raw = process.env.PDP_AUDIENCE_MODE;
  if (raw === undefined || raw === "") return "off";
  const mode = String(raw).trim().toLowerCase();
  if (AUDIENCE_MODES.includes(mode)) return mode;
  if (!warnedAudienceMode) {
    warnedAudienceMode = true;
    console.warn("[PDP] PDP_AUDIENCE_MODE has an unknown value; treated as enforce (fail closed)");
  }
  return "enforce";
}

const exactRows = (resourcePermissions, action) =>
  (resourcePermissions || []).filter(
    (p) => p && p.action && String(p.action).toLowerCase() === String(action || "").toLowerCase(),
  );

/**
 * SHADOW / comparison: PROPOSED audience decision (stored typed audience, else the committed map; stored LEGACY =
 * deliberately legacy and contributes nothing). Never used to return a decision.
 * @returns {null|{decision, reason, audience, source}} null -> no audience applies (legacy category rule).
 */
function audienceDecision(resourcePermissions, action, userType) {
  const exact = exactRows(resourcePermissions, action);
  const audiences = [];
  const sources = new Set();
  for (const p of exact) {
    if (p.audience === "LEGACY") continue;
    if (p.audience) {
      audiences.push(p.audience);
      sources.add("stored");
    } else if (PROPOSED_AUDIENCE[p.code]) {
      audiences.push(PROPOSED_AUDIENCE[p.code]);
      sources.add("map");
    }
  }
  if (audiences.length === 0) return null;
  const uniq = [...new Set(audiences)].sort();
  const audience = uniq.join("+");
  const source = [...sources].sort().join("+");
  const cls = audienceClassOf(userType);
  const admitted = uniq.every((a) => audienceAdmits(a, cls));
  return admitted
    ? { decision: "PERMIT", reason: "AUDIENCE_GRANTED", audience, source }
    : { decision: "DENY", reason: "AUDIENCE_MISMATCH", audience, source };
}

/**
 * ENFORCE: catalogue-only audience decision (see the table above). Never reads the committed map.
 * @returns {null|{decision, reason, audience, source}} null -> every exact row is LEGACY (legacy category rule).
 */
function catalogueAudienceDecision(resourcePermissions, action, userType) {
  const rows = resourcePermissions || [];
  const deny = (reason, audience = null) => ({ decision: "DENY", reason, audience, source: "catalogue" });
  if (rows.some((p) => p && p.source === "fallback")) return deny("CATALOGUE_UNAVAILABLE");
  const exact = exactRows(rows, action);
  if (exact.length === 0) return deny("AUDIENCE_DATA_MISSING");
  const values = exact.map((p) => (p.audience == null || p.audience === "" ? null : String(p.audience)));
  if (values.some((v) => v === null)) return deny("AUDIENCE_DATA_MISSING");
  if (values.some((v) => !CATALOGUE_AUDIENCE_VALUES.includes(v))) return deny("AUDIENCE_DATA_INVALID");
  const uniq = [...new Set(values)];
  if (uniq.length > 1) return deny("AUDIENCE_ALIAS_CONFLICT", uniq.sort().join("+"));
  if (uniq[0] === "LEGACY") return null;
  const cls = audienceClassOf(userType);
  return audienceAdmits(uniq[0], cls)
    ? { decision: "PERMIT", reason: "AUDIENCE_GRANTED", audience: uniq[0], source: "catalogue" }
    : deny("AUDIENCE_MISMATCH", uniq[0]);
}

let audienceEnforceDataLogged = 0;
function logAudienceEnforceData(ctx, aud) {
  audienceEnforceDataLogged += 1;
  if (audienceEnforceDataLogged > 20 && audienceEnforceDataLogged % 100 !== 0) return;
  console.warn("[PDP] audience enforce data", JSON.stringify({
    event: "pdp.audience.enforce.data",
    reason: aud.reason,
    audience: aud.audience || null,
    resource: logValue(ctx.resource),
    action: logValue(ctx.action),
    userType: logValue(ctx.userType),
    countSoFar: audienceEnforceDataLogged,
  }));
}

/** Test / operations hook: restart the enforce data-quality log rate limit. */
function resetAudienceEnforceDataLog() {
  audienceEnforceDataLogged = 0;
}

/** Part of the token-path decision-cache identity: semantics epoch + audience mode (decisions differ per mode). */
function decisionEpoch() {
  return `${PDP_DECISION_EPOCH}|aud:${audienceMode()}`;
}

function logAudienceShadow(ctx, oldDecision, newDecision) {
  console.warn("[PDP] audience shadow", JSON.stringify({
    event: "pdp.audience.shadow",
    resource: logValue(ctx.resource),
    action: logValue(ctx.action),
    userType: logValue(ctx.userType),
    oldDecision: oldDecision.decision || null,
    oldReason: oldDecision.reason || null,
    newDecision: newDecision.decision || null,
    newReason: newDecision.reason || null,
    audience: newDecision.audience || null,
    audienceSource: newDecision.audienceSource || null,
    principalTenantId: logValue(ctx.userTenantId),
    targetTenantId: logValue(ctx.tenantId),
    correlationId: logValue(ctx.correlationId),
  }));
}

/**
 * Shadow observability (failures are swallowed, and the shadow evaluation is awaited on the request path, so
 * both must be measured, not inferred):
 *   - a FAILURE is either an exception, or the audience pass reporting RESOURCE_EVALUATION_ERROR where the legacy
 *     pass did not (evaluateResourcePolicy catches internally, so an audience-code fault surfaces as that reason,
 *     never as a divergence). Each failure is logged as pdp.audience.shadow.error {resource, action, userType,
 *     kind, errorName} - the first AUDIENCE_SHADOW_ERROR_LOG_LIMIT per process, then every 100th - and counted.
 *   - LATENCY of the shadow pass alone (process.hrtime) is accumulated: count, total, max, and buckets.
 *   - pdp.audience.shadow.stats {evaluated, divergent, failed, ms*} is logged every AUDIENCE_SHADOW_STATS_EVERY
 *     shadow evaluations or 5 minutes, whichever comes first; getAudienceShadowStats() returns the same snapshot
 *     for an in-container read during the DEV window.
 */
const AUDIENCE_SHADOW_ERROR_LOG_LIMIT = 20;
const AUDIENCE_SHADOW_STATS_EVERY = 200;
const AUDIENCE_SHADOW_STATS_MS = 5 * 60 * 1000;
const LATENCY_BUCKETS_MS = Object.freeze([1, 5, 20, 100]);
const newShadowStats = () => ({
  evaluated: 0,
  divergent: 0,
  failed: 0,
  msTotal: 0,
  msMax: 0,
  msBuckets: { le1: 0, le5: 0, le20: 0, le100: 0, gt100: 0 },
  since: new Date().toISOString(),
});
let shadowStats = newShadowStats();
let shadowStatsLoggedAt = Date.now();

function recordShadowLatency(ms) {
  shadowStats.msTotal += ms;
  if (ms > shadowStats.msMax) shadowStats.msMax = ms;
  const b = LATENCY_BUCKETS_MS.find((x) => ms <= x);
  shadowStats.msBuckets[b === undefined ? "gt100" : `le${b}`] += 1;
}

function getAudienceShadowStats() {
  const s = shadowStats;
  return {
    ...s,
    msBuckets: { ...s.msBuckets },
    msTotal: Math.round(s.msTotal * 1000) / 1000,
    msMax: Math.round(s.msMax * 1000) / 1000,
    msAvg: s.evaluated ? Math.round((s.msTotal / s.evaluated) * 1000) / 1000 : 0,
  };
}

function resetAudienceShadowStats() {
  shadowStats = newShadowStats();
  shadowStatsLoggedAt = Date.now();
}

function maybeLogShadowStats() {
  const due = shadowStats.evaluated % AUDIENCE_SHADOW_STATS_EVERY === 0 || Date.now() - shadowStatsLoggedAt >= AUDIENCE_SHADOW_STATS_MS;
  if (!due) return;
  shadowStatsLoggedAt = Date.now();
  console.warn("[PDP] audience shadow stats", JSON.stringify({ event: "pdp.audience.shadow.stats", ...getAudienceShadowStats() }));
}

function logShadowFailure(ctx, kind, errorName) {
  shadowStats.failed += 1;
  const n = shadowStats.failed;
  if (n > AUDIENCE_SHADOW_ERROR_LOG_LIMIT && n % 100 !== 0) return;
  console.warn("[PDP] audience shadow error", JSON.stringify({
    event: "pdp.audience.shadow.error",
    kind,
    errorName: logValue(errorName),
    resource: logValue(ctx.resource),
    action: logValue(ctx.action),
    userType: logValue(ctx.userType),
    failedSoFar: n,
  }));
}

/** Shadow: compare the legacy decision with the audience decision; log only a divergence; never throw. */
async function shadowAudience(context, oldDecision) {
  const t0 = process.hrtime.bigint();
  try {
    const newDecision = await applyTenantPolicyRules(context, { useAudience: true });
    if (newDecision.reason === "RESOURCE_EVALUATION_ERROR" && oldDecision.reason !== "RESOURCE_EVALUATION_ERROR") {
      logShadowFailure(context, "evaluation_error", newDecision.reason);
    } else if (newDecision.decision !== oldDecision.decision) {
      shadowStats.divergent += 1;
      logAudienceShadow(context, oldDecision, newDecision);
    }
  } catch (err) {
    logShadowFailure(context, "exception", err && err.name);
  } finally {
    try {
      shadowStats.evaluated += 1;
      recordShadowLatency(Number(process.hrtime.bigint() - t0) / 1e6);
      maybeLogShadowStats();
    } catch (_e) {
      /* observability must never affect the request */
    }
  }
}

/**
 * Old vs proposed decision for one context, without logging and regardless of PDP_AUDIENCE_MODE. Used by the
 * read-only comparison harness and tests; never by a request path.
 */
async function compareAudienceDecision(context, { source = "proposed" } = {}) {
  const oldDecision = await applyTenantPolicyRules(context);
  const newDecision = await applyTenantPolicyRules(context, { useAudience: true, audienceSource: source });
  return { oldDecision, newDecision, divergent: oldDecision.decision !== newDecision.decision };
}

/**
 * Invalidate cache entries for a specific tenant or all entries
 */
const invalidateCache = async (tenantId = null) => {
  try {
    if (tenantId) {
      // Invalidate tenant-specific cache entries
      const keys = await cache.redis?.keys(`${cache.prefix}*:${tenantId}:*`);
      if (keys && keys.length > 0) {
        await cache.redis.del(keys);
      }
    } else {
      // Clear all cache
      await cache.clear();
    }
  } catch (error) {
    console.error("Cache invalidation error:", error);
  }
};

/**
 * Policy Decision Point - Main authorization evaluation function
 * @param {Object} request - Authorization request
 * @param {string} request.token - JWT token
 * @param {string} request.resource - Resource being accessed
 * @param {string} request.action - Action being performed
 * @param {Object} request.context - Additional context (optional)
 * @returns {Object} Policy decision
 */
const evaluatePolicy = async (request) => {
  const startTime = Date.now();
  const maxEvaluationTime = 3000; // 3 seconds max for policy evaluation

  try {
    const { token, resource, action, context = {} } = request;

    // Wrap evaluation in timeout
    const evaluationPromise = evaluatePolicyInternal(request);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Policy evaluation timeout")),
        maxEvaluationTime
      )
    );

    try {
      return await Promise.race([evaluationPromise, timeoutPromise]);
    } catch (timeoutError) {
      if (timeoutError.message === "Policy evaluation timeout") {
        console.error(
          `Policy evaluation timeout after ${
            Date.now() - startTime
          }ms for ${resource}:${action}`
        );
        return {
          decision: "DENY",
          reason: "EVALUATION_TIMEOUT",
          error: "Policy evaluation took too long",
          timestamp: new Date().toISOString(),
          policyVersion: POLICY_VERSION,
          correlationId: context.correlationId,
        };
      }
      throw timeoutError;
    }
  } catch (error) {
    console.error("Policy evaluation error:", error);
    return {
      decision: "DENY",
      reason: "EVALUATION_ERROR",
      error: error.message,
      timestamp: new Date().toISOString(),
      policyVersion: POLICY_VERSION,
      correlationId: request.context?.correlationId,
    };
  }
};

/**
 * Internal policy evaluation (without timeout wrapper)
 * @private
 */
const evaluatePolicyInternal = async (request) => {
  try {
    const { token, resource, action, context = {} } = request;

    // Check for authorization bypass (but still validate token)
    if (process.env.AUTH_BYPASS_ENABLED === "true") {
      console.log(
        `🚨 POLICY BYPASS TRIGGERED: ${resource}:${action} - NODE_ENV: ${process.env.NODE_ENV}`
      );
      // Still validate the token to ensure it's a valid JWT
      const tokenValidation = await validateToken(token);
      if (!tokenValidation.valid) {
        return {
          decision: "DENY",
          reason: "INVALID_TOKEN",
          error: tokenValidation.error,
          timestamp: new Date().toISOString(),
          policyVersion: POLICY_VERSION,
          correlationId: context.correlationId,
        };
      }

      // Token is valid, bypass authorization checks
      return {
        decision: "PERMIT",
        reason: "AUTHORIZATION_BYPASS_ENABLED",
        bypass: true,
        user: tokenValidation.user,
        timestamp: new Date().toISOString(),
        policyVersion: POLICY_VERSION,
        correlationId: context.correlationId,
      };
    }

    // Validate token parameter
    if (!token || typeof token !== "string") {
      return {
        decision: "DENY",
        reason: "INVALID_TOKEN",
        error: "Token is missing or invalid",
        timestamp: new Date().toISOString(),
        policyVersion: POLICY_VERSION,
        correlationId: context.correlationId,
      };
    }

    // Step 1 (Phase 1B SECURITY INVARIANT): cryptographically verify the token
    // BEFORE any authorization cache access. No cached decision may be trusted
    // for an unverified token, so validateToken() runs first and invalid/
    // expired/wrong-alg tokens fail closed here — before any cache lookup or
    // write. The cache key built later is derived only from the VERIFIED
    // identity, never from an unverified token prefix. The gateway/header path
    // (evaluatePolicyWithHeaders) is out of scope and unchanged.
    const tokenValidation = await validateToken(token);
    if (!tokenValidation.valid) {
      return {
        decision: "DENY",
        reason: "INVALID_TOKEN",
        error: tokenValidation.error,
        timestamp: new Date().toISOString(),
        policyVersion: POLICY_VERSION,
        correlationId: context.correlationId,
      };
    }

    const user = tokenValidation.user;
    // Ids only: the validated user carries the email (and roles/permissions) from the token.
    console.log("Token validated:", {
      userId: user?.id || null,
      tenantId: user?.tenantId || null,
      userType: user?.userType || null,
    });

    // Validate user object exists and has required properties
    if (!user || !user.id) {
      return {
        decision: "DENY",
        reason: "INVALID_USER_DATA",
        error: "User data is missing or invalid",
        timestamp: new Date().toISOString(),
        policyVersion: POLICY_VERSION,
        correlationId: context.correlationId,
      };
    }

    // Step 2: Extract authorization context with tenant isolation
    const authContext = {
      ...context,
      userId: user.id,
      tenantId: context.tenantId || user.tenantId, // Target tenant being accessed
      userTenantId: user.tenantId, // User's own tenant
      userType: user.userType,
      roles: user.roles || [],
      permissions: user.permissions || [],
      resource,
      action,
      correlationId: context.correlationId,
    };

    // Step 3: Check if tenantId is available
    if (!user.tenantId) {
      return {
        decision: "DENY",
        reason: "MISSING_TENANT_ID",
        error: "User tenantId is missing from token",
        timestamp: new Date().toISOString(),
        policyVersion: POLICY_VERSION,
        correlationId: context.correlationId,
      };
    }

    // Step 4: Apply tenant isolation check. P0: no longer skipped for the `tenant` resource (that skip let a
    // cross-tenant `tenant` request reach applyPolicyRules); "off" restores the pre-P0 skip (rollback only).
    const invariantMode = tenantInvariantMode();
    const step4Mismatch = !!context.tenantId && String(context.tenantId) !== String(user.tenantId);
    // (shadow: a cross-tenant `tenant` request continues to applyPolicyRules, which logs it with old -> new.)
    if (step4Mismatch && (resource !== "tenant" || invariantMode === "enforce")) {
      return {
        decision: "DENY",
        reason: "TENANT_MISMATCH",
        user: {
          id: user.id,
          tenantId: user.tenantId,
          userType: user.userType,
          roles: user.roles,
          permissions: user.permissions,
        },
        resource,
        action,
        timestamp: new Date().toISOString(),
        policyVersion: POLICY_VERSION,
        correlationId: context.correlationId,
      };
    }

    // Step 5: Build an identity-safe cache key from the VERIFIED identity plus
    // the request target. This replaces the previous token.substring(0, 8)
    // discriminator (constant "eyJhbGci" across all HS256 JWTs) so a forged or
    // different token can never collide onto another identity's cached
    // decision, and it is independent of the random correlationId so the SAME
    // verified identity can still reuse the cache.
    //
    // INVARIANT: the authorization cache key must include EVERY verified
    // identity attribute the PDP consumes for an allow/deny decision. Today
    // applyPolicyRules decides on userType (category match), roles (ASU own-
    // tenant admin rule + role-level fallback) and permissions (canonical match),
    // scoped by tenant — so all of those are in the digest below, with
    // deterministic property ordering. If future PDP logic becomes
    // context/ABAC dependent, this key MUST be updated to include those
    // attributes before they can safely influence cached decisions. Never
    // include the raw token, correlationId, email/PII, or unverified request
    // data here.
    const identityDigest = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          // Phase B / Z9 decision epoch: no decision cached before the tenant-SU retirement (e.g. a
          // legacy SU PERMIT) can ever be read back - bump when PDP semantics change.
          pdp: decisionEpoch(),
          id: user.id,
          tenantId: user.tenantId,
          userType: user.userType || null,
          roles: user.roles || [],
          permissions: user.permissions || [],
        })
      )
      .digest("hex")
      .slice(0, 16);
    const cacheKey = cache.generateKey(identityDigest, resource, action, {
      tenantId: context.tenantId || user.tenantId,
    });

    // Step 6: Cache lookup — reached only AFTER successful cryptographic
    // verification of the token.
    const cachedResult = cacheKey ? await cache.get(cacheKey) : null;
    if (cachedResult) {
      return {
        ...cachedResult,
        policyVersion: POLICY_VERSION,
        cached: true,
      };
    }

    // Step 7: Apply policy rules
    const policyDecision = await applyPolicyRules(authContext);

    const result = {
      decision: policyDecision.decision,
      reason: policyDecision.reason,
      user: {
        id: user.id,
        tenantId: user.tenantId,
        userType: user.userType,
        roles: user.roles,
        permissions: user.permissions,
      },
      resource,
      action,
      timestamp: new Date().toISOString(),
      expiresAt: tokenValidation.expiresAt,
      policyVersion: POLICY_VERSION,
      correlationId: context.correlationId,
    };

    // Step 8: Cache the result (fire and forget - don't wait). No tenant -> no cache key -> not cached.
    // P0 shadow: a PERMIT the invariant would deny is never cached, so switching shadow -> enforce takes effect
    // immediately instead of after the cache TTL.
    const shadowDivergent =
      result.decision === "PERMIT" &&
      tenantInvariantViolation(authContext.tenantId, authContext.userTenantId) !== null;
    if (cacheKey && !shadowDivergent) {
      cache
        .set(cacheKey, result)
        .catch((err) =>
          console.warn("Failed to cache policy result:", err.message)
        );
    }

    return result;
  } catch (error) {
    console.error("Policy evaluation error:", error);
    return {
      decision: "DENY",
      reason: "EVALUATION_ERROR",
      error: error.message,
      timestamp: new Date().toISOString(),
      policyVersion: POLICY_VERSION,
      correlationId: request.context?.correlationId,
    };
  }
};

/**
 * Validate JWT token
 * @param {string} token - JWT token
 * @returns {Object} Token validation result
 */
const validateToken = async (token) => {
  try {
    // Phase 1B (PDP chokepoint): the legacy token-fallback path must
    // CRYPTOGRAPHICALLY verify ProjectShell HS256 tokens instead of trusting an
    // unverified jwt.decode. Signature + expiry are enforced by jsonwebtoken and
    // the algorithm is strictly allowlisted to HS256, so `alg:none` and HS/RS
    // algorithm-confusion are rejected. RS256 (Entra/B2C) is verified upstream
    // (gateway /_internal/verify-ms-token) and reaches the PDP via the
    // gateway-header branch (evaluatePolicyWithHeaders), never here — so it is
    // intentionally NOT accepted on this path. The jwt.decode in
    // middlewares/auth.js and helpers/policyAdapter.js are separate parked
    // follow-ups, not changed here.
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      // Fail closed: never fall back to decoding unverified claims.
      console.warn("[PDP] Token verification failed: JWT_SECRET_MISSING");
      return { valid: false, error: "JWT_SECRET_MISSING" };
    }

    let decoded;
    try {
      decoded = jwt.verify(token, secret, {
        algorithms: ["HS256"],
        clockTolerance: 30,
      });
    } catch (err) {
      // Map to a safe reason code; never log the token, its claims, or the secret.
      let reason = "INVALID_SIGNATURE";
      if (err && err.name === "TokenExpiredError") {
        reason = "TOKEN_EXPIRED";
      } else if (err && err.name === "NotBeforeError") {
        reason = "TOKEN_NOT_ACTIVE";
      } else if (err && err.name === "JsonWebTokenError") {
        if (/invalid algorithm/i.test(err.message)) reason = "UNSUPPORTED_ALGORITHM";
        else if (/malformed|invalid token|must be provided/i.test(err.message)) reason = "MALFORMED_TOKEN";
        else reason = "INVALID_SIGNATURE";
      }
      console.warn(`[PDP] Token verification failed: ${reason}`);
      return { valid: false, error: reason };
    }

    if (!decoded || typeof decoded !== "object") {
      return { valid: false, error: "MALFORMED_TOKEN" };
    }

    // Extract tenantId with fallback options - prioritize tenantId, then tid, then extension_tenantId
    const tenantId =
      decoded.tenantId || decoded.tid || decoded.extension_tenantId;

    // Validate tenantId is present
    if (!tenantId) {
      return {
        valid: false,
        error: "Token missing tenantId field",
      };
    }

    // Normalize roles: extract role codes if roles are objects
    const normalizedRoles = Array.isArray(decoded.roles)
      ? decoded.roles
          .map((role) => (typeof role === "string" ? role : role?.code))
          .filter(Boolean)
      : [];

    return {
      valid: true,
      user: {
        id: decoded.sub || decoded.id,
        tenantId: tenantId,
        email: decoded.email,
        userType: decoded.userType,
        roles: normalizedRoles,
        permissions: decoded.permissions || [],
      },
      expiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null,
    };
  } catch (error) {
    // Fail closed; never leak the token or claims in logs.
    console.warn("[PDP] Token verification failed: INVALID_TOKEN");
    return { valid: false, error: "INVALID_TOKEN" };
  }
};

/**
 * Apply policy rules to determine authorization decision
 * @param {Object} context - Authorization context
 * @returns {Object} Policy decision
 */
const applyPolicyRules = async (context) => {
  const { roles, permissions, resource, action, tenantId } = context;

  // Rule 0 (Phase B / Z3): this is the TENANT policy decision point. A platform-namespace resource is
  // platform authority, decided only by the platform evaluator (middlewares/requirePlatformPermission.js)
  // from a PlatformPrincipal - never here, never by "*", never by the ASU tenant-admin rule below.
  if (isPlatformNamespace(String(resource || "")) || isPlatformNamespace(`${resource}:${action}`)) {
    return { decision: "DENY", reason: "PLATFORM_PERMISSION_NOT_TENANT_EVALUABLE" };
  }

  // Rule 0b (Phase B / Z9): a token still carrying the retired tenant SU role is refused outright.
  if (carriesRetiredRole(roles)) {
    return { decision: "DENY", reason: "RETIRED_ROLE_REAUTH_REQUIRED" };
  }

  // Rule 0c (P0 TENANT INVARIANT, see tenantInvariantViolation): every caller, every resource - including
  // `tenant` - is decided only inside the principal's own verified tenant. Missing either side fails closed.
  // Ordered after the platform-namespace and retired-SU refusals (their reason codes are pinned) and before
  // ASU, so ASU (an own-tenant admin) can never be cross-tenant.
  const invariantViolation = tenantInvariantViolation(tenantId, context.userTenantId);
  const audMode = audienceMode();
  // P5: enforce returns the catalogue-only audience decision; off / shadow return the legacy decision.
  const tenantRuleOptions = audMode === "enforce" ? { useAudience: true, audienceSource: "catalogue" } : {};
  let decision;
  if (invariantViolation) {
    const mode = tenantInvariantMode();
    if (mode === "enforce") return { decision: "DENY", reason: invariantViolation };
    decision = await applyTenantPolicyRules(context, tenantRuleOptions);
    if (mode === "shadow") logInvariantShadow(context, invariantViolation, decision);
  } else {
    decision = await applyTenantPolicyRules(context, tenantRuleOptions);
  }
  // P4: audience shadow - observes only; the returned decision is always the legacy one.
  if (audMode === "shadow") await shadowAudience(context, decision);
  return decision;
};

/**
 * Rules 1-5 (ASU own-tenant rule, then resource / action / permission), reached only after Rules 0-0c.
 * options.useAudience (P4 shadow / comparison only): the resource stage applies the proposed audience rule.
 */
const applyTenantPolicyRules = async (context, options = {}) => {
  const { roles, tenantId } = context;

  // Rule 1 (Phase B / Z9): ASU own-tenant administrative authority. The legacy tenant SU is retired;
  // ASU is the highest tenant role and this is an explicit tenant-admin rule, not a bypass. Order:
  // authentication and the trusted internal tenant (callers), Rule 0 above (a platform-namespace request
  // is ALWAYS denied here - only a PlatformPrincipal with the exact platform permission is authorized,
  // by the platform evaluator), then the tenant boundary below (the request tenant must be the actor's
  // own internal tenant), then ASU. Security invariants intentionally stronger than tenant
  // administration - the A14 GLOBAL_DATA_FROZEN freeze, tenant / User ownership immutability,
  // identity binding, platform catalogue / cache / reference-data protections - are enforced by the
  // services and models after this decision; a PERMIT here never overrides them. Never cross-tenant.
  if (roleHierarchyService.isTenantAdmin(roles)) {
    if (!tenantId || !context.userTenantId) {
      return { decision: "DENY", reason: "MISSING_TENANT_CONTEXT" };
    }
    if (String(tenantId) !== String(context.userTenantId)) {
      return { decision: "DENY", reason: "TENANT_SCOPE_VIOLATION" };
    }
    return {
      decision: "PERMIT",
      reason: "ASU_OWN_TENANT_ADMIN",
    };
  }

  // Rule 2: Tenant isolation check
  if (!tenantId) {
    return {
      decision: "DENY",
      reason: "MISSING_TENANT_CONTEXT",
    };
  }

  // Rule 3: Resource-specific policy evaluation
  const resourcePolicy = await evaluateResourcePolicy(context, options);
  if (resourcePolicy.decision !== "PERMIT") {
    return resourcePolicy;
  }

  // Rule 4: Action-specific policy evaluation
  const actionPolicy = await evaluateActionPolicy(context);
  if (actionPolicy.decision !== "PERMIT") {
    return actionPolicy;
  }

  // Rule 5: Permission-based evaluation
  const permissionPolicy = await evaluatePermissionPolicy(context);
  if (permissionPolicy.decision !== "PERMIT") {
    return permissionPolicy;
  }

  // Default: Permit if all checks pass
  const permit = {
    decision: "PERMIT",
    reason: "POLICY_SATISFIED",
  };
  // P4 shadow / comparison only: keep which audience admitted the request (for the shadow log).
  if (options.useAudience && resourcePolicy.audience) {
    permit.audience = resourcePolicy.audience;
    permit.audienceSource = resourcePolicy.audienceSource;
  }
  return permit;
};

/**
 * Evaluate resource-specific policies using database-driven permissions
 * @param {Object} context - Authorization context
 * @returns {Object} Policy decision
 */
const evaluateResourcePolicy = async (context, options = {}) => {
  const { resource, userType, roles, permissions, tenantId, userTenantId } =
    context;

  try {
    // Get all permissions for this resource from database
    const resourcePermissions =
      await permissionsService.getPermissionsByResource(resource);

    if (!resourcePermissions || resourcePermissions.length === 0) {
      console.log(`[EVALUATE_RESOURCE_POLICY] No permissions found for resource: ${resource}`);
      console.log(`[EVALUATE_RESOURCE_POLICY] Checking all permissions...`);
      const allPerms = await permissionsService.getAllPermissions();
      const matchingPerms = allPerms.filter(
        (p) => p.resource && p.resource.toLowerCase() === resource.toLowerCase()
      );
      console.log(`[EVALUATE_RESOURCE_POLICY] Permissions with resource '${resource}':`, matchingPerms);
      
      return {
        decision: "DENY",
        reason: "UNKNOWN_RESOURCE",
        error: `No permissions defined for resource '${resource}'`,
      };
    }
    
    console.log(`[EVALUATE_RESOURCE_POLICY] Found ${resourcePermissions.length} permission(s) for resource '${resource}':`, 
      resourcePermissions.map(p => ({ code: p.code, resource: p.resource, action: p.action }))
    );

    // CRITICAL: Check permissions array FIRST (from token/gateway headers)
    // This is the authoritative source - permissions come directly from user's token
    // Permissions in JWT are in canonical format (notification:read), not code format (NOTIFICATION_READ)
    const resourcePermissionCodes = resourcePermissions.map((p) => p.code);
    const resourcePermissionCanonical = resourcePermissions.map(
      (p) => `${p.resource.toLowerCase()}:${p.action.toLowerCase()}`
    );
    
    const hasPermissionFromArray =
      Array.isArray(permissions) &&
      permissions.some(
        (perm) =>
          resourcePermissionCodes.includes(perm) || // Check code format (backward compatibility)
          resourcePermissionCanonical.includes(perm) || // Check canonical format (current format)
          tenantWildcardCovers(permissions, String(resource)) // Tenant wildcard (never platform)
      );

    // Phase 1C-2G: the former "via roles" fallback (permissionsService.hasAnyPermission, which
    // resolved role CODES through a tenant-less, code-keyed role->permissions map) was removed.
    // It could never decide a final PERMIT: rule 5 requires the exact resource:action (or "*") in
    // the tenant-scoped token permissions, which already makes hasPermissionFromArray true.
    if (!hasPermissionFromArray) {
      console.log(`Resource permission check failed for ${resource}`, {
        resourcePermissionCodes,
        resourcePermissionCanonical,
        userPermissions: permissions,
        userRoles: roles,
        hasPermissionFromArray,
      });
      return {
        decision: "DENY",
        reason: "INSUFFICIENT_RESOURCE_PERMISSION",
        error: `User lacks any permission for resource '${resource}'`,
        availablePermissions: resourcePermissionCodes,
        availableCanonical: resourcePermissionCanonical,
        checkedPermissions: permissions,
        checkedRoles: roles,
      };
    }

    // Special handling for tenant resource - ASU can only manage their own tenant (Phase B / Z9: the
    // legacy tenant SU is retired; cross-tenant tenant administration is PlatformPrincipal-only, Z6).
    if (resource === "tenant") {
      const hasASURole = roles.includes("ASU");

      if (hasASURole) {
        if (!tenantId || !userTenantId) {
          return {
            decision: "DENY",
            reason: "MISSING_TENANT_CONTEXT",
          };
        }

        if (tenantId !== userTenantId) {
          return {
            decision: "DENY",
            reason: "TENANT_SCOPE_VIOLATION",
          };
        }

        return {
          decision: "PERMIT",
          reason: "ASU_OWN_TENANT_ACCESS",
        };
      }
    }

    // P4 (shadow / comparison only): the proposed audience rule for the exact action replaces the category
    // rule below; no audience on the exact row -> the category rule, unchanged.
    if (options.useAudience) {
      const aud =
        options.audienceSource === "catalogue"
          ? catalogueAudienceDecision(resourcePermissions, context.action, userType)
          : audienceDecision(resourcePermissions, context.action, userType);
      if (aud && options.audienceSource === "catalogue" && AUDIENCE_DATA_REASONS.includes(aud.reason)) {
        logAudienceEnforceData(context, aud);
      }
      if (aud) {
        return aud.decision === "PERMIT"
          ? { decision: "PERMIT", reason: "RESOURCE_ACCESS_GRANTED", audience: aud.audience, audienceSource: aud.source }
          : { decision: "DENY", reason: aud.reason, audience: aud.audience, audienceSource: aud.source };
      }
    }

    // Check user type based on permission categories
    const allowedCategories = resourcePermissions.map((p) => p.category);
    const userTypeCategory = getUserTypeCategory(userType);

    // Shared categories that are accessible by both PORTAL and CRM users
    const sharedCategories = ["COMMUNICATION", "NOTIFICATION", "API", "GENERAL"];

    // Allow access if:
    // 1. User type category matches permission category (e.g., PORTAL user with PORTAL permission)
    // 2. Permission category is a shared category (accessible by both PORTAL and CRM)
    // 3. No category restrictions (if no categories defined, allow access)
    const hasAccess =
      allowedCategories.length === 0 || // No category restrictions
      allowedCategories.includes(userTypeCategory) || // User type matches
      allowedCategories.some((cat) => sharedCategories.includes(cat)); // Shared category

    if (!hasAccess) {
      // Phase 1C-2M: `action` is not destructured in this function; read it from context (log only).
      console.log(`Category check failed for ${resource}:${context.action}`, {
        userType,
        userTypeCategory,
        allowedCategories,
        sharedCategories,
        resourcePermissions: resourcePermissions.map((p) => ({
          code: p.code,
          category: p.category,
        })),
      });
      return {
        decision: "DENY",
        reason: "INVALID_USER_TYPE",
        error: `User type '${userType}' not allowed for resource '${resource}'`,
        allowedCategories: allowedCategories,
        userTypeCategory: userTypeCategory,
      };
    }

    return {
      decision: "PERMIT",
      reason: "RESOURCE_ACCESS_GRANTED",
    };
  } catch (error) {
    console.error("Error in resource policy evaluation:", error);
    return {
      decision: "DENY",
      reason: "RESOURCE_EVALUATION_ERROR",
      error: error.message,
    };
  }
};

/**
 * Map user types to permission categories
 * @param {string} userType - User type
 * @returns {string} Permission category
 */
const getUserTypeCategory = (userType) => {
  const userTypeCategoryMap = {
    CRM: "CRM",
    MEMBER: "PORTAL",
    PORTAL: "PORTAL",
    SYSTEM: "ADMIN",
  };

  return userTypeCategoryMap[userType] || "GENERAL";
};

/**
 * Evaluate action-specific policies
 * @param {Object} context - Authorization context
 * @returns {Object} Policy decision
 */
const evaluateActionPolicy = async (context) => {
  const { action, permissions, resource } = context;

  // Action-specific role requirements
  const actionRequirements = {
    read: {
      minRoleLevel: 1, // Any authenticated user
    },
    create: {
      minRoleLevel: 30, // IO level and above (same as write)
    },
    write: {
      minRoleLevel: 30, // IO level and above
    },
    update: {
      minRoleLevel: 30, // IO level and above (same as write)
    },
    delete: {
      minRoleLevel: 60, // MO level and above
    },
    admin: {
      minRoleLevel: 80, // DIR level and above
    },
    super_admin: {
      minRoleLevel: 100, // no tenant role holds level 100 (Phase B / Z9: SU retired) - reserved
    },
  };

  const requirement = actionRequirements[action];
  if (!requirement) {
    return {
      decision: "DENY",
      reason: "UNKNOWN_ACTION",
    };
  }

  // CRITICAL: Check permissions array FIRST (from token/gateway headers)
  // Permissions are already normalized to canonical format: portal:create
  if (Array.isArray(permissions) && permissions.length > 0) {
    const requiredPermission = `${resource.toLowerCase()}:${action.toLowerCase()}`;

    // Check for exact match or wildcard (permissions already normalized)
    if (tenantPermissionGranted(permissions, requiredPermission)) {
      return {
        decision: "PERMIT",
        reason: "ACTION_AUTHORIZED_BY_PERMISSION",
      };
    }
  }

  // Phase 1C-2G: the former role-LEVEL fallback (roleHierarchyService.getHighestRoleLevel, a
  // tenant-less map keyed by role code) was removed. It could never decide a final PERMIT: rule 5
  // requires the exact resource:action (or "*") in the tenant-scoped token permissions, which the
  // check above already accepts. Without that permission the request is denied here instead.
  // (actionRequirements is still used to reject unknown actions.)
  const requiredPermission = `${resource.toLowerCase()}:${action.toLowerCase()}`;
  return {
    decision: "DENY",
    reason: "MISSING_PERMISSION",
    error: `User lacks required permission: ${requiredPermission}`,
    requiredPermission,
  };
};

/**
 * REMOVED: Permission normalization
 * Permissions are now normalized ONCE at JWT generation time
 * PDP expects permissions in canonical format: portal:create, portal:read, etc.
 */

/**
 * Evaluate permission-based policies using database-driven permissions
 * @param {Object} context - Authorization context
 * @returns {Object} Policy decision
 */
const evaluatePermissionPolicy = async (context) => {
  const { permissions, resource, action } = context;

  try {
    // Fetch permissions from database-driven service
    const allPermissions = await permissionsService.getAllPermissions();

    // Find the specific permission for this resource and action
    const requiredPermission = allPermissions.find(
      (perm) =>
        perm.resource.toLowerCase() === resource.toLowerCase() &&
        perm.action.toLowerCase() === action.toLowerCase()
    );

    if (!requiredPermission) {
      // If no specific permission found in database, check if there's a wildcard permission
      const hasWildcardPermission = tenantWildcardCovers(permissions, `${resource}:${action}`);
      if (hasWildcardPermission) {
        return {
          decision: "PERMIT",
          reason: "WILDCARD_PERMISSION",
        };
      }

      // Log for debugging - this helps identify missing permissions
      console.log(
        `No permission found for resource: ${resource}, action: ${action}`
      );
      console.log(
        `Available permissions for resource '${resource}':`,
        allPermissions.filter(
          (p) => p.resource.toLowerCase() === resource.toLowerCase()
        )
      );

      return {
        decision: "DENY",
        reason: "PERMISSION_NOT_DEFINED",
        error: `No permission defined for resource '${resource}' with action '${action}'`,
      };
    }

    // Build expected permission in canonical format (permissions are already normalized)
    const requiredPermissionCanonical = `${resource.toLowerCase()}:${action.toLowerCase()}`;

    // Check if user has the required permission (direct comparison - permissions already normalized)
    const hasPermission = tenantPermissionGranted(permissions, requiredPermissionCanonical); // exact or tenant "*"

    if (!hasPermission) {
      console.log(`Permission check failed for ${resource}:${action}`, {
        requiredCanonical: requiredPermissionCanonical,
        userPermissions: permissions,
      });
      return {
        decision: "DENY",
        reason: "MISSING_PERMISSION",
        error: `User lacks required permission: ${requiredPermissionCanonical}`,
        requiredPermission: requiredPermissionCanonical,
      };
    }

    return {
      decision: "PERMIT",
      reason: "PERMISSION_GRANTED",
      permission: requiredPermission.code,
    };
  } catch (error) {
    console.error("Error in permission policy evaluation:", error);
    return {
      decision: "DENY",
      reason: "PERMISSION_EVALUATION_ERROR",
      error: error.message,
    };
  }
};

/**
 * Batch policy evaluation for multiple requests
 * @param {Array} requests - Array of authorization requests
 * @returns {Array} Array of policy decisions
 */
const evaluateBatchPolicy = async (requests) => {
  const results = await Promise.all(
    requests.map((request) => evaluatePolicy(request))
  );
  return results;
};

/**
 * Get user's effective permissions for a resource
 * @param {string} token - JWT token
 * @param {string} resource - Resource name
 * @returns {Object} Effective permissions
 */
const getEffectivePermissions = async (token, resource) => {
  try {
    const tokenValidation = await validateToken(token);
    if (!tokenValidation.valid) {
      return {
        success: false,
        error: tokenValidation.error,
      };
    }

    const user = tokenValidation.user;
    const { roles, permissions } = user;

    // Validate user object exists
    if (!user || !user.id) {
      return {
        success: false,
        error: "User data is missing or invalid",
      };
    }

    if (carriesRetiredRole(roles)) {
      return { success: false, permissions: [], error: "Sign in again", reason: "RETIRED_ROLE_REAUTH_REQUIRED" };
    }
    // Phase B / Z9: ASU is the full administrator of its OWN tenant. Shown as the tenant wildcard "*"
    // (scope "tenant": never platform authority - a platform-namespace resource is not summarised this
    // way, and the PDP never lets "*" cover the platform namespace).
    if (roleHierarchyService.isTenantAdmin(roles) && !isPlatformNamespace(String(resource || ""))) {
      return {
        success: true,
        permissions: ["*"],
        scope: "tenant",
        roles: roles,
        reason: "ASU_OWN_TENANT_ADMIN",
      };
    }

    // Get resource-specific permissions
    const resourcePermissions = await getResourcePermissions(
      resource,
      roles,
      permissions
    );

    return {
      success: true,
      permissions: resourcePermissions,
      roles: roles,
      userType: user.userType,
      tenantId: user.tenantId,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
};

/**
 * Get permissions for a specific resource using database-driven lookup
 * @param {string} resource - Resource name
 * @param {Array} roles - User roles
 * @param {Array} permissions - User permissions
 * @returns {Array} Resource-specific permissions
 */
const getResourcePermissions = async (resource, roles, permissions) => {
  try {
    // Fetch permissions from database-driven service
    const allPermissions = await permissionsService.getAllPermissions();

    // Find all permissions for this resource
    const resourcePermissions = allPermissions
      .filter((perm) => perm.resource.toLowerCase() === resource.toLowerCase())
      .map((perm) => perm.code);

    // Filter permissions user actually has
    return resourcePermissions.filter(
      (permission) => tenantPermissionGranted(permissions, permission)
    );
  } catch (error) {
    console.error("Error getting resource permissions:", error);
    return [];
  }
};

/**
 * Evaluate policy using gateway headers instead of token
 *
 * CRITICAL: Gateway headers are the SINGLE SOURCE OF TRUTH
 * - Do NOT read userId from JWT
 * - Do NOT read userId from DB
 * - Do NOT read from Redis cache
 * - Do NOT reuse previous request context
 * - Do NOT override gateway headers with context values
 *
 * @param {Object} request - Authorization request with headers
 * @param {Object} request.headers - Request headers (including gateway headers)
 * @param {string} request.resource - Resource being accessed
 * @param {string} request.action - Action being performed
 * @param {Object} request.context - Additional context (for correlationId only)
 * @returns {Object} Policy decision
 */
const evaluatePolicyWithHeaders = async (request) => {
  const { headers, resource, action, context = {} } = request;

  // STEP 1: Extract user context ONLY from gateway headers (authoritative source)
  // Never override these values from context, JWT, DB, or cache
  const userId = headers["x-user-id"];
  const tenantId = headers["x-tenant-id"];
  const userEmail = headers["x-user-email"];
  const userType = headers["x-user-type"];
  const userRolesStr = headers["x-user-roles"] || "[]";
  const userPermissionsStr = headers["x-user-permissions"] || "[]";

  // Validate required gateway headers
  if (!userId || !tenantId) {
    return {
      decision: "DENY",
      reason: "INVALID_HEADERS",
      error: "Missing required gateway headers: x-user-id or x-tenant-id",
      timestamp: new Date().toISOString(),
      policyVersion: POLICY_VERSION,
      correlationId: context.correlationId,
    };
  }

  // Parse roles and permissions from headers
  let roles = [];
  let permissions = [];

  try {
    const rolesArray = JSON.parse(userRolesStr);
    roles = Array.isArray(rolesArray)
      ? rolesArray
          .map((role) => (typeof role === "string" ? role : role?.code))
          .filter(Boolean)
      : [];
  } catch (e) {
    console.warn("Failed to parse x-user-roles:", e.message);
  }

  try {
    permissions = JSON.parse(userPermissionsStr);
    if (!Array.isArray(permissions)) permissions = [];
  } catch (e) {
    console.warn("Failed to parse x-user-permissions:", e.message);
  }

  // STEP 2: Build user object ONLY from gateway headers
  // Never fetch from DB, Redis, or JWT
  const user = {
    id: userId, // From x-user-id header (authoritative)
    tenantId: tenantId, // From x-tenant-id header (authoritative)
    email: userEmail, // From x-user-email header (informational)
    userType: userType, // From x-user-type header (authoritative)
    roles: roles, // From x-user-roles header (authoritative)
    permissions: permissions, // From x-user-permissions header (authoritative)
  };

  // STEP 3: Build authorization context using ONLY gateway header values
  // Never override with context.tenantId or any other source
  const authContext = {
    userId: user.id, // From x-user-id (never override)
    tenantId: user.tenantId, // From x-tenant-id (never override)
    userTenantId: user.tenantId, // Same as tenantId (from headers)
    userType: user.userType, // From x-user-type (never override)
    roles: user.roles, // From x-user-roles (never override)
    permissions: user.permissions, // From x-user-permissions (never override)
    resource,
    action,
    correlationId: context.correlationId || headers["x-correlation-id"],
  };

  // STEP 4: Apply policy rules (no caching, no DB lookups)
  const policyDecision = await applyPolicyRules(authContext);

  // STEP 5: Return decision with user object built ONLY from headers
  return {
    ...policyDecision,
    user,
    timestamp: new Date().toISOString(),
    policyVersion: POLICY_VERSION,
    correlationId: authContext.correlationId,
  };
};

/**
 * Get effective permissions using gateway headers
 * @param {Object} headers - Request headers (including gateway headers)
 * @param {string} resource - Resource name
 * @returns {Object} Effective permissions
 */
const getEffectivePermissionsWithHeaders = async (headers, resource) => {
  try {
    const userId = headers["x-user-id"];
    const tenantId = headers["x-tenant-id"];
    const userType = headers["x-user-type"];
    const userRolesStr = headers["x-user-roles"] || "[]";
    const userPermissionsStr = headers["x-user-permissions"] || "[]";

    if (!userId || !tenantId) {
      return {
        success: false,
        error: "Missing required headers",
      };
    }

    let roles = [];
    let permissions = [];

    try {
      const rolesArray = JSON.parse(userRolesStr);
      roles = Array.isArray(rolesArray)
        ? rolesArray
            .map((role) => (typeof role === "string" ? role : role?.code))
            .filter(Boolean)
        : [];
    } catch (e) {
      console.warn("Failed to parse x-user-roles:", e.message);
    }

    try {
      permissions = JSON.parse(userPermissionsStr);
      if (!Array.isArray(permissions)) permissions = [];
    } catch (e) {
      console.warn("Failed to parse x-user-permissions:", e.message);
    }

    if (carriesRetiredRole(roles)) {
      return { success: false, permissions: [], error: "Sign in again", reason: "RETIRED_ROLE_REAUTH_REQUIRED" };
    }
    // Phase B / Z9: ASU is the full administrator of its OWN tenant. Shown as the tenant wildcard "*"
    // (scope "tenant": never platform authority - a platform-namespace resource is not summarised this
    // way, and the PDP never lets "*" cover the platform namespace).
    if (roleHierarchyService.isTenantAdmin(roles) && !isPlatformNamespace(String(resource || ""))) {
      return {
        success: true,
        permissions: ["*"],
        scope: "tenant",
        roles: roles,
        reason: "ASU_OWN_TENANT_ADMIN",
      };
    }

    // Get resource-specific permissions
    const resourcePermissions = await getResourcePermissions(
      resource,
      roles,
      permissions
    );

    return {
      success: true,
      permissions: resourcePermissions,
      roles: roles,
      userType: userType,
      tenantId: tenantId,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
};

module.exports = {
  evaluatePolicy,
  evaluatePolicyWithHeaders,
  evaluateBatchPolicy,
  getEffectivePermissions,
  getEffectivePermissionsWithHeaders,
  validateToken,
  applyPolicyRules,
  tenantInvariantMode,
  tenantInvariantViolation,
  audienceMode,
  audienceDecision,
  catalogueAudienceDecision,
  compareAudienceDecision,
  decisionEpoch,
  resetAudienceEnforceDataLog,
  AUDIENCE_DATA_REASONS,
  getAudienceShadowStats,
  resetAudienceShadowStats,
  PDP_DECISION_EPOCH,
  getPolicyVersion,
  invalidateCache,
  cache, // Export cache for management
};
