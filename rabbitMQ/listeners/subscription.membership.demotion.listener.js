/**
 * Downgrades portal users from MEMBER → NON-MEMBER when:
 * - Subscription is resigned (members.subscription.resigned.v1)
 * - Cancellation grace period has ended (members.subscription.cancel.grace.ended.v1)
 */

const mongoose = require("mongoose");
const User = require("../../models/user.model");
const { assignNonMemberRole } = require("../../helpers/roleAssignment");

const SUBSCRIPTION_RESIGNED = "members.subscription.resigned.v1";
const SUBSCRIPTION_CANCEL_GRACE_ENDED =
  "members.subscription.cancel.grace.ended.v1";

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findPortalUser({ userId, userEmail, tenantId }) {
  const tid = tenantId != null ? String(tenantId) : null;

  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    const oid = new mongoose.Types.ObjectId(userId);
    if (tid) {
      const byIdAndTenant = await User.findOne({
        _id: oid,
        tenantId: tid,
        userType: "PORTAL",
        isActive: true,
      });
      if (byIdAndTenant) return byIdAndTenant;
    }
    const byId = await User.findOne({
      _id: oid,
      userType: "PORTAL",
      isActive: true,
    });
    if (byId) return byId;
  }

  if (!tid) return null;

  const normalizedEmail = normalizeEmail(userEmail);
  if (!normalizedEmail) return null;

  return User.findOne({
    userEmail: { $regex: new RegExp(`^${escapeRegex(normalizedEmail)}$`, "i") },
    tenantId: tid,
    userType: "PORTAL",
    isActive: true,
  });
}

async function handlePortalMemberDemotion(payload, context) {
  const data = payload?.data || payload;
  const routingKey = context?.routingKey || "";

  const {
    profileId,
    userId,
    userEmail,
    tenantId,
    reason,
    subscriptionId,
  } = data || {};

  try {
    console.log("📥 [MEMBERSHIP_DEMOTION_LISTENER] Event received:", {
      routingKey,
      profileId,
      subscriptionId,
      reason,
      tenantId,
    });

    const roleTenantId =
      tenantId != null && String(tenantId).trim()
        ? String(tenantId)
        : null;

    const user = await findPortalUser({
      userId,
      userEmail,
      tenantId: roleTenantId,
    });

    if (!user) {
      console.log(
        "[MEMBERSHIP_DEMOTION_LISTENER] No portal user found for demotion:",
        {
          userId,
          userEmail: userEmail || "(none)",
          tenantId: roleTenantId || "(none)",
          profileId,
        }
      );
      return;
    }

    const tenantForRole =
      user.tenantId != null && String(user.tenantId).trim()
        ? String(user.tenantId)
        : roleTenantId;
    if (!tenantForRole) {
      console.warn(
        "[MEMBERSHIP_DEMOTION_LISTENER] Cannot resolve tenant for role assignment, skipping"
      );
      return;
    }

    const ok = await assignNonMemberRole(user, tenantForRole);
    if (!ok) {
      console.warn(
        "[MEMBERSHIP_DEMOTION_LISTENER] assignNonMemberRole failed:",
        user._id.toString()
      );
      return;
    }

    user.updatedAt = new Date();
    await user.save();

    console.log("✅ [MEMBERSHIP_DEMOTION_LISTENER] Portal user demoted to NON-MEMBER", {
      userId: user._id.toString(),
      userEmail: user.userEmail,
      tenantId: tenantForRole,
      profileId,
      reason: reason || routingKey,
    });
  } catch (error) {
    console.error("❌ [MEMBERSHIP_DEMOTION_LISTENER] Error:", {
      message: error.message,
      stack: error.stack,
      profileId: data?.profileId,
    });
  }
}

module.exports = {
  SUBSCRIPTION_RESIGNED,
  SUBSCRIPTION_CANCEL_GRACE_ENDED,
  handlePortalMemberDemotion,
};
