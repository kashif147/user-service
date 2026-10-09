const express = require("express");
const router = express.Router();
const policyService = require("../services/policyEvaluationService");
const crypto = require("crypto");
const { AppError } = require("../errors/AppError");
const {
  authenticate,
  tenantContextWarn,
  requireTenant,
  requireSuperUser,
} = require("../middlewares/auth");

/**
 * Centralized RBAC Policy Evaluation Endpoints
 *
 * These endpoints provide policy decisions to various clients:
 * - Mobile apps (React Native)
 * - Web apps (Portal & CRM)
 * - Microservices
 */

/**
 * Single Policy Evaluation Endpoint
 * POST /policy/evaluate
 *
 * Evaluates a single authorization request
 */
router.post("/evaluate", async (req, res, next) => {
  try {
    const { resource, action, context } = req.body;

    if (!resource || !action) {
      return next(
        AppError.badRequest("Missing required fields: resource, action")
      );
    }

    // Check for gateway-verified headers first
    const jwtVerified = req.headers["x-jwt-verified"];
    const authSource = req.headers["x-auth-source"];
    const hasGatewayHeaders =
      jwtVerified === "true" &&
      (authSource === "gateway" || authSource === "azuread");

    let result;
    if (hasGatewayHeaders) {
      // Use headers from gateway
      // CRITICAL: Only pass correlationId in context - never pass userId/tenantId
      // Gateway headers are authoritative and must not be overridden
      result = await policyService.evaluatePolicyWithHeaders({
        headers: req.headers,
        resource,
        action,
        context: {
          // Only pass correlationId - gateway headers provide all identity info
          correlationId: req.headers["x-correlation-id"] || crypto.randomUUID(),
        },
      });
    } else {
      // Fallback to token-based evaluation (legacy support)
      const { token } = req.body;
      if (!token) {
        return next(
          AppError.badRequest("Missing required field: token (or gateway headers)")
        );
      }
      result = await policyService.evaluatePolicy({
        token,
        resource,
        action,
        context: {
          ...context,
          correlationId: req.headers["x-correlation-id"] || crypto.randomUUID(),
        },
      });
    }

    const statusCode = result.decision === "PERMIT" ? 200 : 403;

    // Set policy version header
    res.set("X-Policy-Version", result.policyVersion || "1.0.0");

    if (result.decision === "PERMIT") {
      res.status(statusCode).json({
        success: true,
        authorized: true,
        decision: result.decision,
        user: result.user,
        resource,
        action,
        timestamp: result.timestamp,
        expiresAt: result.expiresAt,
        policyVersion: result.policyVersion || "1.0.0",
        correlationId: result.context?.correlationId,
      });
    } else {
      res.status(statusCode).json({
        success: false,
        authorized: false,
        decision: result.decision,
        reason: result.reason,
        requiredRoles: result.requiredRoles || [],
        requiredPermissions: result.requiredPermissions || [],
        userRoles: result.user?.roles || [],
        userPermissions: result.user?.permissions || [],
        policyVersion: result.policyVersion || "1.0.0",
        correlationId: result.context?.correlationId,
      });
    }
  } catch (error) {
    console.error("Policy evaluation error:", error);
    return next(AppError.internalServerError("Policy evaluation failed"));
  }
});

/**
 * Batch Policy Evaluation Endpoint
 * POST /policy/evaluate-batch
 *
 * Evaluates multiple authorization requests in a single call
 * Useful for mobile apps that need to check multiple permissions upfront
 */
router.post("/evaluate-batch", async (req, res, next) => {
  try {
    const { requests } = req.body;

    if (!requests || !Array.isArray(requests)) {
      return next(AppError.badRequest("Missing or invalid requests array"));
    }

    if (requests.length > 50) {
      return next(AppError.badRequest("Too many requests (max 50)"));
    }

    const results = await policyService.evaluateBatchPolicy(requests);

    // Set policy version header
    res.set("X-Policy-Version", "1.0.0");

    res.json({
      authorized: true,
      results,
      count: results.length,
      timestamp: new Date().toISOString(),
      policyVersion: "1.0.0",
      correlationId: req.headers["x-correlation-id"] || crypto.randomUUID(),
    });
  } catch (error) {
    console.error("Batch policy evaluation error:", error);
    return next(AppError.internalServerError("Batch policy evaluation failed"));
  }
});

/**
 * Get Effective Permissions Endpoint
 * GET /policy/permissions/:resource
 *
 * Returns all permissions a user has for a specific resource
 * Useful for UI rendering (showing/hiding buttons, menus, etc.)
 */
router.get("/permissions/:resource", async (req, res, next) => {
  try {
    const { resource } = req.params;
    
    // Check for gateway-verified headers first
    const jwtVerified = req.headers["x-jwt-verified"];
    const authSource = req.headers["x-auth-source"];
    const hasGatewayHeaders =
      jwtVerified === "true" &&
      (authSource === "gateway" || authSource === "azuread");

    let result;
    if (hasGatewayHeaders) {
      // Use headers from gateway
      result = await policyService.getEffectivePermissionsWithHeaders(req.headers, resource);
    } else {
      // Fallback to token-based (legacy support)
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return next(AppError.unauthorized("Authorization header required"));
      }
      const token = authHeader.substring(7);
      result = await policyService.getEffectivePermissions(token, resource);
    }

    if (!result.success) {
      return next(AppError.unauthorized(result.error));
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
    return next(AppError.internalServerError("Failed to get permissions"));
  }
});

// Phase 1C-2I: the former GET /permissions/roles handler (global role hierarchy) was removed. It was
// unreachable — GET /permissions/:resource (declared earlier) always handles /permissions/roles
// as resource "roles" — and had no callers. Requests to that path keep their existing behaviour.
//
// Phase 1C-2K: the former GET /permissions/system (global permission catalogue) and
// GET /permissions/routes (static frontend route map) handlers were removed for the same reason:
// both were shadowed by GET /permissions/:resource and had no live callers. They were deliberately
// NOT reordered — making them reachable would expose global metadata to any valid token.
// Requests to those paths keep their existing behaviour (served by /permissions/:resource).

/**
 * Quick Authorization Check Endpoint
 * GET /policy/check/:resource/:action
 *
 * Simple authorization check using token from Authorization header
 * Most commonly used endpoint for microservices
 */
router.get("/check/:resource/:action", async (req, res, next) => {
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
      context: {
        ...req.query,
        correlationId: req.headers["x-correlation-id"] || crypto.randomUUID(),
      },
    });

    const statusCode = result.decision === "PERMIT" ? 200 : 403;

    // Set policy version header
    res.set("X-Policy-Version", result.policyVersion || "1.0.0");

    if (result.decision === "PERMIT") {
      res.status(statusCode).json({
        authorized: true,
        decision: result.decision,
        user: result.user,
        resource,
        action,
        timestamp: result.timestamp,
        policyVersion: result.policyVersion || "1.0.0",
        correlationId: result.context?.correlationId,
      });
    } else {
      res.status(statusCode).json({
        authorized: false,
        reason: result.reason,
        requiredRoles: result.requiredRoles || [],
        requiredPermissions: result.requiredPermissions || [],
        userRoles: result.user?.roles || [],
        userPermissions: result.user?.permissions || [],
        policyVersion: result.policyVersion || "1.0.0",
        correlationId: result.context?.correlationId,
      });
    }
  } catch (error) {
    console.error("Quick check error:", error);
    return next(AppError.internalServerError("Authorization check failed"));
  }
});

/**
 * Health Check Endpoint
 * GET /policy/health
 *
 * Health check for the policy service
 */
router.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "RBAC Policy Evaluation Service",
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

/**
 * Policy Information Endpoint
 * GET /policy/info
 *
 * Returns information about available resources and actions
 * Useful for client SDKs and documentation
 */
router.get("/info", (req, res) => {
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
      audit: {
        description: "Audit log read access (audit-service)",
        actions: ["read"],
        userTypes: ["CRM"],
        minRoleLevel: 30,
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
});

/**
 * UI Initialization Endpoint
 * POST /policy/ui/initialize
 *
 * Returns comprehensive UI authorization data for building permission-aware interfaces
 * Includes navigation, actions, features, and page access permissions
 */
router.post("/ui/initialize", async (req, res, next) => {
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

    res.json({
      success: true,
      ...uiData,
    });
  } catch (error) {
    console.error("UI initialization error:", error);
    return next(AppError.internalServerError("UI initialization failed"));
  }
});

/**
 * Cache Management Endpoints
 */

/**
 * Get cache statistics
 * GET /policy/cache/stats
 */
router.get(
  "/cache/stats",
  // Phase 1C-2J: internal operator read (exposes Redis INFO / error text) — trusted SU only
  authenticate,
  tenantContextWarn,
  requireTenant,
  requireSuperUser,
  async (req, res, next) => {
  try {
    const stats = await policyService.cache.getStats();
    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return next(AppError.internalServerError("Failed to get cache stats"));
  }
});

/**
 * Clear policy cache
 * DELETE /policy/cache
 */
router.delete(
  "/cache",
  // Phase 1C-2I: internal operator action — trusted SU only (was unauthenticated)
  authenticate,
  tenantContextWarn,
  requireTenant,
  requireSuperUser,
  async (req, res, next) => {
  try {
    await policyService.cache.clear();
    res.json({
      success: true,
      message: "Policy cache cleared",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return next(AppError.internalServerError("Failed to clear cache"));
  }
});

/**
 * Clear specific cache entry
 * DELETE /policy/cache/:key
 */
router.delete(
  "/cache/:key",
  // Phase 1C-2I: internal operator action — trusted SU only (was unauthenticated)
  authenticate,
  tenantContextWarn,
  requireTenant,
  requireSuperUser,
  async (req, res, next) => {
  try {
    const { key } = req.params;
    await policyService.cache.delete(key);
    res.json({
      success: true,
      message: `Cache entry ${key} cleared`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return next(AppError.internalServerError("Failed to clear cache entry"));
  }
});

module.exports = router;
