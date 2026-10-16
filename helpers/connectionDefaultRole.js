/**
 * Authentication-connection provisioning rules.
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
 *  - JIT requires that explicit defaultRoleId: a missing one (NOT_CONFIGURED) or one that is no
 *    longer valid refuses JIT. There is no fallback role chosen by code or category, and a user is
 *    never created without a role.
 *  - Access: an existing user may sign in only with at least one active role of the organisation.
 */
const mongoose = require("mongoose");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");
const { isProtectedRole, isReservedPermission } = require("../handlers/role.handler");

const ENTRA = "Entra ID (Azure AD)";
const B2C = "Azure B2C";
const ROLE_CATEGORY_BY_CONNECTION = { [ENTRA]: "CRM", [B2C]: "PORTAL" };
// The only role a B2C (portal) connection may provision with.
const PORTAL_DEFAULT_ROLE_CODE = "NON-MEMBER";
const roleCode = (role) => String(role?.code == null ? "" : role.code).trim().toUpperCase();
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// Field ownership of an authentication connection.
//  - ADMIN-WRITABLE: the only fields a request body may set; anything else in it is ignored.
//    issuerUrl/audience are legacy (never read for sign-in) and stay writable while the CRM form
//    still sends them.
//  - SERVER-MANAGED: set only by server flows (connect / test); never taken from a request body and
//    always carried over from the stored connection when the connection is saved.
//  - PRESERVED LEGACY (inert): appRef / directoryOwnership (Phase 3B) are not part of the approved
//    connection model - the CRM application is fixed server configuration and directory ownership
//    moves to directory claims. Never taken from a request body (a new connection never gets them);
//    a stored connection keeps its values, matched by _id, until a controlled cleanup migration.
const ADMIN_WRITABLE_CONNECTION_FIELDS = [
  "connectionType",
  "issuerUrl",
  "directoryId",
  "audience",
  "isActive",
  "autoProvisionUsers",
  "defaultRoleId",
];
const SERVER_MANAGED_CONNECTION_FIELDS = [
  "connectedAt",
  "connectedBy",
  "lastTestedAt",
  "lastTestResult",
  "disconnectedAt",
  "disconnectedBy",
];
const PRESERVED_LEGACY_CONNECTION_FIELDS = ["appRef", "directoryOwnership"];
const STORED_ONLY_CONNECTION_FIELDS = [...SERVER_MANAGED_CONNECTION_FIELDS, ...PRESERVED_LEGACY_CONNECTION_FIELDS];
const CONNECTION_FIELDS = ADMIN_WRITABLE_CONNECTION_FIELDS;

const DIRECTORY_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUER_URL = /^https:\/\/login\.microsoftonline\.com\/[^\/]+\/v2\.0$/;
const isBlank = (v) => v === undefined || v === null || v === "";

class ConnectionValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConnectionValidationError";
    this.status = 400;
    this.code = "INVALID_AUTH_CONNECTION";
  }
}

/**
 * Activation of a disconnected Entra connection (Stage 5c-3): 409, not 400. A subclass so every
 * existing ConnectionValidationError pass-through keeps carrying it to the controller.
 */
class ConnectionDisconnectedError extends ConnectionValidationError {
  constructor() {
    super("Reconnect Microsoft Entra before activating this connection.");
    this.name = "ConnectionDisconnectedError";
    this.status = 409;
    this.code = "CONNECTION_DISCONNECTED";
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
 * `connectionId` is the stored connection's id and `stored` the stored connection (both absent for
 * a new connection). Throws
 * ConnectionValidationError (-> 400).
 *
 * Multi-directory mode (Stage 5b): an ACTIVE Entra connection needs a verified directory claim for
 * this organisation, directory and connection. A new connection therefore starts inactive and is
 * activated once its claim is verified; changing the directory of an active connection is refused
 * unless the new directory is claimed for it. Nothing here creates or verifies a claim.
 *
 * Disconnect (Stage 5c-3), independent of the multi-directory switch: once an organisation has
 * disconnected a directory (a revoked claim for that organisation + directory - durable even when the
 * connection record is deleted), no Entra connection of that organisation - the original, an edited
 * one or a new / replacement one - can be saved active for that directory until it has its own
 * verified claim (Connect) - ConnectionDisconnectedError (-> 409). Organisations / directories
 * without revoked history keep the existing behaviour.
 */
async function assertConnectionWritable(tenantId, connection, { connectionId, stored } = {}) {
  const { autoProvisionUsers, defaultRoleId, connectionType } = connection;
  if (connectionType === ENTRA && !DIRECTORY_GUID.test(String(connection.directoryId ?? "").trim())) {
    throw new ConnectionValidationError("Directory ID must be the Microsoft Entra tenant ID (a GUID)");
  }
  if (connectionType === ENTRA && connection.isActive === true && tenantId) {
    const { isActivationBlockedByDisconnect } = require("./directoryClaimService");
    if (await isActivationBlockedByDisconnect({ tenantId, connectionId: connectionId ?? stored?._id, directoryId: connection.directoryId })) {
      throw new ConnectionDisconnectedError();
    }
  }
  if (connectionType === ENTRA && connection.isActive === true) {
    const { assertConnectionDirectoryClaim } = require("./directoryClaimGate");
    try {
      await assertConnectionDirectoryClaim({ tenantId, connection, connectionId });
    } catch (e) {
      if (e && e.code === "DIRECTORY_NOT_CLAIMED") {
        throw new ConnectionValidationError(
          "This Microsoft Entra directory is not verified for this organisation; save the connection inactive until it is"
        );
      }
      throw e;
    }
  }
  if (!isBlank(connection.issuerUrl) && !ISSUER_URL.test(connection.issuerUrl)) {
    throw new ConnectionValidationError("Issuer URL must be a valid Microsoft login URL");
  }
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

/** The admin-writable fields present in `input` (a request body or a stored connection). */
const pickConnectionFields = (input) => {
  const out = {};
  for (const f of ADMIN_WRITABLE_CONNECTION_FIELDS) {
    if (input && Object.prototype.hasOwnProperty.call(input, f)) out[f] = input[f];
  }
  // An emptied selector clears the value.
  if (out.defaultRoleId === "") out.defaultRoleId = null;
  return out;
};

const plain = (v) => (v?.toObject ? v.toObject() : v);

const storedFields = (stored, fields) => {
  const out = {};
  const s = plain(stored);
  for (const f of fields) {
    if (s && s[f] !== undefined && s[f] !== null) out[f] = s[f];
  }
  return out;
};
/** The server-managed fields of a STORED connection (never of a request body). */
const serverManagedFields = (stored) => storedFields(stored, SERVER_MANAGED_CONNECTION_FIELDS);
/** Server-managed + preserved legacy fields of a STORED connection (never of a request body). */
const storedOnlyFields = (stored) => storedFields(stored, STORED_ONLY_CONNECTION_FIELDS);

// --- Connection identity: provider + directory ---------------------------------------------------
// Within one organisation, among ACTIVE connections (isActive unset counts as active, the schema
// default): at most one Microsoft Entra connection (sign-in requires exactly one), and no two
// connections of the same provider for the same directory (directory ids compared
// case-insensitively). Cross-organisation directory uniqueness is a later stage (directory claims).
const normDirectory = (v) => String(v ?? "").trim().toLowerCase();
const isActiveConnection = (c) => c?.isActive !== false;
const identityConflicts = (entries) => {
  const active = entries.filter((e) => isActiveConnection(e.c));
  const out = [];
  const entra = active.filter((e) => e.c.connectionType === ENTRA);
  if (entra.length > 1) out.push({ rule: "MULTIPLE_ACTIVE_ENTRA", ids: entra.map((e) => e.id) });
  const byKey = new Map();
  for (const e of active) {
    const key = `${e.c.connectionType}|${normDirectory(e.c.directoryId)}`;
    byKey.set(key, [...(byKey.get(key) || []), e.id]);
  }
  for (const ids of byKey.values()) if (ids.length > 1) out.push({ rule: "DUPLICATE_DIRECTORY", ids });
  return out;
};
const IDENTITY_MESSAGES = {
  MULTIPLE_ACTIVE_ENTRA: "An organisation can have only one active Microsoft Entra connection",
  DUPLICATE_DIRECTORY: "Authentication connection with this Directory ID already exists",
};
const sameIds = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const sameIdentity = (a, b) =>
  a.connectionType === b.connectionType &&
  normDirectory(a.directoryId) === normDirectory(b.directoryId) &&
  isActiveConnection(a) === isActiveConnection(b);

/**
 * Identity rules for the FINAL proposed connection list of an organisation (`proposed`, stored
 * connections keep their _id), compared with what is stored. A conflict is refused unless it is
 * grandfathered: it already existed in the stored list between the same connections and none of
 * them changed provider, directory or active state (an unrelated save never fails on an old
 * conflict; a new connection or an edit that creates or touches a conflict does).
 * Throws ConnectionValidationError.
 */
function assertConnectionIdentity(proposed, stored = []) {
  const idOf = (c, i) => (c && c._id != null ? String(c._id) : `new:${i}`);
  const storedPlain = (stored || []).map(plain);
  const storedById = new Map(storedPlain.map((c) => [String(c._id), c]));
  const proposedEntries = (proposed || []).map((c, i) => ({ id: idOf(plain(c), i), c: plain(c) }));
  const before = identityConflicts(storedPlain.map((c) => ({ id: String(c._id), c })));
  for (const conflict of identityConflicts(proposedEntries)) {
    const grandfathered =
      before.some((b) => b.rule === conflict.rule && sameIds(b.ids, conflict.ids)) &&
      conflict.ids.every((id) => {
        const was = storedById.get(id);
        const now = proposedEntries.find((e) => e.id === id)?.c;
        return was && now && sameIdentity(was, now);
      });
    if (!grandfathered) throw new ConnectionValidationError(IDENTITY_MESSAGES[conflict.rule]);
  }
}
const sameValue = (a, b) => String(a ?? "") === String(b ?? "");

/**
 * Full authenticationConnections array from a tenant create/update body -> the array to store.
 * A connection is matched to a stored one by _id (anything else is new). From the body only
 * admin-writable fields are taken; an admin-writable field the body does not send keeps its stored
 * value, and the server-managed and preserved legacy fields are always carried over from the stored
 * connection (never from the body). New or changed connections must pass assertConnectionWritable;
 * unchanged stored ones are kept as they are (grandfathered). The final list must pass
 * assertConnectionIdentity. Throws ConnectionValidationError.
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
    const changed = ADMIN_WRITABLE_CONNECTION_FIELDS.some((f) => !sameValue(merged[f], previous[f]));
    if (changed) await assertConnectionWritable(tenantId, merged, { connectionId: previous._id, stored: previous });
    result.push({
      ...merged,
      ...storedOnlyFields(previous),
      _id: previous._id,
      createdAt: previous.createdAt,
      updatedAt: changed ? now : previous.updatedAt,
    });
  }
  assertConnectionIdentity(result, stored);
  return result;
}

/**
 * Role for a user about to be created just-in-time through `connection` (already known to be
 * automatic): its explicit defaultRoleId, checked by checkDefaultRole. Returns the role id; throws
 * DefaultRoleError when none is configured (NOT_CONFIGURED) or the configured role is unusable.
 */
async function resolveJitDefaultRoleId({ tenantId, connection }) {
  const ids = { tenantId: String(tenantId), connectionId: connection?._id ? String(connection._id) : null };
  if (!connection?.defaultRoleId) {
    console.warn("JIT refused: automatic connection has no default role", ids);
    throw new DefaultRoleError("NOT_CONFIGURED");
  }
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
  ADMIN_WRITABLE_CONNECTION_FIELDS,
  SERVER_MANAGED_CONNECTION_FIELDS,
  PRESERVED_LEGACY_CONNECTION_FIELDS,
  serverManagedFields,
  storedOnlyFields,
  assertConnectionIdentity,
  ConnectionValidationError,
  ConnectionDisconnectedError,
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
