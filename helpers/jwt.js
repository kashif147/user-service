const jwt = require("jsonwebtoken");
const RoleHandler = require("../handlers/role.handler");

module.exports.generateToken = async (user) => {
  try {
    console.log("=== JWT Generation: Starting ===");
    console.log("User ID:", user._id);
    console.log("Tenant ID:", user.tenantId);

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
      tid: user.tenantId, // Tenant ID claim for multi-tenancy
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
      "Bearer " +
      jwt.sign(tokenPayload, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRY,
      });

    console.log("JWT token generated successfully");
    return { token, user };
  } catch (error) {
    console.log("=== JWT Generation: Fallback Mode ===");
    console.log("Error in JWT generation:", error.message);
    console.log("Using fallback token without roles/permissions");

    // Fallback to basic token if permissions can't be fetched
    const token =
      "Bearer " +
      jwt.sign(
        {
          sub: user._id,
          tid: user.tenantId,
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
