const jwt = require("jsonwebtoken");
const User = require("../models/user");

module.exports.authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Access token required" });
    }

    const token = authHeader.substring(7); // Remove 'Bearer '
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach user info to request
    req.user = decoded;
    req.userId = decoded.id;

    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

module.exports.requireRole = (requiredRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const userRoles = req.user.roles.map((role) => role.code);
    const hasRequiredRole = requiredRoles.some((role) =>
      userRoles.includes(role)
    );

    if (!hasRequiredRole) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    next();
  };
};

module.exports.requirePermission = (requiredPermissions) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // Super User has all permissions
    if (req.user.permissions.includes("*")) {
      return next();
    }

    const hasRequiredPermission = requiredPermissions.some((permission) =>
      req.user.permissions.includes(permission)
    );

    if (!hasRequiredPermission) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    next();
  };
};
