const Role = require("../models/role.model");
const User = require("../models/user.model");

/**
 * Internal role/user lookups for services that need to resolve "who currently holds role
 * X" without a full gateway-authenticated user context - e.g. communication-service
 * resolving the Assistant Director of IR / Head of Information / Head of Industrial
 * Relations for the Issue Management email triggers (RabbitMQ-consumer-driven, no inbound
 * req to forward headers from, so there's no user session to present).
 *
 * Gated by a shared secret (requireInternalSecret below), not just an x-internal-request
 * header flag - mirrors audit-service's POST /internal/audit-logs
 * (controllers/internalAudit.controller.js's exact fail-closed shape: unset secret or
 * mismatched header both 403). Chosen over the weaker header-only pattern
 * controllers/tenantLifecycle.controller.js's requireInternal uses, since this endpoint
 * returns user PII (emails, names) rather than tenant config.
 *
 * Deliberately does NOT filter by Role.category ("PORTAL"|"CRM"|"SYSTEM"): that field is
 * unreliable for this tenant's real CRM roles today (see
 * scripts/grant-issues-permissions-to-roles.js's header comment - IRO/IRE/DIR/ADIR/IO etc.
 * are all mislabeled category:"PORTAL" in the DB, with the correct classification only in a
 * separate roleCategory field nothing here enforces). Matching on `code` alone sidesteps
 * that pre-existing data-quality issue rather than reproducing it, since role codes are
 * already the precise identifier callers of this endpoint match on.
 */
function requireInternalSecret(req, res, next) {
  const secret = process.env.INTERNAL_ROLE_ACCESS_SECRET;
  if (!secret || req.headers["x-service-secret"] !== secret) {
    return res.status(403).json({ status: "fail", message: "Forbidden" });
  }
  return next();
}

async function getUsersByRoleCodes(req, res) {
  try {
    const tenantId = req.query.tenantId;
    if (!tenantId) {
      return res.status(400).json({ status: "fail", message: "tenantId is required" });
    }

    const codes = String(req.query.codes || "")
      .split(",")
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean);
    if (!codes.length) {
      return res.status(400).json({ status: "fail", message: "codes is required" });
    }

    const roles = await Role.find({ tenantId, code: { $in: codes }, isActive: true })
      .select("_id code name")
      .lean();
    const roleIds = roles.map((role) => role._id);
    const users = roleIds.length
      ? await User.find({
          tenantId,
          userType: "CRM",
          isActive: true,
          roles: { $in: roleIds },
        })
          .select("_id userEmail userFullName userFirstName userLastName roles")
          .lean()
      : [];

    return res.status(200).json({ status: "success", data: { roles, users } });
  } catch (error) {
    console.error("[internalRoleAccess] getUsersByRoleCodes", error);
    return res.status(500).json({ status: "fail", message: "Failed to resolve users by role codes" });
  }
}

async function getUserById(req, res) {
  try {
    const tenantId = req.query.tenantId;
    const { userId } = req.params;
    if (!tenantId) {
      return res.status(400).json({ status: "fail", message: "tenantId is required" });
    }

    const user = await User.findOne({ _id: userId, tenantId, isActive: true })
      .select("_id userEmail userFullName userFirstName userLastName")
      .lean();

    return res.status(200).json({ status: "success", data: user || null });
  } catch (error) {
    console.error("[internalRoleAccess] getUserById", error);
    return res.status(500).json({ status: "fail", message: "Failed to resolve user" });
  }
}

module.exports = { requireInternalSecret, getUsersByRoleCodes, getUserById };
