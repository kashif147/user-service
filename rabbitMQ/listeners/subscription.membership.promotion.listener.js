/**
 * Upgrades portal users from NON-MEMBER → MEMBER when:
 * - Subscription resignation is undone (members.subscription.resignation.undone.v1)
 */

const mongoose = require("mongoose");
const User = require("../../models/user.model");
const { assignMemberRole } = require("../../helpers/roleAssignment");

const SUBSCRIPTION_RESIGNATION_UNDONE =
  "members.subscription.resignation.undone.v1";

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

async function handlePortalMemberPromotion(payload, context) {
  const data = payload?.data || payload;
  const routingKey = context?.routingKey || "";

  const { profileId, userId, userEmail, tenantId, subscriptionId } = data || {};

  try {
    console.log("📥 [MEMBERSHIP_PROMOTION_LISTENER] Event received:", {
      routingKey,
      profileId,
      subscriptionId,
      tenantId,
    });

    const roleTenantId =
      tenantId != null && String(tenantId).trim() ? String(tenantId) : null;

    const user = await findPortalUser({
      userId,
      userEmail,
      tenantId: roleTenantId,
    });

    if (!user) {
      console.log(
        "[MEMBERSHIP_PROMOTION_LISTENER] No portal user found for promotion:",
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
        "[MEMBERSHIP_PROMOTION_LISTENER] Cannot resolve tenant for role assignment, skipping"
      );
      return;
    }

    const ok = await assignMemberRole(user, tenantForRole);
    if (!ok) {
      console.warn(
        "[MEMBERSHIP_PROMOTION_LISTENER] assignMemberRole failed:",
        user._id.toString()
      );
      return;
    }

    user.updatedAt = new Date();
    await user.save();

    console.log("✅ [MEMBERSHIP_PROMOTION_LISTENER] Portal user promoted to MEMBER", {
      userId: user._id.toString(),
      userEmail: user.userEmail,
      tenantId: tenantForRole,
      profileId,
      reason: routingKey,
    });
  } catch (error) {
    console.error("❌ [MEMBERSHIP_PROMOTION_LISTENER] Error:", {
      message: error.message,
      stack: error.stack,
      profileId: data?.profileId,
    });
  }
}

module.exports = {
  SUBSCRIPTION_RESIGNATION_UNDONE,
  handlePortalMemberPromotion,
};
