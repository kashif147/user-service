const jwt = require("jsonwebtoken");
const { AppError } = require("../errors/AppError");
const {
  validateGatewayRequest,
} = require("@membership/policy-middleware/security");

module.exports.requirePermission = (requiredPermission) => {
  return async (req, res, next) => {
    try {
      // Check for gateway-verified headers first
      const jwtVerified = req.headers["x-jwt-verified"];
      const authSource = req.headers["x-auth-source"];

      if (jwtVerified === "true" && authSource === "gateway") {
        // Validate gateway request
        const validation = validateGatewayRequest(req);
        if (!validation.valid) {
          const authError = AppError.unauthorized("Invalid gateway request", {
            tokenError: true,
            validationError: validation.reason,
          });
          return res.status(authError.status).json({
            success: false,
            error: {
              message: authError.message,
              code: authError.code,
              status: authError.status,
              tokenError: authError.tokenError,
              validationError: authError.validationError,
            },
            correlationId:
              req.correlationId ||
              req.headers["x-correlation-id"] ||
              require("crypto").randomUUID(),
          });
        }

        // Read from gateway headers
        const userId = req.headers["x-user-id"];
        const tenantId = req.headers["x-tenant-id"];
        const userEmail = req.headers["x-user-email"];
        const userType = req.headers["x-user-type"];
        const userRolesStr = req.headers["x-user-roles"] || "[]";
        const userPermissionsStr = req.headers["x-user-permissions"] || "[]";

        let roles = [];
        let permissions = [];

        try {
          const rolesArray = JSON.parse(userRolesStr);
          roles = Array.isArray(rolesArray)
            ? rolesArray
                .map((role) => (typeof role === "string" ? role : role?.code))
                .filter(Boolean)
            : [];
        } catch (e) {
          console.warn("Failed to parse x-user-roles:", e.message);
        }

        try {
          permissions = JSON.parse(userPermissionsStr);
          if (!Array.isArray(permissions)) permissions = [];
        } catch (e) {
          console.warn("Failed to parse x-user-permissions:", e.message);
        }

        // Check for authorization bypass
        if (process.env.AUTH_BYPASS_ENABLED === "true") {
          req.user = {
            id: userId,
            tenantId,
            email: userEmail,
            userType,
            roles,
            permissions,
          };
          return next();
        }

        // Check Super User role
        const hasSuperUserRole = roles.some(
          (role) => role === "SU" || role?.code === "SU"
        );
        if (hasSuperUserRole) {
          req.user = {
            id: userId,
            tenantId,
            email: userEmail,
            userType,
            roles,
            permissions,
          };
          return next();
        }

        // Check specific permission
        if (!permissions.includes(requiredPermission)) {
          const forbiddenError = AppError.forbidden(
            "Insufficient permissions",
            {
              requiredPermission,
              userPermissions: permissions,
            }
          );
          return res.status(forbiddenError.status).json({
            success: false,
            error: {
              message: forbiddenError.message,
              code: forbiddenError.code,
              status: forbiddenError.status,
              requiredPermission: forbiddenError.requiredPermission,
              userPermissions: forbiddenError.userPermissions,
            },
            correlationId:
              req.correlationId ||
              req.headers["x-correlation-id"] ||
              require("crypto").randomUUID(),
          });
        }

        req.user = {
          id: userId,
          tenantId,
          email: userEmail,
          userType,
          roles,
          permissions,
        };
        return next();
      }

      // Fallback: Legacy token-based flow
      const token = req.headers.authorization?.replace("Bearer ", "");

      if (!token) {
        const authError = AppError.unauthorized("Access token required", {
          tokenError: true,
          missingHeader: true,
        });
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

      // Check for authorization bypass (decode token without verification)
      if (process.env.AUTH_BYPASS_ENABLED === "true") {
        try {
          const decoded = jwt.decode(token);
          if (!decoded) {
            const authError = AppError.unauthorized("Invalid token format", {
              tokenError: true,
              invalidToken: true,
            });
            return res.status(authError.status).json({
              success: false,
              error: {
                message: authError.message,
                code: authError.code,
                status: authError.status,
                tokenError: authError.tokenError,
                invalidToken: authError.invalidToken,
              },
              correlationId:
                req.correlationId ||
                req.headers["x-correlation-id"] ||
                require("crypto").randomUUID(),
            });
          }
          const tenantId =
            decoded.tenantId || decoded.tid || decoded.extension_tenantId;
          req.user = {
            id: decoded.sub || decoded.id,
            tenantId: tenantId,
            email: decoded.email,
            userType: decoded.userType,
            roles: decoded.roles || [],
            permissions: decoded.permissions || [],
          };
          return next();
        } catch (error) {
          const authError = AppError.unauthorized("Invalid token", {
            tokenError: true,
            jwtError: error.message,
          });
          return res.status(authError.status).json({
            success: false,
            error: {
              message: authError.message,
              code: authError.code,
              status: authError.status,
              tokenError: authError.tokenError,
              jwtError: authError.jwtError,
            },
            correlationId:
              req.correlationId ||
              req.headers["x-correlation-id"] ||
              require("crypto").randomUUID(),
          });
        }
      }

      const decoded = jwt.decode(token);
      if (!decoded) {
        const authError = AppError.unauthorized("Invalid token format", {
          tokenError: true,
          invalidToken: true,
        });
        return res.status(authError.status).json({
          success: false,
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            invalidToken: authError.invalidToken,
          },
          correlationId:
            req.correlationId ||
            req.headers["x-correlation-id"] ||
            require("crypto").randomUUID(),
        });
      }

      // Check if user has Super User role (full access)
      const hasSuperUserRole = decoded.roles?.some(
        (role) => role.code === "SU"
      );
      if (hasSuperUserRole) {
        req.user = decoded;
        return next();
      }

      // Check specific permission
      if (
        !decoded.permissions ||
        !decoded.permissions.includes(requiredPermission)
      ) {
        const forbiddenError = AppError.forbidden("Insufficient permissions", {
          requiredPermission,
          userPermissions: decoded.permissions || [],
        });
        return res.status(forbiddenError.status).json({
          success: false,
          error: {
            message: forbiddenError.message,
            code: forbiddenError.code,
            status: forbiddenError.status,
            requiredPermission: forbiddenError.requiredPermission,
            userPermissions: forbiddenError.userPermissions,
          },
          correlationId:
            req.correlationId ||
            req.headers["x-correlation-id"] ||
            require("crypto").randomUUID(),
        });
      }

      req.user = decoded;
      next();
    } catch (error) {
      const authError = AppError.unauthorized("Invalid token", {
        tokenError: true,
        jwtError: error.message,
      });
      return res.status(authError.status).json({
        success: false,
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          tokenError: authError.tokenError,
          jwtError: authError.jwtError,
        },
        correlationId:
          req.correlationId ||
          req.headers["x-correlation-id"] ||
          require("crypto").randomUUID(),
      });
    }
  };
};

module.exports.requireRole = (requiredRole) => {
  return async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");

      if (!token) {
        const authError = AppError.unauthorized("Access token required", {
          tokenError: true,
          missingHeader: true,
        });
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

      // Check for authorization bypass (decode token without verification)
      if (process.env.AUTH_BYPASS_ENABLED === "true") {
        // Decode the token without verification
        try {
          const decoded = jwt.decode(token);
          if (!decoded) {
            const authError = AppError.unauthorized("Invalid token format", {
              tokenError: true,
              invalidToken: true,
            });
            return res.status(authError.status).json({
              success: false,
              error: {
                message: authError.message,
                code: authError.code,
                status: authError.status,
                tokenError: authError.tokenError,
                invalidToken: authError.invalidToken,
              },
              correlationId:
                req.correlationId ||
                req.headers["x-correlation-id"] ||
                require("crypto").randomUUID(),
            });
          }

          // Extract tenantId from token
          const tenantId =
            decoded.tenantId || decoded.tid || decoded.extension_tenantId;

          req.user = {
            id: decoded.sub || decoded.id,
            tenantId: tenantId,
            email: decoded.email,
            userType: decoded.userType,
            roles: decoded.roles || [],
            permissions: decoded.permissions || [],
          };
          return next();
        } catch (error) {
          const authError = AppError.unauthorized("Invalid token", {
            tokenError: true,
            jwtError: error.message,
          });
          return res.status(authError.status).json({
            success: false,
            error: {
              message: authError.message,
              code: authError.code,
              status: authError.status,
              tokenError: authError.tokenError,
              jwtError: authError.jwtError,
            },
            correlationId:
              req.correlationId ||
              req.headers["x-correlation-id"] ||
              require("crypto").randomUUID(),
          });
        }
      }

      const decoded = jwt.decode(token);
      if (!decoded) {
        const authError = AppError.unauthorized("Invalid token format", {
          tokenError: true,
          invalidToken: true,
        });
        return res.status(authError.status).json({
          success: false,
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            invalidToken: authError.invalidToken,
          },
          correlationId:
            req.correlationId ||
            req.headers["x-correlation-id"] ||
            require("crypto").randomUUID(),
        });
      }

      // Check if user has Super User role (full access)
      const hasSuperUserRole = decoded.roles?.some(
        (role) => role.code === "SU"
      );
      if (hasSuperUserRole) {
        req.user = decoded;
        return next();
      }

      // Check specific role
      const hasRequiredRole = decoded.roles?.some(
        (role) => role.code === requiredRole
      );
      if (!hasRequiredRole) {
        const forbiddenError = AppError.forbidden(
          "Insufficient role privileges",
          {
            requiredRole,
            userRoles: decoded.roles || [],
          }
        );
        return res.status(forbiddenError.status).json({
          success: false,
          error: {
            message: forbiddenError.message,
            code: forbiddenError.code,
            status: forbiddenError.status,
            requiredRole: forbiddenError.requiredRole,
            userRoles: forbiddenError.userRoles,
          },
          correlationId:
            req.correlationId ||
            req.headers["x-correlation-id"] ||
            require("crypto").randomUUID(),
        });
      }

      req.user = decoded;
      next();
    } catch (error) {
      const authError = AppError.unauthorized("Invalid token", {
        tokenError: true,
        jwtError: error.message,
      });
      return res.status(authError.status).json({
        success: false,
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          tokenError: authError.tokenError,
          jwtError: authError.jwtError,
        },
        correlationId:
          req.correlationId ||
          req.headers["x-correlation-id"] ||
          require("crypto").randomUUID(),
      });
    }
  };
};

module.exports.requireAnyRole = (requiredRoles) => {
  return async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");

      if (!token) {
        const authError = AppError.unauthorized("Access token required", {
          tokenError: true,
          missingHeader: true,
        });
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

      const decoded = jwt.decode(token);
      if (!decoded) {
        const authError = AppError.unauthorized("Invalid token format", {
          tokenError: true,
          invalidToken: true,
        });
        return res.status(authError.status).json({
          success: false,
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            invalidToken: authError.invalidToken,
          },
          correlationId:
            req.correlationId ||
            req.headers["x-correlation-id"] ||
            require("crypto").randomUUID(),
        });
      }

      // Check if user has Super User role (full access)
      const hasSuperUserRole = decoded.roles?.some(
        (role) => role.code === "SU"
      );
      if (hasSuperUserRole) {
        req.user = decoded;
        return next();
      }

      // Check if user has any of the required roles
      const hasAnyRequiredRole = decoded.roles?.some((role) =>
        requiredRoles.includes(role.code)
      );

      if (!hasAnyRequiredRole) {
        const forbiddenError = AppError.forbidden(
          "Insufficient role privileges",
          {
            requiredRole,
            userRoles: decoded.roles || [],
          }
        );
        return res.status(forbiddenError.status).json({
          success: false,
          error: {
            message: forbiddenError.message,
            code: forbiddenError.code,
            status: forbiddenError.status,
            requiredRole: forbiddenError.requiredRole,
            userRoles: forbiddenError.userRoles,
          },
          correlationId:
            req.correlationId ||
            req.headers["x-correlation-id"] ||
            require("crypto").randomUUID(),
        });
      }

      req.user = decoded;
      next();
    } catch (error) {
      const authError = AppError.unauthorized("Invalid token", {
        tokenError: true,
        jwtError: error.message,
      });
      return res.status(authError.status).json({
        success: false,
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          tokenError: authError.tokenError,
          jwtError: authError.jwtError,
        },
        correlationId:
          req.correlationId ||
          req.headers["x-correlation-id"] ||
          require("crypto").randomUUID(),
      });
    }
  };
};

module.exports.requireUserType = (requiredUserType) => {
  return async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");

      if (!token) {
        const authError = AppError.unauthorized("Access token required", {
          tokenError: true,
          missingHeader: true,
        });
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

      const decoded = jwt.decode(token);
      if (!decoded) {
        const authError = AppError.unauthorized("Invalid token format", {
          tokenError: true,
          invalidToken: true,
        });
        return res.status(authError.status).json({
          success: false,
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            invalidToken: authError.invalidToken,
          },
          correlationId:
            req.correlationId ||
            req.headers["x-correlation-id"] ||
            require("crypto").randomUUID(),
        });
      }

      if (decoded.userType !== requiredUserType) {
        const forbiddenError = AppError.forbidden(
          "Access denied for this user type",
          {
            requiredUserType,
            userType: decoded.userType,
          }
        );
        return res.status(forbiddenError.status).json({
          success: false,
          error: {
            message: forbiddenError.message,
            code: forbiddenError.code,
            status: forbiddenError.status,
            requiredUserType: forbiddenError.requiredUserType,
            userType: forbiddenError.userType,
          },
          correlationId:
            req.correlationId ||
            req.headers["x-correlation-id"] ||
            require("crypto").randomUUID(),
        });
      }

      req.user = decoded;
      next();
    } catch (error) {
      const authError = AppError.unauthorized("Invalid token", {
        tokenError: true,
        jwtError: error.message,
      });
      return res.status(authError.status).json({
        success: false,
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          tokenError: authError.tokenError,
          jwtError: authError.jwtError,
        },
        correlationId:
          req.correlationId ||
          req.headers["x-correlation-id"] ||
          require("crypto").randomUUID(),
      });
    }
  };
};

module.exports.requireSuperUser = () => {
  return async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");

      if (!token) {
        const authError = AppError.unauthorized("Access token required", {
          tokenError: true,
          missingHeader: true,
        });
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

      const decoded = jwt.decode(token);
      if (!decoded) {
        const authError = AppError.unauthorized("Invalid token format", {
          tokenError: true,
          invalidToken: true,
        });
        return res.status(authError.status).json({
          success: false,
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            invalidToken: authError.invalidToken,
          },
          correlationId:
            req.correlationId ||
            req.headers["x-correlation-id"] ||
            require("crypto").randomUUID(),
        });
      }

      const hasSuperUserRole = decoded.roles?.some(
        (role) => role.code === "SU"
      );
      if (!hasSuperUserRole) {
        const forbiddenError = AppError.forbidden(
          "Super User access required",
          {
            userRoles: decoded.roles || [],
          }
        );
        return res.status(forbiddenError.status).json({
          success: false,
          error: {
            message: forbiddenError.message,
            code: forbiddenError.code,
            status: forbiddenError.status,
            userRoles: forbiddenError.userRoles,
          },
          correlationId:
            req.correlationId ||
            req.headers["x-correlation-id"] ||
            require("crypto").randomUUID(),
        });
      }

      req.user = decoded;
      next();
    } catch (error) {
      const authError = AppError.unauthorized("Invalid token", {
        tokenError: true,
        jwtError: error.message,
      });
      return res.status(authError.status).json({
        success: false,
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          tokenError: authError.tokenError,
          jwtError: authError.jwtError,
        },
        correlationId:
          req.correlationId ||
          req.headers["x-correlation-id"] ||
          require("crypto").randomUUID(),
      });
    }
  };
};
