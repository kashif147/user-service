const Role = require("../models/role.model");

/**
 * Sets portal user to NON-MEMBER only (replaces role list).
 * @returns {Promise<boolean>}
 */
module.exports.assignNonMemberRole = async (user, tenantId) => {
  try {
    const nonMemberRole = await Role.findOne({
      code: "NON-MEMBER",
      tenantId,
      isActive: true,
    });
    if (!nonMemberRole) {
      console.log(
        `Warning: NON-MEMBER role not found for tenant ${tenantId}, cannot demote`
      );
      return false;
    }
    user.roles = [nonMemberRole._id];
    console.log(
      `Assigned NON-MEMBER role to portal user in tenant ${tenantId} (membership ended)`
    );
    return true;
  } catch (error) {
    console.log("Error assigning NON-MEMBER role:", error.message);
    return false;
  }
};

/**
 * Assigns MEMBER role to a user (e.g. when they have approved membership on first login)
 * @param {Object} user - The user object
 * @param {string} tenantId - The tenant ID for tenant isolation
 * @returns {Promise<boolean>} - true if role was assigned
 */
module.exports.assignMemberRole = async (user, tenantId) => {
  try {
    const memberRole = await Role.findOne({
      code: "MEMBER",
      tenantId,
      isActive: true,
    });
    if (!memberRole) {
      console.log(
        `Warning: MEMBER role not found for tenant ${tenantId}, falling back to default`
      );
      return false;
    }
    user.roles = [memberRole._id];
    console.log(
      `Assigned MEMBER role to portal user in tenant ${tenantId} (approved membership)`
    );
    return true;
  } catch (error) {
    console.log("Error assigning MEMBER role:", error.message);
    return false;
  }
};

/**
 * Assigns default role to a user based on their user type
 * @param {Object} user - The user object
 * @param {string} userType - The user type (PORTAL or CRM)
 * @param {string} tenantId - The tenant ID for tenant isolation
 * @returns {Promise<void>}
 */
module.exports.assignDefaultRole = async (user, userType, tenantId) => {
  try {
    let defaultRoleCode;

    if (userType === "PORTAL") {
      defaultRoleCode = "NON-MEMBER";
    } else if (userType === "CRM") {
      defaultRoleCode = "REO"; // Read Only as default CRM role
    } else {
      console.log(`Unknown user type: ${userType}, skipping role assignment`);
      return;
    }

    const defaultRole = await Role.findOne({
      code: defaultRoleCode,
      tenantId: tenantId,
      isActive: true,
    });

    if (defaultRole) {
      user.roles = [defaultRole._id];
      console.log(
        `Assigned ${defaultRoleCode} role to new ${userType} user in tenant ${tenantId}`
      );
    } else {
      console.log(
        `Warning: Default ${userType} role (${defaultRoleCode}) not found for tenant ${tenantId}, user created without role`
      );
    }
  } catch (error) {
    console.log(
      `Error assigning default role to ${userType} user:`,
      error.message
    );
  }
};

/**
 * Checks if a user already has any roles assigned
 * @param {string} userId - The user ID
 * @param {string} tenantId - The tenant ID for tenant isolation
 * @returns {Promise<boolean>}
 */
module.exports.userHasRoles = async (userId, tenantId) => {
  try {
    const User = require("../models/user.model");
    const user = await User.findOne({ _id: userId, tenantId }).populate(
      "roles"
    );
    return user && user.roles && user.roles.length > 0;
  } catch (error) {
    console.log("Error checking user roles:", error.message);
    return false;
  }
};

/**
 * Gets the default role code for a user type
 * @param {string} userType - The user type (PORTAL or CRM)
 * @returns {string|null}
 */
module.exports.getDefaultRoleCode = (userType) => {
  const defaultRoles = {
    PORTAL: "NON-MEMBER",
    CRM: "REO", // Read Only
  };

  return defaultRoles[userType] || null;
};
