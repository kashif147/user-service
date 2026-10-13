const Role = require("../models/role.model");
const { assignMemberRole } = require("./roleAssignment");
const { hasActiveMembership } = require("../services/membershipCheck.service");

/**
 * For PORTAL users at sign-in: a new user (already given the connection's default role when it
 * was created), or an existing user whose only role is NON-MEMBER, is checked against
 * profile-service + subscription-service and upgraded to MEMBER when an active membership exists.
 *
 * It never assigns a role to a user without one: zero active roles is an intentional state that
 * sign-in refuses before calling this (handlers/b2c.users.handler.js).
 *
 * @param {object} user - User document (mutated on assignment)
 * @param {string} email
 * @param {string} tenantId
 * @param {{ isNewUser?: boolean }} [options]
 * @returns {Promise<{ assignedMemberFromCheck: boolean }>}
 */
async function syncPortalUserRolesFromMembership(user, email, tenantId, options = {}) {
  const { isNewUser = false } = options;

  const nonMemberRole = await Role.findOne({
    tenantId,
    code: "NON-MEMBER",
    isActive: true,
  });
  const hasOnlyNonMember =
    nonMemberRole &&
    user.roles?.length === 1 &&
    user.roles[0].equals(nonMemberRole._id);

  const shouldCheckMembership = isNewUser || hasOnlyNonMember;
  let assignedMemberFromCheck = false;

  if (shouldCheckMembership) {
    const hasMembership = await hasActiveMembership(email, tenantId);
    if (hasMembership) {
      assignedMemberFromCheck = await assignMemberRole(user, tenantId);
      if (assignedMemberFromCheck) await user.save();
    }
  }

  return { assignedMemberFromCheck };
}

module.exports = { syncPortalUserRolesFromMembership };
