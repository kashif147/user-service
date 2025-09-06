const jwt = require("jsonwebtoken");
const RoleHandler = require("../handlers/role.handler");

module.exports.generateToken = async (user) => {
  try {
    // Get user permissions based on their roles
    const permissions = await RoleHandler.getUserPermissions(
      user._id,
      user.tenantId
    );
    const roles = await RoleHandler.getUserRoles(user._id, user.tenantId);

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

    return {
      token:
        "Bearer " +
        jwt.sign(tokenPayload, process.env.JWT_SECRET, {
          expiresIn: process.env.JWT_EXPIRY,
        }),
      user,
    };
  } catch (error) {
    // Fallback to basic token if permissions can't be fetched
    return {
      token:
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
        ),
      user,
    };
  }
};
