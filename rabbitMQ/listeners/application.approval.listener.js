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


/**
 * P5 identity: how the processed event identifies the applicant (profile-service applicantIdentity).
 *  - "crm_created": source crm_created - the existing resolution (id, tenant-scoped external identity,
 *    email). Only this explicit origin keeps the email fallback.
 *  - "verified": source portal_submitter - the grant goes ONLY to the explicit userId resolved in the
 *    event's tenant. Null, unknown or other-tenant id -> no grant; never external identity or email.
 *  - "unmarked": no applicantIdentity (published before profile-service sent it, or a retry of such an
 *    event) - same strict rule as verified, so older events and retries cannot bypass it.
 * applicantIdentity.pending (IDENTITY_LINK_PENDING) -> no grant, whatever the classification.
 */
function classifyApplicant(data) {
  const ai = data?.applicantIdentity;
  if (ai && typeof ai === "object" && ai.source === "crm_created") return "crm_created";
  if (ai && typeof ai === "object" && ai.source === "portal_submitter") return "verified";
  return "unmarked";
}

/** The explicit user id in the event's tenant only (no tenantless, external-identity or email lookup). */
async function findPortalUserByIdInTenant(userId, tenantId) {
  const id = userId != null ? String(userId).trim() : "";
  if (!id || !tenantId || !mongoose.Types.ObjectId.isValid(id)) return null;
  return User.findOne({
    _id: new mongoose.Types.ObjectId(id),
    tenantId: String(tenantId),
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

    const classification = classifyApplicant(data);
    const pending = data?.applicantIdentity?.pending || null;
    if (pending) {
      console.log("[APPLICATION_APPROVAL_LISTENER] Applicant identity pending, no role update:", {
        classification,
        pending,
        tenantId,
        applicationId,
      });
      return;
    }

    let user;
    if (classification === "crm_created") {
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
      user = await findPortalUser({
        userId: payloadUserId,
        email,
        tenantId,
      });
    } else {
      user = await findPortalUserByIdInTenant(payloadUserId, tenantId);
    }

    if (!user) {
      console.log(
        "[APPLICATION_APPROVAL_LISTENER] No portal user found for processed application, no role update:",
        { classification, userId: payloadUserId || null, tenantId, applicationId }
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
        classification,
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
  classifyApplicant,
  handleApplicationApproved,
};
