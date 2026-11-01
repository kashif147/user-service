/**
 * Route guard for service-to-service reads that must NOT trust forwarded identity headers.
 *
 * The gateway headers (x-jwt-verified, x-user-id, x-tenant-id, x-user-permissions, ...) are
 * trusted by presence everywhere else (policy-middleware validateGatewayRequest is header-
 * presence-only); a container on the internal network can forge them. This guard instead
 * requires the caller's ORIGINAL user JWT (the gateway passes Authorization through; issue-
 * service forwards it) and has the PDP verify it cryptographically (HS256, JWT_SECRET) and
 * evaluate the permission from the verified claims (policyEvaluationService.evaluatePolicy,
 * token path). Identity and tenant come only from that verified result:
 *   - no Bearer token                          -> 401 VERIFIED_TOKEN_REQUIRED
 *   - forged / expired / wrong-alg token       -> 401 (PDP: invalid token)
 *   - verified, permission denied              -> 403
 *   - a forwarded x-tenant-id that differs from the verified tenant -> 403 TENANT_CONTEXT_MISMATCH
 * On success req.verifiedCaller = { userId, tenantId, userType } (internal 24-hex tenant only).
 * No platform authority: the PDP evaluates a tenant resource for the caller's own tenant.
 */
const INTERNAL_TENANT_ID = /^[0-9a-f]{24}$/;
const INVALID_TOKEN_REASONS = new Set(["INVALID_TOKEN", "TOKEN_EXPIRED", "MISSING_TOKEN", "MALFORMED_TOKEN", "JWT_SECRET_MISSING"]);

function fail(res, status, code, message) {
  return res.status(status).json({ error: { message, code, status } });
}

function requireVerifiedUserToken(resource, action, { evaluate } = {}) {
  const evaluatePolicy = evaluate || ((request) => require("../services/policyEvaluationService").evaluatePolicy(request));
  return async function verifiedUserToken(req, res, next) {
    try {
      const header = req.headers.authorization || req.headers.Authorization;
      if (typeof header !== "string" || !/^Bearer\s+\S+$/.test(header.trim())) {
        return fail(res, 401, "VERIFIED_TOKEN_REQUIRED", "A verified user token is required");
      }
      const token = header.trim().replace(/^Bearer\s+/, "");
      // No caller-supplied context: the PDP evaluates against the verified user's own tenant.
      const result = await evaluatePolicy({ token, resource, action, context: {} });
      if (!result || result.decision !== "PERMIT") {
        const reason = result?.reason || "PERMISSION_DENIED";
        return INVALID_TOKEN_REASONS.has(reason) || /TOKEN/.test(reason)
          ? fail(res, 401, "INVALID_TOKEN", "Invalid or expired token")
          : fail(res, 403, reason, "Permission denied");
      }
      const tenantId = String(result.user?.tenantId || "");
      const userId = String(result.user?.id || "");
      if (!INTERNAL_TENANT_ID.test(tenantId) || !userId) {
        return fail(res, 403, "TENANT_CONTEXT_REQUIRED", "Verified tenant context required");
      }
      const forwardedTenant = req.headers["x-tenant-id"];
      if (forwardedTenant != null && String(forwardedTenant).trim() !== "" && String(forwardedTenant).trim() !== tenantId) {
        return fail(res, 403, "TENANT_CONTEXT_MISMATCH", "Tenant context mismatch");
      }
      req.verifiedCaller = { userId, tenantId, userType: result.user?.userType || null };
      return next();
    } catch (error) {
      console.error("[verifiedUserToken] evaluation failed", { name: error?.name });
      return fail(res, 503, "AUTHORIZATION_UNAVAILABLE", "Authorization unavailable");
    }
  };
}

module.exports = { requireVerifiedUserToken };
