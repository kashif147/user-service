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
    const rawPermissions = await RoleHandler.getUserPermissions(
      user._id,
      user.tenantId
    );
    console.log("Raw permissions fetched:", rawPermissions);

    // CRITICAL: Normalize permissions ONCE at token generation
    // Convert CODE_FORMAT (PORTAL_CREATE) to canonical format (portal:create)
    // This ensures all downstream systems use the same format
    const normalizePermission = (perm) => {
      if (!perm || typeof perm !== "string") return perm;
      // If already normalized (contains colon), return as-is
      if (perm.includes(":")) return perm.toLowerCase();
      // Convert CODE_FORMAT to resource:action
      return perm.toLowerCase().replace(/_/g, ":");
    };

    const permissions = rawPermissions.map(normalizePermission);
    console.log("Normalized permissions:", permissions);

    console.log("Fetching user roles...");
    const roles = await RoleHandler.getUserRoles(user._id, user.tenantId);
    console.log("Roles fetched:", roles.length, "roles");

    // CRITICAL: Enforce payload invariants before signing
    // This prevents silent bad tokens from being issued
    if (!user._id) {
      throw new Error("JWT invariant violation: missing user._id");
    }
    if (!user.tenantId) {
      throw new Error("JWT invariant violation: missing user.tenantId");
    }
    if (!Array.isArray(permissions)) {
      throw new Error("JWT invariant violation: permissions must be an array");
    }
    if (!Array.isArray(roles)) {
      throw new Error("JWT invariant violation: roles must be an array");
    }

    // CRITICAL: Canonical JWT payload format - SINGLE SOURCE OF TRUTH
    // All tokens MUST have this exact structure for gateway and policy consistency
    const tokenPayload = {
      sub: user._id, // Standard JWT subject claim
      tenantId: user.tenantId, // Tenant ID claim for multi-tenancy
      id: user._id, // REQUIRED: Gateway uses payload.id (not sub) for x-user-id header
      email: user.userEmail,
      userType: user.userType,
      roles: roles.map((role) => ({
        id: role._id,
        code: role.code,
        name: role.name,
      })),
      permissions: permissions, // REQUIRED: Policy evaluation needs permissions
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
    // CRITICAL: Even fallback must include id field for gateway consistency
    const token =
      // "Bearer " +
      jwt.sign(
        {
          sub: user._id,
          tenantId: user.tenantId,
          id: user._id, // REQUIRED: Gateway uses payload.id for x-user-id header
          email: user.userEmail,
          userType: user.userType,
          roles: [], // Empty array instead of missing field
          permissions: [], // Empty array instead of missing field
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
