/**
 * Application Approval Listener
 *
 * When an application is processed in the profile service, this listener updates
 * the user's role in User Service from Non-Member to Member.
 *
 * Flow:
 * - CRM user creates application for someone, or portal user creates their own application
 * - User logs in with portal → gets NON-MEMBER role (limited access)
 * - When application is processed → profile is created/updated in profile service
 * - This listener receives the processed event and upgrades the user's role to MEMBER
 */

const mongoose = require("mongoose");
const User = require("../../models/user.model");
const { assignMemberRole } = require("../../helpers/roleAssignment");

const APPLICATION_REVIEW_PROCESSED = "applications.review.processed.v1";

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
 * Find portal user: try userId first (from payload), then email lookup.
 * userId normally carries the user-service document id, but older payloads can
 * carry an identity-provider id, so keep those fallbacks tenant-scoped.
 */
async function findPortalUser({ userId, email, tenantId }) {
  const tid = tenantId != null ? String(tenantId) : null;
  const normalizedUserId =
    userId != null && String(userId).trim() ? String(userId).trim() : null;

  if (normalizedUserId && mongoose.Types.ObjectId.isValid(normalizedUserId)) {
    const oid = new mongoose.Types.ObjectId(normalizedUserId);
    if (tid) {
      const byIdAndTenant = await User.findOne({
        _id: oid,
        tenantId: tid,
        userType: "PORTAL",
        isActive: true,
      });
      if (byIdAndTenant) return byIdAndTenant;
    } else {
      const byId = await User.findOne({
        _id: oid,
        userType: "PORTAL",
        isActive: true,
      });
      if (byId) return byId;
    }
  }

  if (!tid) return null;

  if (normalizedUserId) {
    const byExternalIdentity = await User.findOne({
      tenantId: tid,
      userType: "PORTAL",
      isActive: true,
      $or: [
        { userMicrosoftId: normalizedUserId },
        { userSubject: normalizedUserId },
      ],
    });
    if (byExternalIdentity) return byExternalIdentity;
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  return User.findOne({
    userEmail: { $regex: new RegExp(`^${escapeRegex(normalizedEmail)}$`, "i") },
    tenantId: tid,
    userType: "PORTAL",
    isActive: true,
  });
}


async function handleApplicationApproved(payload) {
  try {
    const data = payload.data || payload;
    const {
      effective,
      applicationId,
      userId: payloadUserId,
      userEmail: payloadUserEmail,
    } = data;
    const tenantIdRaw = data.tenantId ?? payload.tenantId;
    const tenantId = tenantIdRaw != null ? String(tenantIdRaw) : null;

    if (!tenantId) {
      console.warn(
        "[APPLICATION_APPROVAL_LISTENER] Missing tenantId in payload, skipping role update"
      );
      return;
    }

    const email =
      payloadUserEmail ||
      (effective ? getEmailFromEffective(effective) : null);
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
        "[APPLICATION_APPROVAL_LISTENER] No portal user found for processed application:",
        { userId: payloadUserId, email: email || "(none)", tenantId, applicationId }
      );
      return;
    }

    const tenantForRole =
      user.tenantId != null && String(user.tenantId).trim()
        ? String(user.tenantId)
        : tenantId;
    if (!tenantForRole) {
      console.warn(
        "[APPLICATION_APPROVAL_LISTENER] Cannot resolve tenant for role assignment, skipping"
      );
      return;
    }

    const ok = await assignMemberRole(user, tenantForRole);
    if (!ok) {
      console.warn(
        "[APPLICATION_APPROVAL_LISTENER] assignMemberRole failed:",
        user._id.toString()
      );
      return;
    }

    user.updatedAt = new Date();
    await user.save();

    console.log(
      "✅ [APPLICATION_APPROVAL_LISTENER] Upgraded user to MEMBER",
      {
        userId: user._id.toString(),
        email: user.userEmail,
        tenantId: tenantForRole,
        applicationId,
      }
    );
  } catch (error) {
    console.error(
      "❌ [APPLICATION_APPROVAL_LISTENER] Error upgrading user role on application processing:",
      {
        error: error.message,
        stack: error.stack,
        applicationId: (payload?.data || payload)?.applicationId,
      }
    );
  }
}

module.exports = {
  APPLICATION_REVIEW_PROCESSED,
  handleApplicationApproved,
};
