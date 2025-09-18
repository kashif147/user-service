const jwt = require("jsonwebtoken");
const { AppError } = require("../errors/AppError");
const {
  ROLE_HIERARCHY,
  getHighestRoleLevel,
  hasMinimumRole,
  isSuperUser,
  getRolesAtOrAbove,
} = require("../config/roleHierarchy");
const axios = require("axios");

// Default permissions data (fallback if API not available)
const DEFAULT_PERMISSIONS = {
  // General read permissions
  READ_ONLY: "read:all",

  // User Service permissions
  USER: {
    READ: "user:read",
    WRITE: "user:write",
    DELETE: "user:delete",
    MANAGE_ROLES: "user:manage_roles",
    CREATE: "user:create",
    UPDATE: "user:update",
    LIST: "user:list",
  },

  // Role Service permissions
  ROLE: {
    READ: "role:read",
    WRITE: "role:write",
    DELETE: "role:delete",
    CREATE: "role:create",
    UPDATE: "role:update",
    LIST: "role:list",
    ASSIGN: "role:assign",
    REMOVE: "role:remove",
  },

  // Account Service permissions
  ACCOUNT: {
    READ: "account:read",
    WRITE: "account:write",
    DELETE: "account:delete",
    PAYMENT: "account:payment",
    TRANSACTION_READ: "account:transaction:read",
    TRANSACTION_WRITE: "account:transaction:write",
    TRANSACTION_DELETE: "account:transaction:delete",
  },

  // Portal Service permissions
  PORTAL: {
    ACCESS: "portal:access",
    PROFILE_READ: "portal:profile:read",
    PROFILE_WRITE: "portal:profile:write",
    PROFILE_DELETE: "portal:profile:delete",
    DASHBOARD_READ: "portal:dashboard:read",
    SETTINGS_READ: "portal:settings:read",
    SETTINGS_WRITE: "portal:settings:write",
  },

  // CRM Service permissions
  CRM: {
    ACCESS: "crm:access",
    MEMBER_READ: "crm:member:read",
    MEMBER_WRITE: "crm:member:write",
    MEMBER_DELETE: "crm:member:delete",
    MEMBER_CREATE: "crm:member:create",
    MEMBER_UPDATE: "crm:member:update",
    MEMBER_LIST: "crm:member:list",
  },
};

// Cache for permissions to avoid repeated API calls
let permissionsCache = null;
let permissionsCacheExpiry = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Helper function to fetch permissions from API
async function fetchPermissionsFromAPI() {
  try {
    // Check cache first
    if (
      permissionsCache &&
      permissionsCacheExpiry &&
      Date.now() < permissionsCacheExpiry
    ) {
      return permissionsCache;
    }

    const baseUrl = process.env.API_BASE_URL || "http://localhost:3000";
    const response = await axios.get(`${baseUrl}/api/permissions/permissions`, {
      headers: {
        Authorization: `Bearer ${
          process.env.SUPER_USER_TOKEN || "fallback-token"
        }`,
        "Content-Type": "application/json",
      },
      timeout: 5000, // 5 second timeout
    });

    // Update cache
    permissionsCache = response.data.data || DEFAULT_PERMISSIONS;
    permissionsCacheExpiry = Date.now() + CACHE_TTL;

    return permissionsCache;
  } catch (error) {
    console.warn(
      "Failed to fetch permissions from API, using defaults:",
      error.message
    );
    return DEFAULT_PERMISSIONS;
  }
}
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
  if (isSuperUser(roles)) {
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
  const userMaxLevel = getHighestRoleLevel(roles.map((r) => r.code));
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
 * Evaluate permission-based policies
 * @param {Object} context - Authorization context
 * @returns {Object} Policy decision
 */
const evaluatePermissionPolicy = async (context) => {
  const { permissions, resource, action } = context;

  // Fetch permissions from API
  const PERMISSIONS = await fetchPermissionsFromAPI();

  // Permission mapping - using consistent database permission pattern
  const permissionMap = {
    portal: {
      read: "PORTAL_PROFILE_READ",
      write: "PORTAL_PROFILE_WRITE",
    },
    crm: {
      read: "CRM_MEMBER_READ",
      write: "CRM_MEMBER_WRITE",
      delete: "CRM_MEMBER_DELETE",
    },
    user: {
      read: "USER_READ",
      write: "USER_WRITE",
      delete: "USER_DELETE",
    },
    role: {
      read: "ROLE_READ",
      write: "ROLE_WRITE",
      delete: "ROLE_DELETE",
    },
    lookup: {
      read: "LOOKUP_READ",
      write: "LOOKUP_WRITE",
      delete: "LOOKUP_DELETE",
    },
    lookupType: {
      read: "LOOKUPTYPE_READ",
      write: "LOOKUPTYPE_WRITE",
      delete: "LOOKUPTYPE_DELETE",
    },
    admin: {
      read: "ADMIN_READ",
      write: "ADMIN_WRITE",
      delete: "ADMIN_DELETE",
    },
    api: {
      read: "API_READ",
      write: "API_WRITE",
      delete: "API_DELETE",
    },
    tenant: {
      read: "TENANT_READ",
      write: "TENANT_WRITE",
      delete: "TENANT_DELETE",
    },
  };

  const requiredPermission = permissionMap[resource]?.[action];
  if (!requiredPermission) {
    // If no specific permission required, allow
    return {
      decision: "PERMIT",
      reason: "NO_PERMISSION_REQUIRED",
    };
  }

  // Check if user has required permission
  const hasPermission =
    permissions.includes(requiredPermission) || permissions.includes("*");

  if (!hasPermission) {
    return {
      decision: "DENY",
      reason: "MISSING_PERMISSION",
    };
  }

  return {
    decision: "PERMIT",
    reason: "PERMISSION_GRANTED",
  };
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
    if (isSuperUser(roles)) {
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
 * Get permissions for a specific resource
 * @param {string} resource - Resource name
 * @param {Array} roles - User roles
 * @param {Array} permissions - User permissions
 * @returns {Array} Resource-specific permissions
 */
const getResourcePermissions = async (resource, roles, permissions) => {
  // Fetch permissions from API
  const PERMISSIONS = await fetchPermissionsFromAPI();

  const resourcePermissionMap = {
    portal: ["PORTAL_ACCESS", "PORTAL_PROFILE_READ", "PORTAL_PROFILE_WRITE"],
    crm: [
      "CRM_ACCESS",
      "CRM_MEMBER_READ",
      "CRM_MEMBER_WRITE",
      "CRM_MEMBER_DELETE",
    ],
    user: ["USER_READ", "USER_WRITE", "USER_DELETE", "USER_MANAGE_ROLES"],
    role: ["ROLE_READ", "ROLE_WRITE", "ROLE_DELETE", "ROLE_PERMISSION_ASSIGN"],
    lookup: ["LOOKUP_READ", "LOOKUP_WRITE", "LOOKUP_DELETE"],
    lookupType: ["LOOKUPTYPE_READ", "LOOKUPTYPE_WRITE", "LOOKUPTYPE_DELETE"],
    admin: ["ADMIN_ACCESS", "ADMIN_READ", "ADMIN_WRITE", "ADMIN_DELETE"],
    api: ["API_READ", "API_WRITE", "API_DELETE"],
    tenant: ["TENANT_READ", "TENANT_WRITE", "TENANT_DELETE"],
  };

  const resourcePermissions = resourcePermissionMap[resource] || [];

  // Filter permissions user actually has
  return resourcePermissions.filter(
    (permission) =>
      permissions.includes(permission) || permissions.includes("*")
  );
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
