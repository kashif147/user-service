/**
 * Application Approval Listener
 *
 * When an application is approved in the profile service, this listener updates
 * the user's role in User Service from Non-Member to Member.
 *
 * Flow:
 * - CRM user creates application for someone, or portal user creates their own application
 * - User logs in with portal → gets NON-MEMBER role (limited access)
 * - When application is approved → profile is created/updated in profile service
 * - This listener receives the approval event and upgrades the user's role to MEMBER
 */

const User = require("../../models/user.model");
const Role = require("../../models/role.model");

const APPLICATION_REVIEW_APPROVED = "applications.review.approved.v1";

/**
 * Normalize email for lookup (lowercase, trim)
 */
function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract primary email from effective contactInfo
 * Prefer personalEmail, fallback to workEmail
 */
function getEmailFromEffective(effective) {
  const contactInfo = effective?.contactInfo || {};
  return (
    contactInfo.personalEmail ||
    contactInfo.workEmail ||
    contactInfo.email ||
    null
  );
}

/**
 * Handle application approved event - upgrade user role from Non-Member to Member
 *
 * @param {Object} payload - Event payload (may be wrapped in payload.data by middleware)
 */
async function handleApplicationApproved(payload) {
  try {
    const data = payload.data || payload;
    const { effective, tenantId, applicationId } = data;

    if (!tenantId) {
      console.warn(
        "[APPLICATION_APPROVAL_LISTENER] Missing tenantId in payload, skipping role update"
      );
      return;
    }

    const email = getEmailFromEffective(effective);
    if (!email) {
      console.warn(
        "[APPLICATION_APPROVAL_LISTENER] No email in effective.contactInfo, skipping role update:",
        { applicationId, tenantId }
      );
      return;
    }

    const normalizedEmail = normalizeEmail(email);

    // Find the portal user by email (case-insensitive) and tenant
    const user = await User.findOne({
      userEmail: { $regex: new RegExp(`^${escapeRegex(normalizedEmail)}$`, "i") },
      tenantId,
      userType: "PORTAL",
      isActive: true,
    });

    if (!user) {
      console.log(
        "[APPLICATION_APPROVAL_LISTENER] No portal user found for approved application:",
        { email: normalizedEmail, tenantId, applicationId }
      );
      return;
    }

    // Look up NON-MEMBER and MEMBER roles for this tenant
    const [nonMemberRole, memberRole] = await Promise.all([
      Role.findOne({ tenantId, code: "NON-MEMBER", isActive: true }),
      Role.findOne({ tenantId, code: "MEMBER", isActive: true }),
    ]);

    if (!memberRole) {
      console.warn(
        "[APPLICATION_APPROVAL_LISTENER] MEMBER role not found for tenant:",
        tenantId
      );
      return;
    }

    if (!nonMemberRole) {
      console.warn(
        "[APPLICATION_APPROVAL_LISTENER] NON-MEMBER role not found for tenant:",
        tenantId
      );
      return;
    }

    // Check if user has NON-MEMBER role (ObjectId comparison)
    const hasNonMember = user.roles?.some((roleId) =>
      roleId.equals(nonMemberRole._id)
    );

    if (!hasNonMember) {
      console.log(
        "[APPLICATION_APPROVAL_LISTENER] User does not have NON-MEMBER role, skipping:",
        { userId: user._id.toString(), email: normalizedEmail }
      );
      return;
    }

    // Replace NON-MEMBER with MEMBER: $pull removes Non-Member, $addToSet adds Member
    const result = await User.updateOne(
      { _id: user._id, roles: nonMemberRole._id },
      {
        $pull: { roles: nonMemberRole._id },
        $addToSet: { roles: memberRole._id },
        $set: { updatedAt: new Date() },
      }
    );

    if (result.modifiedCount === 0) {
      console.warn(
        "[APPLICATION_APPROVAL_LISTENER] No user document modified (roles may have changed):",
        { userId: user._id.toString() }
      );
      return;
    }

    console.log(
      "✅ [APPLICATION_APPROVAL_LISTENER] Upgraded user role from Non-Member to Member:",
      {
        userId: user._id.toString(),
        email: normalizedEmail,
        tenantId,
        applicationId,
      }
    );
  } catch (error) {
    console.error(
      "❌ [APPLICATION_APPROVAL_LISTENER] Error upgrading user role on application approval:",
      {
        error: error.message,
        stack: error.stack,
        applicationId: (payload?.data || payload)?.applicationId,
      }
    );
    throw error;
  }
}

module.exports = {
  APPLICATION_REVIEW_APPROVED,
  handleApplicationApproved,
};
