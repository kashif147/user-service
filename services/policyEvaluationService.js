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
  try {
    const { token, resource, action, context = {} } = request;

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

      // Cache negative results for shorter time
      await cache.set(cacheKey, result, 60); // 1 minute
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
      await cache.set(cacheKey, result, 60);
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
      await cache.set(cacheKey, result, 60);
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

      // Cache negative results for shorter time
      await cache.set(cacheKey, result, 60); // 1 minute
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

    // Step 7: Cache the result
    await cache.set(cacheKey, result);

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
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) {
      return { valid: false, error: "Token expired" };
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

    return {
      valid: true,
      user: {
        id: decoded.sub || decoded.id,
        tenantId: tenantId,
        email: decoded.email,
        userType: decoded.userType,
        roles: decoded.roles || [],
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
 * Evaluate resource-specific policies
 * @param {Object} context - Authorization context
 * @returns {Object} Policy decision
 */
const evaluateResourcePolicy = async (context) => {
  const { resource, userType, roles, tenantId, userTenantId } = context;

  // Resource access matrix
  const resourceAccessMatrix = {
    // Portal access
    portal: {
      allowedUserTypes: ["CRM", "MEMBER"],
      allowedRoles: ["*"], // All roles can access portal
    },
    // CRM access
    crm: {
      allowedUserTypes: ["CRM"],
      allowedRoles: [
        "SU",
        "GS",
        "DGS",
        "DIR",
        "DPRS",
        "ADIR",
        "AM",
        "DAM",
        "MO",
        "AMO",
      ],
    },
    // Admin panel
    admin: {
      allowedUserTypes: ["CRM"],
      allowedRoles: ["SU", "GS", "DGS"],
    },
    // API endpoints
    api: {
      allowedUserTypes: ["CRM", "MEMBER"],
      allowedRoles: ["*"],
    },
    // Role management
    role: {
      allowedUserTypes: ["CRM", "PORTAL"],
      allowedRoles: [
        "SU",
        "GS",
        "DGS",
        "DIR",
        "DPRS",
        "ADIR",
        "AM",
        "DAM",
        "MO",
        "AMO",
      ],
    },
    // User management
    user: {
      allowedUserTypes: ["CRM"],
      allowedRoles: [
        "SU",
        "GS",
        "DGS",
        "DIR",
        "DPRS",
        "ADIR",
        "AM",
        "DAM",
        "MO",
        "AMO",
      ],
    },
    // Lookup management
    lookup: {
      allowedUserTypes: ["CRM", "PORTAL"],
      allowedRoles: ["*"], // All roles can access lookup
    },
    // LookupType management
    lookupType: {
      allowedUserTypes: ["CRM", "PORTAL"],
      allowedRoles: ["*"], // All roles can access lookupType
    },
    // Permission management
    permission: {
      allowedUserTypes: ["CRM"],
      allowedRoles: ["SU"],
    },
    // Tenant management
    tenant: {
      allowedUserTypes: ["CRM"],
      allowedRoles: ["SU", "ASU"],
    },
  };

  const resourceConfig = resourceAccessMatrix[resource];
  if (!resourceConfig) {
    return {
      decision: "DENY",
      reason: "UNKNOWN_RESOURCE",
    };
  }

  // Check user type
  if (!resourceConfig.allowedUserTypes.includes(userType)) {
    return {
      decision: "DENY",
      reason: "INVALID_USER_TYPE",
    };
  }

  // Special handling for tenant resource - ASU can only manage their own tenant
  if (resource === "tenant") {
    const hasASURole = roles.some((role) => role.code === "ASU");
    const hasSURole = roles.some((role) => role.code === "SU");

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

  // Check roles (if not wildcard)
  if (resourceConfig.allowedRoles[0] !== "*") {
    const hasRequiredRole = roles.some((role) =>
      resourceConfig.allowedRoles.includes(role.code)
    );

    if (!hasRequiredRole) {
      return {
        decision: "DENY",
        reason: "INSUFFICIENT_ROLE",
      };
    }
  }

  return {
    decision: "PERMIT",
    reason: "RESOURCE_ACCESS_GRANTED",
  };
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
  const userMaxLevel = await roleHierarchyService.getHighestRoleLevel(
    roles.map((r) => r.code)
  );
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

module.exports = {
  evaluatePolicy,
  evaluateBatchPolicy,
  getEffectivePermissions,
  validateToken,
  applyPolicyRules,
  getPolicyVersion,
  invalidateCache,
  cache, // Export cache for management
};
