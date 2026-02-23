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
 *
 * Lookup: userId from payload (preferred) → fallback to email
 * Role handling: Add Member for approved membership regardless of current role;
 * remove NON-MEMBER when present.
 */

const mongoose = require("mongoose");
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
 * Find portal user: try userId first (from payload), then email lookup
 */
async function findPortalUser({ userId, email, tenantId }) {
  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    const byId = await User.findOne({
      _id: new mongoose.Types.ObjectId(userId),
      tenantId,
      userType: "PORTAL",
      isActive: true,
    });
    if (byId) return byId;
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  return User.findOne({
    userEmail: { $regex: new RegExp(`^${escapeRegex(normalizedEmail)}$`, "i") },
    tenantId,
    userType: "PORTAL",
    isActive: true,
  });
}

/**
 * Handle application approved event - upgrade user role to Member
 *
 * Lookup: userId (preferred) or email from effective.contactInfo
 * Role: Add Member, remove NON-MEMBER when present (relaxed - no requirement to have NON-MEMBER)
 *
 * @param {Object} payload - Event payload (may be wrapped in payload.data by middleware)
 */
async function handleApplicationApproved(payload) {
  try {
    const data = payload.data || payload;
    const { effective, tenantId, applicationId, userId: payloadUserId } = data;

    if (!tenantId) {
      console.warn(
        "[APPLICATION_APPROVAL_LISTENER] Missing tenantId in payload, skipping role update"
      );
      return;
    }

    const email = getEmailFromEffective(effective);
    if (!email && !payloadUserId) {
      console.warn(
        "[APPLICATION_APPROVAL_LISTENER] No userId or email in payload, skipping role update:",
        { applicationId, tenantId }
      );
      return;
    }

    const user = await findPortalUser({
      userId: payloadUserId,
      email,
      tenantId,
    });

    if (!user) {
      console.log(
        "[APPLICATION_APPROVAL_LISTENER] No portal user found for approved application:",
        { userId: payloadUserId, email: email || "(none)", tenantId, applicationId }
      );
      return;
    }

    const memberRole = await Role.findOne({ tenantId, code: "MEMBER", isActive: true });
    if (!memberRole) {
      console.warn(
        "[APPLICATION_APPROVAL_LISTENER] MEMBER role not found for tenant:",
        tenantId
      );
      return;
    }

    const nonMemberRole = await Role.findOne({ tenantId, code: "NON-MEMBER", isActive: true });
    const hasNonMember = nonMemberRole && user.roles?.some((r) => r.equals(nonMemberRole._id));

    const update = {
      $addToSet: { roles: memberRole._id },
      $set: { updatedAt: new Date() },
    };
    if (hasNonMember) {
      update.$pull = { roles: nonMemberRole._id };
    }

    const result = await User.updateOne(
      { _id: user._id },
      update
    );

    if (result.modifiedCount === 0 && result.matchedCount > 0) {
      const alreadyHasMember = user.roles?.some((r) => r.equals(memberRole._id));
      if (alreadyHasMember) {
        console.log(
          "[APPLICATION_APPROVAL_LISTENER] User already has MEMBER role:",
          { userId: user._id.toString(), tenantId, applicationId }
        );
      }
      return;
    }

    console.log(
      "✅ [APPLICATION_APPROVAL_LISTENER] Assigned Member role:",
      {
        userId: user._id.toString(),
        email: user.userEmail,
        tenantId,
        applicationId,
        removedNonMember: hasNonMember,
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
