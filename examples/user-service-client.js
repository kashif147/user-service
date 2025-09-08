/**
 * Example Integration for Other Services
 *
 * This file shows how other services can integrate with the user service
 * for authentication and authorization.
 */

const axios = require("axios");

class UserServiceClient {
  constructor(userServiceUrl, jwtSecret = null) {
    this.userServiceUrl = userServiceUrl;
    this.jwtSecret = jwtSecret; // Optional: for direct JWT validation
  }

  /**
   * Validate token via user service API
   * Use this method when you don't have the JWT secret
   */
  async validateTokenViaAPI(token) {
    try {
      const response = await axios.get(
        `${this.userServiceUrl}/token/validate`,
        {
          headers: {
            Authorization: token,
          },
        }
      );

      if (response.data.success && response.data.valid) {
        return {
          valid: true,
          user: response.data.user,
          expiresAt: response.data.expiresAt,
        };
      } else {
        return { valid: false, error: response.data.error };
      }
    } catch (error) {
      return {
        valid: false,
        error: error.response?.data?.error || error.message,
      };
    }
  }

  /**
   * Validate token directly using JWT secret
   * Use this method when you have the JWT secret for better performance
   */
  validateTokenDirect(token) {
    if (!this.jwtSecret) {
      throw new Error("JWT secret required for direct validation");
    }

    const jwt = require("jsonwebtoken");

    try {
      const decoded = jwt.verify(token.replace("Bearer ", ""), this.jwtSecret);

      return {
        valid: true,
        user: {
          id: decoded.sub || decoded.id,
          tenantId: decoded.tid,
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
  }

  /**
   * Check if user has specific permission
   */
  hasPermission(user, permission) {
    return user.permissions && user.permissions.includes(permission);
  }

  /**
   * Check if user has specific role
   */
  hasRole(user, roleCode) {
    return user.roles && user.roles.some((role) => role.code === roleCode);
  }

  /**
   * Middleware for Express.js applications
   */
  createAuthMiddleware(options = {}) {
    const {
      requireAuth = true,
      requiredPermissions = [],
      requiredRoles = [],
      validateViaAPI = false,
    } = options;

    return async (req, res, next) => {
      try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          if (requireAuth) {
            return res.status(401).json({
              error: "Authorization header required",
              code: "MISSING_TOKEN",
            });
          }
          return next();
        }

        const token = authHeader;
        let validation;

        if (validateViaAPI) {
          validation = await this.validateTokenViaAPI(token);
        } else {
          validation = this.validateTokenDirect(token);
        }

        if (!validation.valid) {
          return res.status(401).json({
            error: "Invalid token",
            code: "INVALID_TOKEN",
            details: validation.error,
          });
        }

        // Check required permissions
        if (requiredPermissions.length > 0) {
          const hasAllPermissions = requiredPermissions.every((permission) =>
            this.hasPermission(validation.user, permission)
          );

          if (!hasAllPermissions) {
            return res.status(403).json({
              error: "Insufficient permissions",
              code: "INSUFFICIENT_PERMISSIONS",
              required: requiredPermissions,
            });
          }
        }

        // Check required roles
        if (requiredRoles.length > 0) {
          const hasRequiredRole = requiredRoles.some((roleCode) =>
            this.hasRole(validation.user, roleCode)
          );

          if (!hasRequiredRole) {
            return res.status(403).json({
              error: "Insufficient role",
              code: "INSUFFICIENT_ROLE",
              required: requiredRoles,
            });
          }
        }

        // Attach user context to request
        req.user = validation.user;
        req.tenantId = validation.user.tenantId;
        req.userId = validation.user.id;

        next();
      } catch (error) {
        res.status(500).json({
          error: "Authentication error",
          code: "AUTH_ERROR",
          details: error.message,
        });
      }
    };
  }
}

// Example usage
async function exampleUsage() {
  const userServiceClient = new UserServiceClient("http://localhost:4000");

  // Example 1: Validate token via API
  const token = "Bearer your-jwt-token-here";
  const validation = await userServiceClient.validateTokenViaAPI(token);

  if (validation.valid) {
    console.log("User authenticated:", validation.user.email);
    console.log("Tenant ID:", validation.user.tenantId);
    console.log(
      "Roles:",
      validation.user.roles.map((r) => r.name)
    );
    console.log("Permissions:", validation.user.permissions);
  } else {
    console.log("Authentication failed:", validation.error);
  }

  // Example 2: Direct validation (if you have JWT secret)
  const clientWithSecret = new UserServiceClient(
    "http://localhost:4000",
    "your-jwt-secret"
  );
  const directValidation = clientWithSecret.validateTokenDirect(token);

  if (directValidation.valid) {
    console.log("Direct validation successful");
  }
}

// Express.js middleware example
function createExpressApp() {
  const express = require("express");
  const app = express();

  const userServiceClient = new UserServiceClient("http://localhost:4000");

  // Public endpoint
  app.get("/public", (req, res) => {
    res.json({ message: "This is a public endpoint" });
  });

  // Protected endpoint (requires authentication)
  app.get(
    "/protected",
    userServiceClient.createAuthMiddleware({ requireAuth: true }),
    (req, res) => {
      res.json({
        message: "This is a protected endpoint",
        user: req.user.email,
        tenant: req.tenantId,
      });
    }
  );

  // Admin endpoint (requires admin role)
  app.get(
    "/admin",
    userServiceClient.createAuthMiddleware({
      requireAuth: true,
      requiredRoles: ["ADMIN"],
    }),
    (req, res) => {
      res.json({
        message: "This is an admin endpoint",
        user: req.user.email,
      });
    }
  );

  // Endpoint with specific permissions
  app.get(
    "/users",
    userServiceClient.createAuthMiddleware({
      requireAuth: true,
      requiredPermissions: ["read:users"],
    }),
    (req, res) => {
      res.json({
        message: "User list endpoint",
        users: [],
      });
    }
  );

  return app;
}

module.exports = UserServiceClient;

