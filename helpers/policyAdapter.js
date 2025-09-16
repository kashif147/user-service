/**
 * Policy Adapter - Thin adapter for PDP integration
 *
 * This module provides a clean interface for policy evaluation that follows
 * the PDP pattern. It replaces inline role/permission checks with centralized
 * policy evaluation calls.
 */

const policyService = require("../services/policyEvaluationService");
const crypto = require("crypto");

/**
 * Generate correlation ID for request tracking
 */
const generateCorrelationId = () => {
  return crypto.randomUUID();
};

/**
 * Policy Adapter Class
 */
class PolicyAdapter {
  constructor(options = {}) {
    this.baseURL =
      options.baseURL ||
      process.env.USER_SERVICE_URL ||
      "http://localhost:3000";
    this.timeout = options.timeout || 5000;
    this.retries = options.retries || 3;
  }

  /**
   * Express middleware factory for route protection
   * @param {string} resource - Resource being protected (e.g., 'lookup', 'lookupType')
   * @param {string} action - Action being performed (e.g., 'read', 'write', 'delete')
   * @returns {Function} Express middleware function
   */
  middleware(resource, action) {
    return async (req, res, next) => {
      try {
        // Generate correlation ID for this request
        const correlationId =
          req.headers["x-correlation-id"] || generateCorrelationId();
        req.correlationId = correlationId;

        // Extract token from Authorization header
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return this.sendUnauthorizedResponse(
            res,
            correlationId,
            "Authorization token required"
          );
        }

        const token = authHeader.substring(7);

        // Extract context from request
        const context = {
          correlationId,
          tenantId:
            req.headers["x-tenant-id"] ||
            req.query.tenantId ||
            req.body.tenantId,
          userId:
            req.headers["x-user-id"] || req.query.userId || req.body.userId,
          ...req.query,
          ...req.body,
        };

        // Evaluate policy
        const result = await this.evaluate(token, {
          resource,
          action,
          context,
        });

        if (result.success && result.decision === "PERMIT") {
          // Attach policy context to request for use in controllers
          req.policyContext = result;
          req.user = result.user;
          req.tenantId = result.user?.tenantId;
          next();
        } else {
          return this.sendForbiddenResponse(res, result, correlationId);
        }
      } catch (error) {
        console.error("Policy middleware error:", error);
        return this.sendErrorResponse(res, error, req.correlationId);
      }
    };
  }

  /**
   * Evaluate a single authorization request
   * @param {string} token - JWT token
   * @param {Object} request - Authorization request
   * @param {string} request.resource - Resource being accessed
   * @param {string} request.action - Action being performed
   * @param {Object} request.context - Additional context
   * @returns {Promise<Object>} Policy decision
   */
  async evaluate(token, request) {
    try {
      const { resource, action, context = {} } = request;

      // Add correlation ID to context if not present
      if (!context.correlationId) {
        context.correlationId = generateCorrelationId();
      }

      const result = await policyService.evaluatePolicy({
        token,
        resource,
        action,
        context,
      });

      return {
        success: result.decision === "PERMIT",
        decision: result.decision,
        reason: result.reason,
        user: result.user,
        resource,
        action,
        correlationId: context.correlationId,
        policyVersion: result.policyVersion || "1.0.0",
        timestamp: result.timestamp,
      };
    } catch (error) {
      console.error("Policy evaluation error:", error);
      return {
        success: false,
        decision: "DENY",
        reason: "EVALUATION_ERROR",
        error: error.message,
        correlationId:
          request.context?.correlationId || generateCorrelationId(),
      };
    }
  }

  /**
   * Evaluate multiple authorization requests in batch
   * @param {string} token - JWT token
   * @param {Array} requests - Array of authorization requests
   * @returns {Promise<Array>} Array of policy decisions
   */
  async evaluateBatch(token, requests) {
    try {
      // Add correlation ID and token to each request
      const batchRequests = requests.map((request) => ({
        token,
        ...request,
        context: {
          ...request.context,
          correlationId:
            request.context?.correlationId || generateCorrelationId(),
        },
      }));

      const results = await policyService.evaluateBatchPolicy(batchRequests);

      return results.map((result, index) => ({
        success: result.decision === "PERMIT",
        decision: result.decision,
        reason: result.reason,
        user: result.user,
        resource: requests[index].resource,
        action: requests[index].action,
        correlationId: requests[index].context?.correlationId,
        policyVersion: result.policyVersion || "1.0.0",
        timestamp: result.timestamp,
      }));
    } catch (error) {
      console.error("Batch policy evaluation error:", error);
      return requests.map((request) => ({
        success: false,
        decision: "DENY",
        reason: "BATCH_EVALUATION_ERROR",
        error: error.message,
        resource: request.resource,
        action: request.action,
        correlationId:
          request.context?.correlationId || generateCorrelationId(),
      }));
    }
  }

  /**
   * Check if user has permission (returns boolean)
   * @param {string} token - JWT token
   * @param {string} resource - Resource being accessed
   * @param {string} action - Action being performed
   * @param {Object} context - Additional context
   * @returns {Promise<boolean>} True if permitted, false otherwise
   */
  async hasPermission(token, resource, action, context = {}) {
    try {
      const result = await this.evaluate(token, { resource, action, context });
      return result.success;
    } catch (error) {
      console.error("Permission check failed:", error);
      return false;
    }
  }

  /**
   * Get user permissions for a specific resource
   * @param {string} token - JWT token
   * @param {string} resource - Resource name
   * @returns {Promise<Object>} User permissions
   */
  async getPermissions(token, resource) {
    try {
      return await policyService.getEffectivePermissions(token, resource);
    } catch (error) {
      console.error("Get permissions failed:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Send unauthorized response (401)
   * @private
   */
  sendUnauthorizedResponse(res, correlationId, message = "Unauthorized") {
    return res.status(401).json({
      authorized: false,
      reason: "MISSING_TOKEN",
      requiredRoles: [],
      requiredPermissions: [],
      userRoles: [],
      userPermissions: [],
      policyVersion: "1.0.0",
      correlationId,
    });
  }

  /**
   * Send forbidden response (403)
   * @private
   */
  sendForbiddenResponse(res, result, correlationId) {
    return res.status(403).json({
      authorized: false,
      reason: result.reason,
      requiredRoles: result.requiredRoles || [],
      requiredPermissions: result.requiredPermissions || [],
      userRoles: result.user?.roles || [],
      userPermissions: result.user?.permissions || [],
      policyVersion: result.policyVersion || "1.0.0",
      correlationId,
    });
  }

  /**
   * Send error response (500)
   * @private
   */
  sendErrorResponse(res, error, correlationId) {
    return res.status(500).json({
      authorized: false,
      reason: "POLICY_SERVICE_ERROR",
      error: error.message,
      requiredRoles: [],
      requiredPermissions: [],
      userRoles: [],
      userPermissions: [],
      policyVersion: "1.0.0",
      correlationId,
    });
  }

  /**
   * Clear the policy cache
   */
  async clearCache() {
    try {
      await policyService.cache.clear();
    } catch (error) {
      console.error("Failed to clear policy cache:", error);
    }
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  async getCacheStats() {
    try {
      return await policyService.cache.getStats();
    } catch (error) {
      console.error("Failed to get cache stats:", error);
      return { error: error.message };
    }
  }
}

// Create default policy adapter instance
const defaultPolicyAdapter = new PolicyAdapter({
  baseURL: process.env.USER_SERVICE_URL || "http://localhost:3000",
  timeout: 5000,
  retries: 3,
});

module.exports = PolicyAdapter;
module.exports.defaultPolicyAdapter = defaultPolicyAdapter;
