/**
 * Centralized RBAC Policy Middleware
 *
 * This middleware integrates with the centralized policy evaluation service
 * using the node-policy-client.js SDK for consistent authorization across
 * all microservices.
 */

const PolicyClient = require("../sdks/node-policy-client");

class PolicyMiddleware {
  constructor(baseURL, options = {}) {
    this.policyClient = new PolicyClient(baseURL, options);
  }

  /**
   * Express middleware factory for route protection
   * @param {string} resource - Resource being protected (e.g., 'tenant', 'user', 'role', 'permission')
   * @param {string} action - Action being performed (e.g., 'read', 'write', 'delete', 'create')
   * @returns {Function} Express middleware function
   */
  requirePermission(resource, action) {
    return async (req, res, next) => {
      try {
        const token = req.headers.authorization?.replace("Bearer ", "");

        if (!token) {
          return res.status(401).json({
            success: false,
            error: "Authorization token required",
            code: "MISSING_TOKEN",
          });
        }

        // Extract context from request
        const context = {
          userId: req.ctx?.userId || req.user?.id || req.userId,
          tenantId: req.ctx?.tenantId || req.user?.tenantId || req.tenantId,
          userRoles: req.ctx?.roles || req.user?.roles || req.roles || [],
          userPermissions:
            req.ctx?.permissions ||
            req.user?.permissions ||
            req.permissions ||
            [],
          ...req.body, // Include request body for additional context
        };

        const result = await this.policyClient.evaluatePolicy(
          token,
          resource,
          action,
          context
        );

        if (result.success && result.decision === "PERMIT") {
          // Attach policy context to request for use in controllers
          req.policyContext = result;
          next();
        } else {
          return res.status(403).json({
            success: false,
            error: "Insufficient permissions",
            reason: result.reason,
            code: "PERMISSION_DENIED",
            resource,
            action,
          });
        }
      } catch (error) {
        console.error("Policy middleware error:", error);
        return res.status(500).json({
          success: false,
          error: "Authorization service error",
          code: "POLICY_SERVICE_ERROR",
        });
      }
    };
  }

  /**
   * Check if user has permission (returns boolean)
   * @param {string} token - JWT token
   * @param {string} resource - Resource being accessed
   * @param {string} action - Action being performed
   * @param {Object} context - Additional context (optional)
   * @returns {boolean} True if permitted, false otherwise
   */
  async hasPermission(token, resource, action, context = {}) {
    try {
      const result = await this.policyClient.evaluatePolicy(
        token,
        resource,
        action,
        context
      );
      return result.success && result.decision === "PERMIT";
    } catch (error) {
      console.error("Permission check failed:", error);
      return false;
    }
  }

  /**
   * Get user permissions for a specific resource
   * @param {string} token - JWT token
   * @param {string} resource - Resource name
   * @returns {Object} User permissions
   */
  async getPermissions(token, resource) {
    return await this.policyClient.getPermissions(token, resource);
  }

  /**
   * Clear the policy client cache
   */
  clearCache() {
    this.policyClient.clearCache();
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  getCacheStats() {
    return this.policyClient.getCacheStats();
  }
}

// Create default policy middleware instance
const defaultPolicyMiddleware = new PolicyMiddleware(
  process.env.USER_SERVICE_URL || "http://localhost:3000",
  {
    timeout: 5000,
    retries: 3,
    cacheTimeout: 300000, // 5 minutes
  }
);

module.exports = PolicyMiddleware;
module.exports.defaultPolicyMiddleware = defaultPolicyMiddleware;
