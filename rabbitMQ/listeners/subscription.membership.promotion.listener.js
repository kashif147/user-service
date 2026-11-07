/**
 * Upgrades portal users from NON-MEMBER → MEMBER when:
 * - Application is processed (applications.review.processed.v1) — handled in application.approval.listener
 * - A new active subscription is set current (members.subscription.current.updated.v1)
 * - Subscription resignation is undone (members.subscription.resignation.undone.v1)
 * - Subscription cancellation is undone (members.subscription.cancellation.undone.v1)
 */

const mongoose = require("mongoose");
const User = require("../../models/user.model");
const { assignMemberRole } = require("../../helpers/roleAssignment");
const { classifyApplicant } = require("./application.approval.listener");

const SUBSCRIPTION_CURRENT_UPDATED =
  "members.subscription.current.updated.v1";
const SUBSCRIPTION_RESIGNATION_UNDONE =
  "members.subscription.resignation.undone.v1";
const SUBSCRIPTION_CANCELLATION_UNDONE =
  "members.subscription.cancellation.undone.v1";

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

/**
 * P5 identity: which lookup a promotion event may use.
 *  - resignation.undone / cancellation.undone routing keys: reinstatement of an existing member
 *    -> "fallback" (existing chain: id in tenant, then email in tenant).
 *  - current.updated carrying applicantIdentity (application approval, via subscription upsert):
 *    pending -> "none" (no lookup, no grant); crm_created -> "fallback"; otherwise -> "strict".
 *  - current.updated without applicantIdentity: a non-application origin set by the
 *    subscription-service publisher (renewal / reminder / postgrad / graduation / undo / upsert
 *    with no application), or renewalBatchId (renewal publisher only, also on older events)
 *    -> "fallback". Anything else - application upserts from before the pass-through, retries,
 *    unmarked events - -> "strict": explicit userId in the event tenant only, never email.
 */
const NON_APPLICATION_ORIGINS = new Set([
  "profile_upsert",
  "renewal_batch",
  "reminder_batch",
  "postgrad_category_renewal",
  "ug_graduation_cancellation",
  "undo_resignation",
  "undo_cancellation",
]);

function classifyPromotion(data, routingKey) {
  if (
    routingKey === SUBSCRIPTION_RESIGNATION_UNDONE ||
    routingKey === SUBSCRIPTION_CANCELLATION_UNDONE
  ) {
    return "fallback";
  }
  const ai = data?.applicantIdentity;
  if (ai && typeof ai === "object") {
    if (ai.pending) return "none";
    return classifyApplicant(data) === "crm_created" ? "fallback" : "strict";
  }
  if (typeof data?.origin === "string" && NON_APPLICATION_ORIGINS.has(data.origin)) {
    return "fallback";
  }
  if (data?.renewalBatchId != null && String(data.renewalBatchId).trim() !== "") {
    return "fallback";
  }
  return "strict";
}

async function findPortalUserByIdInTenant(userId, tenant) {
  const id = userId != null ? String(userId).trim() : "";
  if (tenant.kind !== "present" || !id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return User.findOne({
    _id: new mongoose.Types.ObjectId(id),
    tenantId: tenant.tid,
    userType: "PORTAL",
    isActive: true,
  });
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

    const tenant = resolveEventTenant(tenantId);
    if (tenant.kind === "malformed") {
      console.warn(
        "[MEMBERSHIP_PROMOTION_LISTENER] Malformed (empty) tenantId in event, skipping",
        { profileId, subscriptionId }
      );
      return;
    }
    const roleTenantId = tenant.tid;

    const classification = classifyPromotion(data, routingKey);
    if (classification === "none") {
      console.log(
        "[MEMBERSHIP_PROMOTION_LISTENER] Applicant identity pending, no promotion:",
        { classification, pending: data.applicantIdentity.pending, tenantId: roleTenantId || "(none)", profileId, subscriptionId }
      );
      return;
    }

    const user =
      classification === "fallback"
        ? await findPortalUser({ userId, userEmail, tenant })
        : await findPortalUserByIdInTenant(userId, tenant);

    if (!user) {
      console.log(
        "[MEMBERSHIP_PROMOTION_LISTENER] No portal user found for promotion:",
        {
          classification,
          userId: userId || null,
          tenantId: roleTenantId || "(none)",
          profileId,
          subscriptionId,
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
      classification,
      userId: user._id.toString(),
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
  classifyPromotion,
  resolveEventTenant,
  SUBSCRIPTION_CURRENT_UPDATED,
  SUBSCRIPTION_RESIGNATION_UNDONE,
  SUBSCRIPTION_CANCELLATION_UNDONE,
  handlePortalMemberPromotion,
};
