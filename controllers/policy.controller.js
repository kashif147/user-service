const policyService = require("../services/policyEvaluationService");

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
module.exports.evaluatePolicy = async (req, res) => {
  try {
    const { token, resource, action, context } = req.body;

    if (!token || !resource || !action) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: token, resource, action",
        code: "MISSING_FIELDS",
      });
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
    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "EVALUATION_ERROR",
    });
  }
};

/**
 * Batch Policy Evaluation
 * POST /policy/evaluate-batch
 */
module.exports.evaluateBatchPolicy = async (req, res) => {
  try {
    const { requests } = req.body;

    if (!requests || !Array.isArray(requests)) {
      return res.status(400).json({
        success: false,
        error: "Missing or invalid requests array",
        code: "INVALID_REQUESTS",
      });
    }

    if (requests.length > 50) {
      return res.status(400).json({
        success: false,
        error: "Too many requests (max 50)",
        code: "TOO_MANY_REQUESTS",
      });
    }

    const results = await policyService.evaluateBatchPolicy(requests);

    res.json({
      success: true,
      results,
      count: results.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Batch policy evaluation error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "BATCH_EVALUATION_ERROR",
    });
  }
};

/**
 * Get Effective Permissions
 * GET /policy/permissions/:resource
 */
module.exports.getEffectivePermissions = async (req, res) => {
  try {
    const { resource } = req.params;
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authorization header required",
        code: "MISSING_TOKEN",
      });
    }

    const token = authHeader.substring(7);
    const result = await policyService.getEffectivePermissions(token, resource);

    if (!result.success) {
      return res.status(401).json({
        success: false,
        error: result.error,
        code: "INVALID_TOKEN",
      });
    }

    res.json({
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
    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "PERMISSIONS_ERROR",
    });
  }
};

/**
 * Quick Authorization Check
 * GET /policy/check/:resource/:action
 */
module.exports.quickCheck = async (req, res) => {
  try {
    const { resource, action } = req.params;
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authorization header required",
        code: "MISSING_TOKEN",
      });
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
    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "CHECK_ERROR",
    });
  }
};

/**
 * Health Check
 * GET /policy/health
 */
module.exports.healthCheck = (req, res) => {
  res.json({
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
  res.json({
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
module.exports.initializeUI = async (req, res) => {
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
      return res.status(401).json({
        success: false,
        error: "Authorization token required",
        code: "MISSING_TOKEN",
      });
    }

    // Validate token first
    const tokenValidation = await policyService.validateToken(authToken);
    if (!tokenValidation.valid) {
      return res.status(401).json({
        success: false,
        error: tokenValidation.error,
        code: "INVALID_TOKEN",
      });
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

    res.json({
      success: true,
      ...uiData,
    });
  } catch (error) {
    console.error("UI initialization error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "UI_INIT_ERROR",
    });
  }
};

/**
 * Cache Management
 */
module.exports.getCacheStats = async (req, res) => {
  try {
    const stats = await policyService.cache.getStats();
    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

module.exports.clearCache = async (req, res) => {
  try {
    await policyService.cache.clear();
    res.json({
      success: true,
      message: "Policy cache cleared",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

module.exports.deleteCacheEntry = async (req, res) => {
  try {
    const { key } = req.params;
    await policyService.cache.delete(key);
    res.json({
      success: true,
      message: `Cache entry ${key} cleared`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};
