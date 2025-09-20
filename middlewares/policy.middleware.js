/**
 * Centralized RBAC Policy Middleware
 *
 * This middleware integrates with the centralized policy evaluation service
 * using the node-policy-client.js SDK for consistent authorization across
 * all microservices.
 */

const PolicyClient = require("../sdks/node-policy-client");
const { AppError } = require("../errors/AppError");

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

        // Check for authorization bypass (but still validate token)
        if (process.env.AUTH_BYPASS_ENABLED === "true") {
          // Still validate the token to ensure it's a valid JWT
          try {
            const jwt = require("jsonwebtoken");
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            // Extract tenantId from token
            const tenantId =
              decoded.tenantId || decoded.tid || decoded.extension_tenantId;

            req.policyContext = {
              decision: "PERMIT",
              reason: "AUTHORIZATION_BYPASS_ENABLED",
              bypass: true,
              user: {
                id: decoded.sub || decoded.id,
                tenantId: tenantId,
                email: decoded.email,
                userType: decoded.userType,
                roles: decoded.roles || [],
                permissions: decoded.permissions || [],
              },
            };
            return next();
          } catch (error) {
            return next(AppError.unauthorized("Invalid token"));
          }
        }

        if (!token) {
          const authError = AppError.unauthorized(
            "Authorization token required",
            {
              tokenError: true,
              missingHeader: true,
            }
          );
          return res.status(authError.status).json({
            success: false,
            error: {
              message: authError.message,
              code: authError.code,
              status: authError.status,
              tokenError: authError.tokenError,
              missingHeader: authError.missingHeader,
            },
            correlationId:
              req.correlationId ||
              req.headers["x-correlation-id"] ||
              require("crypto").randomUUID(),
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
          const forbiddenError = AppError.forbidden(
            "Insufficient permissions",
            {
              resource,
              action,
              reason: result.reason,
            }
          );
          return res.status(forbiddenError.status).json({
            success: false,
            error: {
              message: forbiddenError.message,
              code: forbiddenError.code,
              status: forbiddenError.status,
              resource: forbiddenError.resource,
              action: forbiddenError.action,
              reason: forbiddenError.reason,
            },
            correlationId:
              req.correlationId ||
              req.headers["x-correlation-id"] ||
              require("crypto").randomUUID(),
          });
        }
      } catch (error) {
        console.error("Policy middleware error:", error);
        const serverError = AppError.internalServerError(
          "Authorization service error",
          {
            policyServiceError: true,
            originalError: error.message,
          }
        );
        return res.status(serverError.status).json({
          success: false,
          error: {
            message: serverError.message,
            code: serverError.code,
            status: serverError.status,
            policyServiceError: serverError.policyServiceError,
            originalError: serverError.originalError,
          },
          correlationId:
            req.correlationId ||
            req.headers["x-correlation-id"] ||
            require("crypto").randomUUID(),
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
