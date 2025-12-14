const jwt = require("jsonwebtoken");
const { AppError } = require("../errors/AppError");
// Remove old hardcoded imports - now using database-driven services
const axios = require("axios");
const roleHierarchyService = require("./roleHierarchyService");
const permissionsService = require("./permissionsService");

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

    // Step 1: Check cache first (with tenant isolation)
    const tokenHash = token.substring(0, 8);
    const cacheKey = cache.generateKey(tokenHash, resource, action, context);
    const cachedResult = await cache.get(cacheKey);

    if (cachedResult) {
      return {
        ...cachedResult,
        policyVersion: POLICY_VERSION,
        cached: true,
      };
    }

    // Step 2: Validate and decode JWT token
    const tokenValidation = await validateToken(token);
    if (!tokenValidation.valid) {
      const result = {
        decision: "DENY",
        reason: "INVALID_TOKEN",
        error: tokenValidation.error,
        timestamp: new Date().toISOString(),
      };

      // Cache negative results for shorter time (fire and forget)
      cache
        .set(cacheKey, result, 60)
        .catch((err) =>
          console.warn("Failed to cache negative result:", err.message)
        );
      return result;
    }

    const user = tokenValidation.user;
    console.log(
      "Token validation result:",
      JSON.stringify(tokenValidation, null, 2)
    );
    console.log("User object:", JSON.stringify(user, null, 2));

    // Validate user object exists and has required properties
    if (!user || !user.id) {
      const result = {
        decision: "DENY",
        reason: "INVALID_USER_DATA",
        error: "User data is missing or invalid",
        timestamp: new Date().toISOString(),
        policyVersion: POLICY_VERSION,
        correlationId: context.correlationId,
      };
      cache
        .set(cacheKey, result, 60)
        .catch((err) => console.warn("Failed to cache result:", err.message));
      return result;
    }

    // Step 3: Extract authorization context with tenant isolation
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

    // Step 4: Check if tenantId is available
    if (!user.tenantId) {
      const result = {
        decision: "DENY",
        reason: "MISSING_TENANT_ID",
        error: "User tenantId is missing from token",
        timestamp: new Date().toISOString(),
        policyVersion: POLICY_VERSION,
        correlationId: context.correlationId,
      };
      cache
        .set(cacheKey, result, 60)
        .catch((err) => console.warn("Failed to cache result:", err.message));
      return result;
    }

    // Step 5: Apply tenant isolation check (skip for tenant resource as it's handled in resource policy)
    if (
      resource !== "tenant" &&
      context.tenantId &&
      context.tenantId !== user.tenantId
    ) {
      const result = {
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

      // Cache negative results for shorter time (fire and forget)
      cache
        .set(cacheKey, result, 60)
        .catch((err) =>
          console.warn("Failed to cache negative result:", err.message)
        );
      return result;
    }

    // Step 6: Apply policy rules
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

    // Step 7: Cache the result (fire and forget - don't wait)
    cache
      .set(cacheKey, result)
      .catch((err) =>
        console.warn("Failed to cache policy result:", err.message)
      );

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
    const decoded = jwt.decode(token);
    if (!decoded) {
      return { valid: false, error: "Invalid token format" };
    }

    // NOTE: Token expiry is checked ONLY at the gateway.
    // Do NOT re-check JWT exp here - trust gateway verification.

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
      expiresAt: new Date(decoded.exp * 1000).toISOString(),
    };
  } catch (error) {
    return { valid: false, error: error.message };
  }
};

/**
 * Apply policy rules to determine authorization decision
 * @param {Object} context - Authorization context
 * @returns {Object} Policy decision
 */
const applyPolicyRules = async (context) => {
  const { roles, permissions, resource, action, tenantId } = context;

  // Rule 1: Super User bypasses all authorization
  if (roleHierarchyService.isSuperUser(roles)) {
    return {
      decision: "PERMIT",
      reason: "SUPER_USER_BYPASS",
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
  const resourcePolicy = await evaluateResourcePolicy(context);
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
  return {
    decision: "PERMIT",
    reason: "POLICY_SATISFIED",
  };
};

/**
 * Evaluate resource-specific policies using database-driven permissions
 * @param {Object} context - Authorization context
 * @returns {Object} Policy decision
 */
const evaluateResourcePolicy = async (context) => {
  const { resource, userType, roles, tenantId, userTenantId } = context;

  try {
    // Get all permissions for this resource from database
    const resourcePermissions =
      await permissionsService.getPermissionsByResource(resource);

    if (!resourcePermissions || resourcePermissions.length === 0) {
      return {
        decision: "DENY",
        reason: "UNKNOWN_RESOURCE",
        error: `No permissions defined for resource '${resource}'`,
      };
    }

    // Check if user has any permission for this resource
    const userHasResourcePermission = await permissionsService.hasAnyPermission(
      roles,
      resourcePermissions.map((p) => p.code)
    );

    if (!userHasResourcePermission) {
      return {
        decision: "DENY",
        reason: "INSUFFICIENT_RESOURCE_PERMISSION",
        error: `User lacks any permission for resource '${resource}'`,
        availablePermissions: resourcePermissions.map((p) => p.code),
      };
    }

    // Special handling for tenant resource - ASU can only manage their own tenant
    if (resource === "tenant") {
      const hasASURole = roles.includes("ASU");
      const hasSURole = roles.includes("SU");

      // SU can manage any tenant globally
      if (hasSURole) {
        return {
          decision: "PERMIT",
          reason: "SUPER_USER_GLOBAL_ACCESS",
        };
      }

      // ASU can only manage their own tenant
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

    // Check user type based on permission categories
    const allowedCategories = resourcePermissions.map((p) => p.category);
    const userTypeCategory = getUserTypeCategory(userType);

    if (!allowedCategories.includes(userTypeCategory)) {
      return {
        decision: "DENY",
        reason: "INVALID_USER_TYPE",
        error: `User type '${userType}' not allowed for resource '${resource}'`,
        allowedCategories: allowedCategories,
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
  const { action, roles, resource } = context;

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
      minRoleLevel: 100, // SU only
    },
  };

  const requirement = actionRequirements[action];
  if (!requirement) {
    return {
      decision: "DENY",
      reason: "UNKNOWN_ACTION",
    };
  }

  // Check minimum role level
  // Roles are already normalized to strings in validateToken
  const userMaxLevel = await roleHierarchyService.getHighestRoleLevel(roles);
  if (userMaxLevel < requirement.minRoleLevel) {
    return {
      decision: "DENY",
      reason: "INSUFFICIENT_ROLE_LEVEL",
    };
  }

  return {
    decision: "PERMIT",
    reason: "ACTION_AUTHORIZED",
  };
};

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
      const hasWildcardPermission = permissions.includes("*");
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

    // Check if user has the required permission
    const hasPermission =
      permissions.includes(requiredPermission.code) ||
      permissions.includes("*");

    if (!hasPermission) {
      return {
        decision: "DENY",
        reason: "MISSING_PERMISSION",
        error: `User lacks required permission: ${requiredPermission.code}`,
        requiredPermission: requiredPermission.code,
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

    // Super User has all permissions
    if (roleHierarchyService.isSuperUser(roles)) {
      return {
        success: true,
        permissions: ["*"],
        roles: roles,
        reason: "SUPER_USER",
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
      (permission) =>
        permissions.includes(permission) || permissions.includes("*")
    );
  } catch (error) {
    console.error("Error getting resource permissions:", error);
    return [];
  }
};

/**
 * Evaluate policy using gateway headers instead of token
 * @param {Object} request - Authorization request with headers
 * @param {Object} request.headers - Request headers (including gateway headers)
 * @param {string} request.resource - Resource being accessed
 * @param {string} request.action - Action being performed
 * @param {Object} request.context - Additional context
 * @returns {Object} Policy decision
 */
const evaluatePolicyWithHeaders = async (request) => {
  const { headers, resource, action, context = {} } = request;

  // Extract user context from gateway headers
  const userId = headers["x-user-id"];
  const tenantId = headers["x-tenant-id"];
  const userEmail = headers["x-user-email"];
  const userType = headers["x-user-type"];
  const userRolesStr = headers["x-user-roles"] || "[]";
  const userPermissionsStr = headers["x-user-permissions"] || "[]";

  if (!userId || !tenantId) {
    return {
      decision: "DENY",
      reason: "INVALID_HEADERS",
      error: "Missing required headers",
      timestamp: new Date().toISOString(),
      policyVersion: POLICY_VERSION,
      correlationId: context.correlationId,
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

  const user = {
    id: userId,
    tenantId,
    email: userEmail,
    userType,
    roles,
    permissions,
  };

  // Build authorization context
  const authContext = {
    ...context,
    userId: user.id,
    tenantId: context.tenantId || user.tenantId,
    userTenantId: user.tenantId,
    userType: user.userType,
    roles: user.roles,
    permissions: user.permissions,
    resource,
    action,
    correlationId: context.correlationId,
  };

  // Apply policy rules (reuse existing logic)
  const policyDecision = await applyPolicyRules(authContext);

  return {
    ...policyDecision,
    user,
    timestamp: new Date().toISOString(),
    policyVersion: POLICY_VERSION,
    correlationId: context.correlationId,
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

    // Super User has all permissions
    if (roleHierarchyService.isSuperUser(roles)) {
      return {
        success: true,
        permissions: ["*"],
        roles: roles,
        reason: "SUPER_USER",
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
  getPolicyVersion,
  invalidateCache,
  cache, // Export cache for management
};
