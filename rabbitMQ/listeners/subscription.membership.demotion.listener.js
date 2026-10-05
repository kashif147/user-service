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

/**
 * Phase 1C-2E (M2): classify the event's tenant context.
 *  - field absent (undefined/null)        -> "absent"  (legacy no-tenant event; publisher may omit it
 *                                            because Subscription.tenantId is optional)
 *  - non-empty after string normalisation -> "present" (tenant-scoped lookups ONLY)
 *  - present but empty/whitespace         -> "malformed" (fail closed; never treated as "absent")
 */
function resolveEventTenant(tenantId) {
  if (tenantId === undefined || tenantId === null) return { kind: "absent", tid: null };
  const tid = String(tenantId).trim();
  return tid ? { kind: "present", tid } : { kind: "malformed", tid: null };
}

async function findPortalUser({ userId, userEmail, tenant }) {
  const oid =
    userId && mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(userId)
      : null;

  if (tenant.kind === "present") {
    // Tenant-scoped only. A miss is a miss: never retry with { _id } alone (M2).
    if (oid) {
      const byIdAndTenant = await User.findOne({
        _id: oid,
        tenantId: tenant.tid,
        userType: "PORTAL",
        isActive: true,
      });
      if (byIdAndTenant) return byIdAndTenant;
    }

    const normalizedEmail = normalizeEmail(userEmail);
    if (!normalizedEmail) return null;

    return User.findOne({
      userEmail: { $regex: new RegExp(`^${escapeRegex(normalizedEmail)}$`, "i") },
      tenantId: tenant.tid,
      userType: "PORTAL",
      isActive: true,
    });
  }

  if (tenant.kind === "absent" && oid) {
    // Explicit legacy branch: the event carries NO tenant field at all, so the user's own
    // tenant is authoritative (no tenant is guessed or inferred).
    return User.findOne({ _id: oid, userType: "PORTAL", isActive: true });
  }

  return null; // malformed tenant, or legacy event without a usable userId
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

    const tenant = resolveEventTenant(tenantId);
    if (tenant.kind === "malformed") {
      console.warn(
        "[MEMBERSHIP_DEMOTION_LISTENER] Malformed (empty) tenantId in event, skipping",
        { profileId, subscriptionId }
      );
      return;
    }
    const roleTenantId = tenant.tid;

    const user = await findPortalUser({
      userId,
      userEmail,
      tenant,
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
  resolveEventTenant,
  SUBSCRIPTION_RESIGNED,
  SUBSCRIPTION_CANCEL_GRACE_ENDED,
  handlePortalMemberDemotion,
};
