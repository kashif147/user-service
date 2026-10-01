const jwt = require("jsonwebtoken");
const { AppError } = require("../errors/AppError");
const roleHierarchyService = require("../services/roleHierarchyService");
// Import from main package - gatewaySecurity is exported from index
const {
  gatewaySecurity,
  tenantContextMiddleware,
} = require("@membership/policy-middleware");
const { validateGatewayRequest } = gatewaySecurity;

/**
 * Phase 1A canonical tenant-context guard — WARN MODE ONLY (first-consumer adoption).
 *
 * Mounted immediately AFTER `authenticate` on every authenticated route group, so the
 * gateway-verified tenant is already on req.ctx/req.user/req.tenantId when it runs. In
 * "warn" mode it re-pins req.tenantId to the trusted tenant and LOGS any caller-supplied
 * (body/query/params) tenantId that disagrees, as a non-blocking TenantContextMismatch
 * event — it never returns 403. Do NOT mount it on pre-auth routes (/pkce, /auth/azure-*,
 * refresh/revoke) or the internal service-to-service routers (verify-ms-token,
 * tenant-lifecycle, internal-role-access), which do not establish a trusted tenant.
 */
const tenantContextWarn = tenantContextMiddleware({ mode: "warn" });

/**
 * Phase 1B — local ProjectShell token verifier for the NON-gateway paths.
 *
 * Cryptographically verifies HS256 ProjectShell JWTs before any claim is
 * trusted, matching the PDP contract (services/policyEvaluationService.js):
 * HS256 only (the algorithm allowlist is fixed — the token's own `alg` header
 * is never trusted), expiry enforced, 30s clock tolerance, and FAIL CLOSED
 * when JWT_SECRET is absent/empty. Returns { valid:true, payload } or
 * { valid:false, reason } with a non-sensitive reason category only — never
 * the raw jwt error message, token, claims, secret, or signature. RS256/JWKS
 * is intentionally NOT handled here: Microsoft RS256 tokens are verified
 * upstream at the gateway and arrive via the gateway-header path, never as a
 * direct Bearer to these fallbacks.
 */
const verifyProjectShellToken = (token) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return { valid: false, reason: "JWT_SECRET_MISSING" };
  }
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      clockTolerance: 30,
    });
    if (!payload || typeof payload !== "object") {
      return { valid: false, reason: "MALFORMED_TOKEN" };
    }
    return { valid: true, payload };
  } catch (err) {
    let reason = "INVALID_SIGNATURE";
    if (err && err.name === "TokenExpiredError") reason = "TOKEN_EXPIRED";
    else if (err && err.name === "NotBeforeError") reason = "TOKEN_NOT_ACTIVE";
    else if (err && err.name === "JsonWebTokenError") {
      if (/invalid algorithm/i.test(err.message)) reason = "UNSUPPORTED_ALGORITHM";
      else if (/malformed|invalid token|jwt must be provided/i.test(err.message))
        reason = "MALFORMED_TOKEN";
      else reason = "INVALID_SIGNATURE";
    }
    return { valid: false, reason };
  }
};

/**
 * AUTHENTICATION MIDDLEWARE ONLY
 * 
 * This middleware handles authentication (verifying user identity).
 * It does NOT handle authorization (permission checks).
 * 
 * For authorization, use policy-middleware:
 * const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");
 * router.get("/resource", defaultPolicyMiddleware.requirePermission("resource", "action"), handler);
 */

/**
 * Unified JWT Authentication Middleware
 * Handles JWT token verification and sets request context
 */
const authenticate = async (req, res, next) => {
  try {
    // Gateway headers are the SINGLE SOURCE OF TRUTH
    // These values must never be overridden by JWT, DB, or cache
    // Policy evaluation service reads directly from headers
    
    // 1) Check for gateway-verified JWT (trust gateway headers with validation)
    const jwtVerified = req.headers["x-jwt-verified"];
    const authSource = req.headers["x-auth-source"];

    if (jwtVerified === "true" && authSource === "gateway") {
      // Validate gateway request (signature, IP, format)
      console.warn("[AUTH] Calling validateGatewayRequest...");
      const validation = validateGatewayRequest(req);
      console.warn(
        "[AUTH] Validation result:",
        JSON.stringify(validation, null, 2)
      );
      if (!validation.valid) {
        console.warn(
          "[AUTH] Gateway header validation failed:",
          validation.reason
        );
        if (validation.debug) {
          console.error(
            "[AUTH] Signature debug info:",
            JSON.stringify(validation.debug, null, 2)
          );
        }
        const authError = AppError.unauthorized("Invalid gateway request", {
          tokenError: true,
          validationError: validation.reason,
        });
        return res.status(authError.status).json({
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            validationError: authError.validationError,
          },
        });
      }

      // Gateway has verified JWT and forwarded claims as headers
      const userId = req.headers["x-user-id"];
      const tenantId = req.headers["x-tenant-id"];
      const userEmail = req.headers["x-user-email"];
      const userType = req.headers["x-user-type"];
      const userRolesStr = req.headers["x-user-roles"] || "[]";
      const userPermissionsStr = req.headers["x-user-permissions"] || "[]";

      if (!userId || !tenantId) {
        const authError = AppError.badRequest(
          "Missing required authentication headers",
          {
            tokenError: true,
            missingHeaders: true,
          }
        );
        return res.status(authError.status).json({
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            missingHeaders: authError.missingHeaders,
          },
        });
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
        console.warn("Failed to parse x-user-roles header:", e.message);
      }

      try {
        permissions = JSON.parse(userPermissionsStr);
        if (!Array.isArray(permissions)) permissions = [];
      } catch (e) {
        console.warn("Failed to parse x-user-permissions header:", e.message);
      }

      // Set request context with tenant isolation
      req.ctx = {
        tenantId,
        userId,
        roles,
        permissions,
      };

      // Attach user info to request for backward compatibility
      req.user = {
        sub: userId,
        id: userId,
        tenantId,
        email: userEmail,
        userType,
        roles,
        permissions,
      };

      req.userId = userId;
      req.tenantId = tenantId;
      req.roles = roles;
      req.permissions = permissions;

      return next();
    }

    // 2) Legacy Bearer JWT flow (fallback for direct service calls)
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      const authError = AppError.badRequest("Authorization header required", {
        tokenError: true,
        missingHeader: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          tokenError: authError.tokenError,
          missingHeader: authError.missingHeader,
        },
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer '

    // Check for authorization bypass (but still validate token)
    // SECURITY: Never allow bypass on authentication endpoints
    const authEndpoints = [
      "/login",
      "/signin",
      "/signup",
      "/register",
      "/auth",
    ];
    const isAuthEndpoint = authEndpoints.some((endpoint) =>
      req.path.toLowerCase().includes(endpoint.toLowerCase())
    );

    if (process.env.AUTH_BYPASS_ENABLED === "true") {
      if (isAuthEndpoint) {
        console.error(
          `🚨 SECURITY ERROR: Bypass attempted on authentication endpoint: ${req.path}`
        );
        const authError = AppError.badRequest(
          "Authentication bypass is not allowed for authentication endpoints",
          {
            tokenError: true,
            securityError: true,
          }
        );
        return res.status(authError.status).json({
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            securityError: authError.securityError,
          },
        });
      }

      console.warn(
        `🚨 AUTH BYPASS TRIGGERED - NODE_ENV: ${process.env.NODE_ENV}`
      );
      // AUTH-A (Phase 1B): bypass may skip AUTHORIZATION, but it must NEVER skip
      // AUTHENTICATION. Cryptographically verify the token before trusting any
      // claim — a forged/unsigned/expired token can no longer establish identity.
      const bypassVerification = verifyProjectShellToken(token);
      if (!bypassVerification.valid) {
        console.warn(
          `[AUTH] Bypass-path token verification failed: ${bypassVerification.reason}`
        );
        const authError = AppError.unauthorized("Invalid token", {
          tokenError: true,
          invalidToken: true,
        });
        return res.status(authError.status).json({
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            invalidToken: authError.invalidToken,
          },
        });
      }
      const decoded = bypassVerification.payload;

      const tenantId =
        decoded.tenantId || decoded.tid || decoded.extension_tenantId;

      if (!tenantId) {
        const authError = AppError.badRequest(
          "Invalid token: missing tenantId",
          {
            tokenError: true,
            missingTenantId: true,
          }
        );
        return res.status(authError.status).json({
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            missingTenantId: authError.missingTenantId,
          },
        });
      }

      req.ctx = {
        tenantId: tenantId,
        userId: decoded.sub || decoded.id,
        roles: decoded.roles || [],
        permissions: decoded.permissions || [],
      };

      req.user = decoded;
      req.userId = decoded.sub || decoded.id;
      req.tenantId = tenantId;
      req.roles = decoded.roles || [];
      req.permissions = decoded.permissions || [];

      return next();
    }

    // AUTH-B (Phase 1B): normal legacy-Bearer flow now cryptographically
    // verifies the token (was an unverified jwt.decode). Fail closed on any
    // verification failure; never establish trusted req.ctx from an unverified
    // token. This also closes the forged-Bearer exposure on authenticate-only
    // routes such as /api/me.
    const verification = verifyProjectShellToken(token);
    if (!verification.valid) {
      console.warn(
        `[AUTH] Bearer token verification failed: ${verification.reason}`
      );
      const authError = AppError.unauthorized("Invalid token", {
        tokenError: true,
        invalidToken: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          tokenError: authError.tokenError,
          invalidToken: authError.invalidToken,
        },
      });
    }
    const decoded = verification.payload;

    const tenantId =
      decoded.tenantId || decoded.tid || decoded.extension_tenantId;

    if (!tenantId) {
      const authError = AppError.badRequest("Invalid token: missing tenantId", {
        tokenError: true,
        missingTenantId: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          tokenError: authError.tokenError,
          missingTenantId: authError.missingTenantId,
        },
      });
    }

    req.ctx = {
      tenantId: tenantId,
      userId: decoded.sub || decoded.id,
      roles: decoded.roles || [],
      permissions: decoded.permissions || [],
    };

    req.user = decoded;
    req.userId = decoded.sub || decoded.id;
    req.tenantId = tenantId;
    req.roles = decoded.roles || [];
    req.permissions = decoded.permissions || [];

    next();
  } catch (error) {
    console.error("JWT Decode Error:", error.message);
    const authError = AppError.badRequest("Invalid token", {
      tokenError: true,
      jwtError: error.message,
    });
    return res.status(authError.status).json({
      error: {
        message: authError.message,
        code: authError.code,
        status: authError.status,
        tokenError: authError.tokenError,
        jwtError: authError.jwtError,
      },
    });
  }
};

// Helper function to check if user has any of the specified roles
function hasAnyRole(userRoles, requiredRoles) {
  if (!userRoles || !Array.isArray(userRoles)) return false;

  // Handle both role objects and role codes
  const userRoleCodes = userRoles.map((role) =>
    typeof role === "string" ? role : role.code
  );

  return requiredRoles.some((role) => userRoleCodes.includes(role));
}

// Helper function to check if user has specific role
function hasRole(userRoles, requiredRole) {
  if (!userRoles || !Array.isArray(userRoles)) return false;

  // Handle both role objects and role codes
  const userRoleCodes = userRoles.map((role) =>
    typeof role === "string" ? role : role.code
  );

  return userRoleCodes.includes(requiredRole);
}

/**
 * AUTHORIZATION FUNCTIONS REMOVED
 * 
 * requireRole, requirePermission, and requireMinRole have been removed.
 * All authorization must be done via policy-middleware to maintain single source of truth.
 * 
 * Use policy-middleware for authorization:
 * const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");
 * router.get("/resource", defaultPolicyMiddleware.requirePermission("resource", "action"), handler);
 */

/**
 * Tenant Enforcement Middleware
 * Ensures tenantId is present in req.ctx
 */
const requireTenant = (req, res, next) => {
  if (!req.ctx || !req.ctx.tenantId) {
    const authError = AppError.badRequest("Tenant context required", {
      authError: true,
      missingTenant: true,
    });
    return res.status(authError.status).json({
      error: {
        message: authError.message,
        code: authError.code,
        status: authError.status,
        authError: authError.authError,
        missingTenant: authError.missingTenant,
      },
    });
  }
  next();
};

/**
 * Helper function to add tenantId to MongoDB queries
 */
const withTenant = (tenantId) => {
  return { tenantId };
};

/**
 * Helper function to add tenantId to MongoDB aggregation pipelines
 */
const addTenantMatch = (tenantId) => {
  return { $match: { tenantId } };
};

// Export all middleware functions
module.exports = {
  // Core authentication ONLY - no authorization logic here
  authenticate,
  requireTenant,

  // Phase 1A canonical tenant-context guard (WARN MODE). Pair it with `authenticate`
  // on authenticated route groups: router.use(authenticate, tenantContextWarn).
  tenantContextWarn,

  // Utility functions (for backward compatibility, but prefer policy-middleware)
  hasRole,
  hasAnyRole,
  isSuperUser: roleHierarchyService.isSuperUser,
  isAssistantSuperUser: roleHierarchyService.isAssistantSuperUser,
  isSystemAdmin: roleHierarchyService.isSystemAdmin,
  getUserRoleLevel: roleHierarchyService.getHighestRoleLevel,
  hasMinRole: roleHierarchyService.hasMinimumRole,

  // Database helpers
  withTenant,
  addTenantMatch,
};
