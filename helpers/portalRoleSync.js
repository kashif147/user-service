const Role = require("../models/role.model");
const { assignDefaultRole, assignMemberRole } = require("./roleAssignment");
const { hasActiveMembership } = require("../services/membershipCheck.service");

/**
 * For PORTAL users: if they need a role or only have NON-MEMBER, check profile-service +
 * subscription-service; assign MEMBER when active membership exists, otherwise NON-MEMBER
 * when they still need an initial role.
 *
 * @param {object} user - User document (mutated on assignment)
 * @param {string} email
 * @param {string} tenantId
 * @param {{ isNewUser?: boolean }} [options]
 * @returns {Promise<{ assignedMemberFromCheck: boolean }>}
 */
async function syncPortalUserRolesFromMembership(user, email, tenantId, options = {}) {
  const { isNewUser = false } = options;
  const needsRoleAssignment =
    isNewUser || !user.roles || user.roles.length === 0;

  const nonMemberRole = await Role.findOne({
    tenantId,
    code: "NON-MEMBER",
    isActive: true,
  });
  const hasOnlyNonMember =
    nonMemberRole &&
    user.roles?.length === 1 &&
    user.roles[0].equals(nonMemberRole._id);

  const shouldCheckMembership = needsRoleAssignment || hasOnlyNonMember;
  let assignedMemberFromCheck = false;

  if (shouldCheckMembership) {
    const hasMembership = await hasActiveMembership(email, tenantId);
    if (hasMembership) {
      assignedMemberFromCheck = await assignMemberRole(user, tenantId);
      if (assignedMemberFromCheck) await user.save();
    }
  }

  if (needsRoleAssignment && !assignedMemberFromCheck) {
    await assignDefaultRole(user, "PORTAL", tenantId);
    await user.save();
  }

  return { assignedMemberFromCheck };
}

module.exports = { syncPortalUserRolesFromMembership };
