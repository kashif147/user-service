/**
 * Authentication-connection provisioning rules (Phase 2a).
 *
 *  - autoProvisionUsers: only an explicit `true` lets a connection create users on first sign-in.
 *    false or unset = pre-authorised users only. Existing users sign in regardless of the flag.
 *  - defaultRoleId: the role a just-in-time (JIT) user receives. It must be a role of the same
 *    organisation, active, not a protected role (SU/ASU, isSystemRole, category SYSTEM) and without
 *    reserved permissions, and fit the provider:
 *      - Entra (CRM): a CRM-category role (configurable);
 *      - Azure B2C (portal): exactly that organisation's NON-MEMBER role. Role categories are not
 *        reliable enough to decide this (staff roles carry category PORTAL in existing data), and
 *        portalRoleSync upgrades NON-MEMBER -> MEMBER once membership is confirmed, so MEMBER or
 *        any staff role is never a JIT default.
 *    An automatic connection cannot be saved without one.
 *  - Phase 2a migration fallback: an automatic connection saved before defaultRoleId existed has
 *    none; JIT then still uses the legacy role (CRM -> REO, PORTAL -> NON-MEMBER) and logs an
 *    id-only LEGACY_DEFAULT_ROLE warning. Phase 2b removes the fallback. A defaultRoleId that is
 *    set but no longer valid always refuses JIT: a user is never created without a role.
 *  - Access: an existing user may sign in only with at least one active role of the organisation.
 */
const mongoose = require("mongoose");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");
const { isProtectedRole, isReservedPermission } = require("../handlers/role.handler");

const ENTRA = "Entra ID (Azure AD)";
const B2C = "Azure B2C";
const ROLE_CATEGORY_BY_CONNECTION = { [ENTRA]: "CRM", [B2C]: "PORTAL" };
const LEGACY_DEFAULT_ROLE_CODE = { CRM: "REO", PORTAL: "NON-MEMBER" };
// The only role a B2C (portal) connection may provision with.
const PORTAL_DEFAULT_ROLE_CODE = "NON-MEMBER";
const roleCode = (role) => String(role?.code == null ? "" : role.code).trim().toUpperCase();
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// Writable fields of a connection; anything else in a request body is ignored.
const CONNECTION_FIELDS = [
  "connectionType",
  "issuerUrl",
  "directoryId",
  "audience",
  "isActive",
  "autoProvisionUsers",
  "defaultRoleId",
];

class ConnectionValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConnectionValidationError";
    this.status = 400;
    this.code = "INVALID_AUTH_CONNECTION";
  }
}

class DefaultRoleError extends Error {
  constructor(reason) {
    super(`Default role not usable (${reason})`);
    this.name = "DefaultRoleError";
    this.code = "DEFAULT_ROLE_INVALID";
    this.reason = reason;
  }
}

const isAutomatic = (connection) => connection?.autoProvisionUsers === true;

const toCanonical = (perm) => {
  const p = String(perm || "").trim();
  if (p === "*") return "*";
  return p.includes(":") ? p.toLowerCase() : p.toLowerCase().replace(/_/g, ":");
};

// Canonical permissions of a role; ObjectId entries are resolved, an unresolvable one stays
// "unresolved" (callers treat it as not verifiable).
async function canonicalRolePermissions(role) {
  const entries = (role.permissions || []).map((e) => String(e).trim());
  const ids = entries.filter((e) => OBJECT_ID_RE.test(e));
  const byId = new Map();
  if (ids.length) {
    const docs = await Permission.find({ _id: { $in: ids } }).select("code resource action").lean();
    for (const d of docs) {
      byId.set(String(d._id), d.resource && d.action ? `${d.resource}:${d.action}`.toLowerCase() : toCanonical(d.code));
    }
  }
  return entries.map((e) => (OBJECT_ID_RE.test(e) ? byId.get(e) || null : toCanonical(e)));
}

/** Why `role` cannot be the default role of a connection of `connectionType` (null = eligible). */
async function defaultRoleIneligibility(role, connectionType) {
  if (!role) return "NOT_FOUND";
  if (role.isActive !== true) return "INACTIVE";
  if (isProtectedRole(role) || String(role.category || "").toUpperCase() === "SYSTEM") return "PROTECTED";
  const category = ROLE_CATEGORY_BY_CONNECTION[connectionType];
  if (!category || role.category !== category) return "WRONG_TYPE";
  if (connectionType === B2C && roleCode(role) !== PORTAL_DEFAULT_ROLE_CODE) return "NOT_PORTAL_DEFAULT";
  const perms = await canonicalRolePermissions(role);
  if (perms.some((p) => p === null)) return "UNVERIFIABLE_PERMISSION";
  if (perms.some(isReservedPermission)) return "RESERVED_PERMISSION";
  return null;
}

/** The role, loaded only inside `tenantId`, or a reason it cannot be used. */
async function checkDefaultRole({ tenantId, connectionType, roleId }) {
  const id = roleId == null ? "" : String(roleId);
  if (!OBJECT_ID_RE.test(id)) return { role: null, reason: "INVALID_ID" };
  const role = await Role.findOne({ _id: id, tenantId: String(tenantId) }).lean();
  const reason = await defaultRoleIneligibility(role, connectionType);
  return reason ? { role: null, reason } : { role, reason: null };
}

/** Active, eligible default roles of an organisation for a connection type (role picker). */
async function eligibleDefaultRoles(tenantId, connectionType) {
  if (!ROLE_CATEGORY_BY_CONNECTION[connectionType]) {
    throw new ConnectionValidationError("Unknown connection type");
  }
  const roles = await Role.find({
    tenantId: String(tenantId),
    category: ROLE_CATEGORY_BY_CONNECTION[connectionType],
    isActive: true,
    ...(connectionType === B2C ? { code: PORTAL_DEFAULT_ROLE_CODE } : {}),
  })
    .sort({ name: 1 })
    .lean();
  const eligible = [];
  for (const role of roles) {
    if (!(await defaultRoleIneligibility(role, connectionType))) {
      eligible.push({ _id: String(role._id), code: role.code, name: role.name, category: role.category });
    }
  }
  return eligible;
}

const DEFAULT_ROLE_MESSAGES = {
  INVALID_ID: "Default role is not a valid role id",
  NOT_FOUND: "Default role was not found in this organisation",
  INACTIVE: "Default role is inactive",
  PROTECTED: "Privileged or system roles cannot be a default role",
  WRONG_TYPE: "Default role does not match the connection's user type",
  NOT_PORTAL_DEFAULT: "Portal (Azure B2C) connections must use this organisation's NON-MEMBER role as the default role",
  UNVERIFIABLE_PERMISSION: "Default role has permissions that cannot be verified",
  RESERVED_PERMISSION: "Default role includes reserved system permissions",
};

/**
 * Save-time rules for one connection (the merged, to-be-stored values) of organisation `tenantId`.
 * Throws ConnectionValidationError (-> 400).
 */
async function assertConnectionWritable(tenantId, connection) {
  const { autoProvisionUsers, defaultRoleId } = connection;
  if (autoProvisionUsers !== undefined && typeof autoProvisionUsers !== "boolean") {
    throw new ConnectionValidationError("autoProvisionUsers must be true or false");
  }
  const hasRole = defaultRoleId !== undefined && defaultRoleId !== null && defaultRoleId !== "";
  if (autoProvisionUsers === true && !hasRole) {
    throw new ConnectionValidationError("Automatic user provisioning requires a default role");
  }
  if (hasRole) {
    const { reason } = await checkDefaultRole({
      tenantId,
      connectionType: connection.connectionType,
      roleId: defaultRoleId,
    });
    if (reason) throw new ConnectionValidationError(DEFAULT_ROLE_MESSAGES[reason]);
  }
}

const pickConnectionFields = (input) => {
  const out = {};
  for (const f of CONNECTION_FIELDS) {
    if (input && Object.prototype.hasOwnProperty.call(input, f)) out[f] = input[f];
  }
  if (out.defaultRoleId === "") out.defaultRoleId = null;
  return out;
};

const plain = (v) => (v?.toObject ? v.toObject() : v);
const sameValue = (a, b) => String(a ?? "") === String(b ?? "");

/**
 * Full authenticationConnections array from a tenant create/update body -> the array to store.
 * Only writable fields are kept; a connection is matched to a stored one by _id (anything else is
 * new). New or changed connections must pass assertConnectionWritable; unchanged stored ones are
 * kept as they are. Throws ConnectionValidationError.
 */
async function prepareConnectionsForWrite(tenantId, incoming, stored = []) {
  if (!Array.isArray(incoming)) {
    throw new ConnectionValidationError("authenticationConnections must be an array");
  }
  const storedById = new Map((stored || []).map((c) => [String(c._id), plain(c)]));
  const now = new Date();
  const result = [];
  for (const item of incoming) {
    const fields = pickConnectionFields(item);
    const previous = item && item._id != null ? storedById.get(String(item._id)) : undefined;
    if (!previous) {
      await assertConnectionWritable(tenantId, fields);
      result.push({ ...fields, createdAt: now, updatedAt: now });
      continue;
    }
    const merged = { ...pickConnectionFields(previous), ...fields };
    const changed = CONNECTION_FIELDS.some((f) => !sameValue(merged[f], previous[f]));
    if (changed) await assertConnectionWritable(tenantId, merged);
    result.push({
      ...merged,
      _id: previous._id,
      createdAt: previous.createdAt,
      updatedAt: changed ? now : previous.updatedAt,
    });
  }
  return result;
}

/**
 * Role for a user about to be created just-in-time through `connection` (already known to be
 * automatic). Returns the role id; throws DefaultRoleError when the configured role is unusable
 * or, during the 2a migration, the legacy role is missing.
 */
async function resolveJitDefaultRoleId({ tenantId, connection, userType }) {
  const ids = { tenantId: String(tenantId), connectionId: connection?._id ? String(connection._id) : null };
  if (connection?.defaultRoleId) {
    const { role, reason } = await checkDefaultRole({
      tenantId,
      connectionType: connection.connectionType,
      roleId: connection.defaultRoleId,
    });
    if (!role) {
      console.warn("JIT refused: default role not usable", { ...ids, reason });
      throw new DefaultRoleError(reason);
    }
    return role._id;
  }
  // Phase 2a migration only: connections that were automatic before defaultRoleId existed.
  const code = LEGACY_DEFAULT_ROLE_CODE[userType];
  const legacy = code
    ? await Role.findOne({ code, tenantId: String(tenantId), isActive: true }).select("_id").lean()
    : null;
  if (!legacy) {
    console.warn("JIT refused: no default role configured and legacy role missing", { ...ids, userType });
    throw new DefaultRoleError("LEGACY_ROLE_MISSING");
  }
  console.warn("LEGACY_DEFAULT_ROLE", { ...ids, userType, roleId: String(legacy._id) });
  return legacy._id;
}

/** True when the user holds at least one active role of organisation `tenantId`. */
async function hasActiveRoleInTenant(user, tenantId) {
  const ids = (user?.roles || []).map((r) => String(r?._id ?? r)).filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (ids.length === 0) return false;
  const n = await Role.countDocuments({ _id: { $in: ids }, tenantId: String(tenantId), isActive: true });
  return n > 0;
}

module.exports = {
  ENTRA,
  B2C,
  CONNECTION_FIELDS,
  ConnectionValidationError,
  DefaultRoleError,
  isAutomatic,
  checkDefaultRole,
  eligibleDefaultRoles,
  assertConnectionWritable,
  pickConnectionFields,
  prepareConnectionsForWrite,
  resolveJitDefaultRoleId,
  hasActiveRoleInTenant,
};
