/**
 * P5 narrow CRM user directory (directory:read): id -> display name, and a bounded name-prefix
 * picker list. Deliberately minimal data, deliberately separate from RoleHandler's user reads:
 *   - projection is an allow-list (DIRECTORY_SELECT) and every response item is built explicitly
 *     as { id, displayName } - never the stored document - so identity bindings (Microsoft oid,
 *     B2C subject, issuer, audience, token version, policy, auth/issue times), email, mobile,
 *     member number, roles, permissions, tenant and activity metadata can never be returned;
 *   - every query is bound to the caller's verified tenant (the caller passes it from
 *     req.verifiedCaller, never from forwarded headers);
 *   - only the tenant User collection is read; platform principals live in their own collection
 *     and are never queried here;
 *   - the name search never matches email (no email-prefix oracle), is anchored and regex-escaped.
 */
const mongoose = require("mongoose");
const User = require("../models/user.model");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");

const DIRECTORY_SELECT = "_id userFirstName userLastName userFullName";
const DIRECTORY_LOOKUP_MAX_IDS = 500;
const DIRECTORY_LIST_DEFAULT_LIMIT = 20;
const DIRECTORY_LIST_MAX_LIMIT = 50;
const DIRECTORY_QUERY_MAX_LENGTH = 64;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const PERMISSION_FORMAT = /^[a-z0-9_.-]+:[a-z0-9_.-]+$/;
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

const escapeRegex = (s) => s.replace(REGEX_SPECIALS, "\\$&");

function toDirectoryEntry(user) {
  const full = typeof user.userFullName === "string" ? user.userFullName.trim() : "";
  const composed = [user.userFirstName, user.userLastName]
    .filter((p) => typeof p === "string" && p.trim())
    .map((p) => p.trim())
    .join(" ")
    .trim();
  return { id: String(user._id), displayName: full || composed || null };
}

function normaliseIds(ids) {
  return [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .filter((id) => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => OBJECT_ID.test(id) && mongoose.Types.ObjectId.isValid(id)),
    ),
  ];
}

/** POST /api/directory/users/lookup - ids of the caller's own tenant only; others are ignored. */
async function lookupDisplayNames(ids, tenantId) {
  const valid = normaliseIds(ids);
  if (!tenantId || valid.length === 0) return [];
  const users = await User.find({ _id: { $in: valid }, tenantId }).select(DIRECTORY_SELECT).lean();
  return users.map(toDirectoryEntry);
}

/** Clamp the list limit: non-numeric / < 1 -> default, > max -> max. */
function clampLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DIRECTORY_LIST_DEFAULT_LIMIT;
  return Math.min(n, DIRECTORY_LIST_MAX_LIMIT);
}

/** Case-insensitive, anchored, regex-escaped prefix on the name fields only (never email). */
function buildNamePrefixFilter(q) {
  const escaped = `^${escapeRegex(q)}`;
  return [
    { userFirstName: { $regex: escaped, $options: "i" } },
    { userLastName: { $regex: escaped, $options: "i" } },
    { userFullName: { $regex: escaped, $options: "i" } },
  ];
}

/**
 * Tenant role ids granting exactly resource:action - the same mixed ObjectId/code
 * role.permissions resolution RoleHandler.getUsersByPermission uses.
 */
async function resolveTenantRoleIdsForPermission(resource, action, tenantId) {
  const permission = await Permission.findOne({ resource, action }).lean();
  if (!permission) return [];
  const roles = await Role.find({
    tenantId,
    isActive: true,
    $or: [{ permissions: String(permission._id) }, { permissions: permission.code }],
  })
    .select("_id")
    .lean();
  return roles.map((role) => role._id);
}

/**
 * GET /api/directory/users - active CRM users of the caller's tenant, optionally filtered by name
 * prefix and by a tenant permission. Inputs are pre-validated by the controller.
 */
async function listDirectoryUsers({ tenantId, q, permission, limit }) {
  if (!tenantId) return [];
  const query = { tenantId, isActive: true, userType: "CRM" };
  if (permission) {
    const roleIds = await resolveTenantRoleIdsForPermission(permission.resource, permission.action, tenantId);
    if (roleIds.length === 0) return [];
    query.roles = { $in: roleIds };
  }
  if (q) query.$or = buildNamePrefixFilter(q);
  const users = await User.find(query)
    .select(DIRECTORY_SELECT)
    .sort({ userFullName: 1, _id: 1 })
    .limit(clampLimit(limit))
    .lean();
  return users.map(toDirectoryEntry);
}

module.exports = {
  DIRECTORY_SELECT,
  DIRECTORY_LOOKUP_MAX_IDS,
  DIRECTORY_LIST_DEFAULT_LIMIT,
  DIRECTORY_LIST_MAX_LIMIT,
  DIRECTORY_QUERY_MAX_LENGTH,
  PERMISSION_FORMAT,
  clampLimit,
  lookupDisplayNames,
  listDirectoryUsers,
};
