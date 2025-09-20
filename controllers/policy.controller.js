const policyService = require("../services/policyEvaluationService");
const { AppError } = require("../errors/AppError");

/**
 * Policy Controller
 *
 * Handles policy evaluation requests from various clients
 * (mobile apps, web apps, microservices)
 */

/**
 * Single Policy Evaluation
 * POST /policy/evaluate
 */
module.exports.evaluatePolicy = async (req, res, next) => {
  try {
    const { token, resource, action, context } = req.body;

    if (!token || !resource || !action) {
      return next(
        AppError.badRequest("Missing required fields: token, resource, action")
      );
    }

    const result = await policyService.evaluatePolicy({
      token,
      resource,
      action,
      context,
    });

    const statusCode = result.decision === "PERMIT" ? 200 : 403;

    res.status(statusCode).json({
      success: result.decision === "PERMIT",
      decision: result.decision,
      reason: result.reason,
      user: result.user,
      resource,
      action,
      timestamp: result.timestamp,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    console.error("Policy evaluation error:", error);
    return next(AppError.internalServerError("Policy evaluation failed"));
  }
};

/**
 * Batch Policy Evaluation
 * POST /policy/evaluate-batch
 */
module.exports.evaluateBatchPolicy = async (req, res, next) => {
  try {
    const { requests } = req.body;

    if (!requests || !Array.isArray(requests)) {
      return next(AppError.badRequest("Missing or invalid requests array"));
    }

    if (requests.length > 50) {
      return next(AppError.badRequest("Too many requests (max 50)"));
    }

    const results = await policyService.evaluateBatchPolicy(requests);

    res.status(200).json({
      success: true,
      results,
      count: results.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Batch policy evaluation error:", error);
    return next(AppError.internalServerError("Batch policy evaluation failed"));
  }
};

/**
 * Get Effective Permissions
 * GET /policy/permissions/:resource
 */
module.exports.getEffectivePermissions = async (req, res, next) => {
  try {
    const { resource } = req.params;
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next(AppError.unauthorized("Authorization header required"));
    }

    const token = authHeader.substring(7);
    const result = await policyService.getEffectivePermissions(token, resource);

    if (!result.success) {
      return next(AppError.unauthorized(result.error));
    }

    res.status(200).json({
      success: true,
      resource,
      permissions: result.permissions,
      roles: result.roles,
      userType: result.userType,
      tenantId: result.tenantId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Get permissions error:", error);
    return next(AppError.internalServerError("Failed to retrieve permissions"));
  }
};

/**
 * Quick Authorization Check
 * GET /policy/check/:resource/:action
 */
module.exports.quickCheck = async (req, res, next) => {
  try {
    const { resource, action } = req.params;
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next(AppError.unauthorized("Authorization header required"));
    }

    const token = authHeader.substring(7);
    const result = await policyService.evaluatePolicy({
      token,
      resource,
      action,
      context: req.query, // Pass query params as context
    });

    const statusCode = result.decision === "PERMIT" ? 200 : 403;

    res.status(statusCode).json({
      success: result.decision === "PERMIT",
      decision: result.decision,
      reason: result.reason,
      user: result.user,
      resource,
      action,
      timestamp: result.timestamp,
    });
  } catch (error) {
    console.error("Quick check error:", error);
    return next(AppError.internalServerError("Authorization check failed"));
  }
};

/**
 * Health Check
 * GET /policy/health
 */
module.exports.healthCheck = (req, res) => {
  res.status(200).json({
    success: true,
    service: "RBAC Policy Evaluation Service",
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
};

/**
 * Policy Information
 * GET /policy/info
 */
module.exports.getPolicyInfo = (req, res) => {
  res.status(200).json({
    success: true,
    resources: {
      portal: {
        description: "Portal application access",
        actions: ["read", "write"],
        userTypes: ["CRM", "MEMBER"],
      },
      crm: {
        description: "CRM application access",
        actions: ["read", "write", "delete"],
        userTypes: ["CRM"],
        minRoleLevel: 30,
      },
      admin: {
        description: "Admin panel access",
        actions: ["read", "write", "delete", "admin"],
        userTypes: ["CRM"],
        minRoleLevel: 80,
      },
      api: {
        description: "API endpoints access",
        actions: ["read", "write", "delete"],
        userTypes: ["CRM", "MEMBER"],
      },
      role: {
        description: "Role management access",
        actions: ["read", "write", "delete", "admin"],
        userTypes: ["CRM"],
        minRoleLevel: 30,
      },
      user: {
        description: "User management access",
        actions: ["read", "write", "delete"],
        userTypes: ["CRM"],
        minRoleLevel: 30,
      },
      lookup: {
        description: "Lookup data access",
        actions: ["read", "write", "delete"],
        userTypes: ["CRM", "PORTAL"],
        minRoleLevel: 1,
      },
      lookupType: {
        description: "Lookup type management access",
        actions: ["read", "write", "delete"],
        userTypes: ["CRM", "PORTAL"],
        minRoleLevel: 1,
      },
    },
    actions: {
      read: { minRoleLevel: 1, description: "View data" },
      write: { minRoleLevel: 30, description: "Create/update data" },
      delete: { minRoleLevel: 60, description: "Delete data" },
      admin: { minRoleLevel: 80, description: "Administrative actions" },
      super_admin: { minRoleLevel: 100, description: "Super user actions" },
    },
    timestamp: new Date().toISOString(),
  });
};

/**
 * UI Initialization
 * POST /policy/ui/initialize
 */
module.exports.initializeUI = async (req, res, next) => {
  try {
    const { token, uiConfig } = req.body;
    const authHeader = req.headers.authorization;

    // Get token from body or header
    const authToken =
      token ||
      (authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.substring(7)
        : null);

    if (!authToken) {
      return next(AppError.unauthorized("Authorization token required"));
    }

    // Validate token first
    const tokenValidation = await policyService.validateToken(authToken);
    if (!tokenValidation.valid) {
      return next(AppError.unauthorized(tokenValidation.error));
    }

    // Default UI configuration if not provided
    const defaultUIConfig = {
      navigation: [
        { resource: "portal", action: "read" },
        { resource: "crm", action: "read" },
        { resource: "user", action: "read" },
        { resource: "role", action: "read" },
        { resource: "admin", action: "read" },
      ],
      actions: [
        { resource: "user", action: "read" },
        { resource: "user", action: "write" },
        { resource: "user", action: "delete" },
        { resource: "role", action: "read" },
        { resource: "role", action: "write" },
        { resource: "role", action: "delete" },
        { resource: "crm", action: "write" },
        { resource: "crm", action: "delete" },
        { resource: "admin", action: "write" },
        { resource: "admin", action: "delete" },
      ],
    };

    const config = uiConfig || defaultUIConfig;

    // Collect all unique permission checks
    const allChecks = new Set();

    // Add navigation checks
    if (config.navigation) {
      config.navigation.forEach((nav) => {
        allChecks.add(
          JSON.stringify({ resource: nav.resource, action: nav.action })
        );
      });
    }

    // Add action checks
    if (config.actions) {
      config.actions.forEach((action) => {
        allChecks.add(
          JSON.stringify({ resource: action.resource, action: action.action })
        );
      });
    }

    // Convert to requests array
    const requests = Array.from(allChecks).map((check) => {
      const { resource, action } = JSON.parse(check);
      return { token: authToken, resource, action };
    });

    // Batch evaluate all permissions
    const results = await policyService.evaluateBatchPolicy(requests);

    // Build permission map
    const permissions = {};
    results.forEach((result, index) => {
      const request = requests[index];
      const key = `${request.resource}_${request.action}`;
      permissions[key] = result.success;
    });

    // Build navigation capabilities
    const navigation = [];
    if (config.navigation) {
      config.navigation.forEach((nav) => {
        if (permissions[`${nav.resource}_${nav.action}`]) {
          navigation.push({
            resource: nav.resource,
            action: nav.action,
            permitted: true,
          });
        }
      });
    }

    // Build action capabilities
    const actions = [];
    if (config.actions) {
      config.actions.forEach((action) => {
        if (permissions[`${action.resource}_${action.action}`]) {
          actions.push({
            resource: action.resource,
            action: action.action,
            permitted: true,
          });
        }
      });
    }

    // Get resource-specific permissions
    const resources = ["portal", "crm", "admin", "user", "role"];
    const resourcePermissions = {};

    for (const resource of resources) {
      try {
        const resourceResult = await policyService.getEffectivePermissions(
          authToken,
          resource
        );
        if (resourceResult.success) {
          resourcePermissions[resource] = resourceResult.permissions;
        }
      } catch (error) {
        console.warn(`Failed to get permissions for ${resource}:`, error);
        resourcePermissions[resource] = [];
      }
    }

    // Build response
    const uiData = {
      user: tokenValidation.user,
      permissions,
      capabilities: {
        navigation,
        actions,
        stats: {
          totalChecks: requests.length,
          grantedPermissions: Object.values(permissions).filter((p) => p)
            .length,
        },
      },
      resourcePermissions,
      timestamp: new Date().toISOString(),
    };

    res.status(200).json({
      success: true,
      ...uiData,
    });
  } catch (error) {
    console.error("UI initialization error:", error);
    return next(AppError.internalServerError("UI initialization failed"));
  }
};

/**
 * Cache Management
 */
module.exports.getCacheStats = async (req, res, next) => {
  try {
    const stats = await policyService.cache.getStats();
    res.status(200).json({
      success: true,
      stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return next(
      AppError.internalServerError("Failed to retrieve cache statistics")
    );
  }
};

module.exports.clearCache = async (req, res, next) => {
  try {
    await policyService.cache.clear();
    res.status(200).json({
      success: true,
      message: "Policy cache cleared",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return next(AppError.internalServerError("Failed to clear cache"));
  }
};

module.exports.deleteCacheEntry = async (req, res, next) => {
  try {
    const { key } = req.params;
    await policyService.cache.delete(key);
    res.status(200).json({
      success: true,
      message: `Cache entry ${key} cleared`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return next(AppError.internalServerError("Failed to delete cache entry"));
  }
};
