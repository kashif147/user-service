const jwt = require("jsonwebtoken");

module.exports.requirePermission = (requiredPermission) => {
  return async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");

      if (!token) {
        return res.status(401).json({
          success: false,
          message: "Access token required",
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
          return res.status(401).json({
            success: false,
            message: "Invalid token",
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
        return res.status(403).json({
          success: false,
          message: "Insufficient permissions",
        });
      }

      req.user = decoded;
      next();
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }
  };
};

module.exports.requireRole = (requiredRole) => {
  return async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");

      if (!token) {
        return res.status(401).json({
          success: false,
          message: "Access token required",
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
          return res.status(401).json({
            success: false,
            message: "Invalid token",
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
        return res.status(403).json({
          success: false,
          message: "Insufficient role privileges",
        });
      }

      req.user = decoded;
      next();
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }
  };
};

module.exports.requireAnyRole = (requiredRoles) => {
  return async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");

      if (!token) {
        return res.status(401).json({
          success: false,
          message: "Access token required",
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
        return res.status(403).json({
          success: false,
          message: "Insufficient role privileges",
        });
      }

      req.user = decoded;
      next();
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }
  };
};

module.exports.requireUserType = (requiredUserType) => {
  return async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");

      if (!token) {
        return res.status(401).json({
          success: false,
          message: "Access token required",
        });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded.userType !== requiredUserType) {
        return res.status(403).json({
          success: false,
          message: "Access denied for this user type",
        });
      }

      req.user = decoded;
      next();
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }
  };
};

module.exports.requireSuperUser = () => {
  return async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");

      if (!token) {
        return res.status(401).json({
          success: false,
          message: "Access token required",
        });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const hasSuperUserRole = decoded.roles?.some(
        (role) => role.code === "SU"
      );
      if (!hasSuperUserRole) {
        return res.status(403).json({
          success: false,
          message: "Super User access required",
        });
      }

      req.user = decoded;
      next();
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }
  };
};
