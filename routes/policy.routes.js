const express = require("express");
const router = express.Router();
const policyService = require("../services/policyEvaluationService");

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
router.post("/evaluate", async (req, res) => {
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
});

/**
 * Batch Policy Evaluation Endpoint
 * POST /policy/evaluate-batch
 *
 * Evaluates multiple authorization requests in a single call
 * Useful for mobile apps that need to check multiple permissions upfront
 */
router.post("/evaluate-batch", async (req, res) => {
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
});

/**
 * Get Effective Permissions Endpoint
 * GET /policy/permissions/:resource
 *
 * Returns all permissions a user has for a specific resource
 * Useful for UI rendering (showing/hiding buttons, menus, etc.)
 */
router.get("/permissions/:resource", async (req, res) => {
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
});

/**
 * Quick Authorization Check Endpoint
 * GET /policy/check/:resource/:action
 *
 * Simple authorization check using token from Authorization header
 * Most commonly used endpoint for microservices
 */
router.get("/check/:resource/:action", async (req, res) => {
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
 * Cache Management Endpoints
 */

/**
 * Get cache statistics
 * GET /policy/cache/stats
 */
router.get("/cache/stats", async (req, res) => {
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
});

/**
 * Clear policy cache
 * DELETE /policy/cache
 */
router.delete("/cache", async (req, res) => {
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
});

/**
 * Clear specific cache entry
 * DELETE /policy/cache/:key
 */
router.delete("/cache/:key", async (req, res) => {
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
});

module.exports = router;
