const jwt = require("jsonwebtoken");
const { AppError } = require("../errors/AppError");

module.exports.requirePermission = (requiredPermission) => {
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

      // Check for authorization bypass (but still validate token)
      if (process.env.AUTH_BYPASS_ENABLED === "true") {
        // Still validate the token to ensure it's a valid JWT
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);

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

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

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

      // Check for authorization bypass (but still validate token)
      if (process.env.AUTH_BYPASS_ENABLED === "true") {
        // Still validate the token to ensure it's a valid JWT
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);

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

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

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

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

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

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

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

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

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
