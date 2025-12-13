const jwt = require("jsonwebtoken");
const RoleHandler = require("../handlers/role.handler");

/**
 * Generate JWT access token for user
 * @param {Object} user - User object from database
 * @returns {Object} - Token and user data
 */
module.exports.generateToken = async (user) => {
  try {
    console.log("=== JWT Generation: Starting ===");
    console.log("User ID:", user._id);
    console.log("Tenant ID:", user.tenantId);
    console.log("User object keys:", Object.keys(user));

    // Validate required fields
    if (!user.tenantId) {
      console.error("ERROR: User tenantId is missing!");
      console.error("User object:", JSON.stringify(user, null, 2));
      throw new Error("User tenantId is required for JWT generation");
    }

    // Get user permissions based on their roles
    console.log("Fetching user permissions...");
    const permissions = await RoleHandler.getUserPermissions(
      user._id,
      user.tenantId
    );
    console.log("Permissions fetched:", permissions);

    console.log("Fetching user roles...");
    const roles = await RoleHandler.getUserRoles(user._id, user.tenantId);
    console.log("Roles fetched:", roles.length, "roles");

    const tokenPayload = {
      sub: user._id, // Standard JWT subject claim
      tenantId: user.tenantId, // Tenant ID claim for multi-tenancy
      id: user._id, // Keep for backward compatibility
      email: user.userEmail,
      userType: user.userType,
      roles: roles.map((role) => ({
        id: role._id,
        code: role.code,
        name: role.name,
      })),
      permissions: permissions,
    };

    console.log("Generating JWT token with payload...");
    const token =
      // "Bearer " +
      jwt.sign(tokenPayload, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRY,
      });

    console.log("JWT token generated successfully");
    return { token, user };
  } catch (error) {
    console.log("=== JWT Generation: Fallback Mode ===");
    console.log("Error in JWT generation:", error.message);
    console.log("Using fallback token without roles/permissions");

    // Ensure tenantId exists even in fallback mode
    if (!user.tenantId) {
      console.error("CRITICAL: tenantId is missing in fallback mode too!");
      throw new Error("User tenantId is required for JWT generation");
    }

    // Fallback to basic token if permissions can't be fetched
    const token =
      // "Bearer " +
      jwt.sign(
        {
          sub: user._id,
          tenantId: user.tenantId,
          id: user._id, // Keep for backward compatibility
          email: user.userEmail,
          userType: user.userType,
        },
        process.env.JWT_SECRET,
        {
          expiresIn: process.env.JWT_EXPIRY,
        }
      );

    console.log("Fallback JWT token generated");
    return { token, user };
  }
};

/**
 * Decode JWT token (verification removed)
 * @param {string} token - JWT token to decode
 * @returns {Object} - Decoded token payload
 */
module.exports.verifyToken = (token) => {
  try {
    const decoded = jwt.decode(token);
    if (!decoded) {
      throw new Error("Invalid token format");
    }
    return decoded;
  } catch (error) {
    throw new Error(`Token decoding failed: ${error.message}`);
  }
};

/**
 * Decode JWT token without verification (for inspection)
 * @param {string} token - JWT token to decode
 * @returns {Object} - Decoded token payload
 */
module.exports.decodeToken = (token) => {
  try {
    return jwt.decode(token);
  } catch (error) {
    throw new Error(`Token decoding failed: ${error.message}`);
  }
};

/**
 * Check if token is expired
 * @param {string} token - JWT token to check
 * @returns {boolean} - True if expired, false otherwise
 */
module.exports.isTokenExpired = (token) => {
  try {
    const decoded = jwt.decode(token);
    if (!decoded || !decoded.exp) {
      return true;
    }

    const now = Math.floor(Date.now() / 1000);
    return decoded.exp < now;
  } catch (error) {
    return true;
  }
};

/**
 * Get token expiration time
 * @param {string} token - JWT token to check
 * @returns {Date|null} - Expiration date or null if invalid
 */
module.exports.getTokenExpiration = (token) => {
  try {
    const decoded = jwt.decode(token);
    if (!decoded || !decoded.exp) {
      return null;
    }

    return new Date(decoded.exp * 1000);
  } catch (error) {
    return null;
  }
};
