/**
 * P7 role / user-type compatibility (P-plan §5d, B6).
 *
 * A role's CLASS is CRM, PORTAL or SYSTEM:
 *  - Standard role codes take their class from ROLE_CLASS_BY_CODE, a platform-owned copy of the
 *    new-tenant manifest classes (#39 config/tenantRoles.v1.json `category`, cross-checked by
 *    tests/roleClass.p7.test.js). The live `role.category` is NOT trusted for these: in existing DEV
 *    data most staff roles carry category PORTAL.
 *  - Any other (tenant-custom) role takes its class from its stored `category`. A missing category
 *    is CATEGORY_MISSING and a value outside CRM/PORTAL/SYSTEM is CATEGORY_UNKNOWN: such a role has
 *    no class and is compatible with no user type.
 *
 * Compatibility: a CRM user may hold CRM and SYSTEM (ASU) roles; a PORTAL user may hold PORTAL roles.
 * A user type that is missing (USER_TYPE_MISSING) or not CRM/PORTAL (USER_TYPE_UNKNOWN) is
 * compatible with nothing.
 *
 * ROLE_CLASS_MODE (read per call):
 *   off (default) - today's behaviour exactly; no class evaluation at all.
 *   shadow        - today's outcome; every case enforce would change is logged as role.class.shadow.
 *   enforce       - assignment of an incompatible role is refused (409 ROLE_CLASS_INCOMPATIBLE), with
 *                   no partial change; token issuance drops incompatible roles and rebuilds permissions
 *                   from the compatible roles (stored assignments are left as they are); issuance is
 *                   refused (403 USER_TYPE_INVALID, no token) when the stored user type is missing or
 *                   unknown; an Entra/B2C default role must pass today's rule AND fit by class.
 *   Any other value is treated as off (rollback-safe) and warned once.
 *
 * Log lines carry the event, path, mode, outcome, masked tenant/user ids, user type, role codes,
 * classes and reasons. Never emails, names, tokens or permission lists.
 */

const { AppError } = require("../errors/AppError");

const ROLE_CLASS_MODES = Object.freeze(["off", "shadow", "enforce"]);
const ROLE_CLASSES = Object.freeze(["CRM", "PORTAL", "SYSTEM"]);
const USER_TYPES = Object.freeze(["CRM", "PORTAL"]);

// Classes of the 24 standard roles in the #39 new-tenant manifest (b33fc00).
const ROLE_CLASS_BY_CODE = Object.freeze({
  ACC: "CRM",
  ADIR: "CRM",
  AM: "CRM",
  AMO: "CRM",
  ASU: "SYSTEM",
  BO: "CRM",
  CC: "CRM",
  DAM: "CRM",
  DGS: "CRM",
  DIR: "CRM",
  DPO: "CRM",
  DPRS: "CRM",
  GS: "CRM",
  HLS: "CRM",
  IO: "CRM",
  IRE: "CRM",
  IRO: "CRM",
  LA: "CRM",
  LS: "CRM",
  MEMBER: "PORTAL",
  MO: "CRM",
  "NON-MEMBER": "PORTAL",
  REO: "CRM",
  RO: "CRM",
});

const COMPATIBLE_CLASSES = Object.freeze({
  CRM: Object.freeze(["CRM", "SYSTEM"]),
  PORTAL: Object.freeze(["PORTAL"]),
});

let warnedInvalidMode = false;
function roleClassMode() {
  const raw = process.env.ROLE_CLASS_MODE;
  if (raw === undefined || raw === null || String(raw).trim() === "") return "off";
  const mode = String(raw).trim().toLowerCase();
  if (ROLE_CLASS_MODES.includes(mode)) return mode;
  if (!warnedInvalidMode) {
    warnedInvalidMode = true;
    console.warn("[ROLE_CLASS] ROLE_CLASS_MODE has an unknown value; treated as off");
  }
  return "off";
}

const upper = (v) => (v === undefined || v === null ? "" : String(v).trim().toUpperCase());
const roleCodeOf = (role) => upper(role?.code) || null;

/** { roleClass, source: "standard"|"category", problem: null|"CATEGORY_MISSING"|"CATEGORY_UNKNOWN" } */
function roleClassOf(role) {
  const code = roleCodeOf(role);
  if (code && Object.prototype.hasOwnProperty.call(ROLE_CLASS_BY_CODE, code)) {
    return { roleClass: ROLE_CLASS_BY_CODE[code], source: "standard", problem: null };
  }
  const category = upper(role?.category);
  if (!category) return { roleClass: null, source: "category", problem: "CATEGORY_MISSING" };
  if (!ROLE_CLASSES.includes(category)) return { roleClass: null, source: "category", problem: "CATEGORY_UNKNOWN" };
  return { roleClass: category, source: "category", problem: null };
}

/**
 * The user type as STORED. A Mongoose user document fills a missing userType with the schema
 * default (PORTAL); that filled-in value is not trusted and reads as missing. Plain objects (lean
 * reads, tests) are taken as they are.
 */
function storedUserType(user) {
  if (!user) return undefined;
  if (typeof user.$isDefault === "function" && user.$isDefault("userType")) return undefined;
  return user.userType;
}

/** null when the user type is CRM or PORTAL, else USER_TYPE_MISSING / USER_TYPE_UNKNOWN. */
function userTypeProblem(userType) {
  const t = upper(userType);
  if (!t) return "USER_TYPE_MISSING";
  return USER_TYPES.includes(t) ? null : "USER_TYPE_UNKNOWN";
}

/** null when a user of `userType` may hold `role`, else the reason. */
function incompatibility(userType, role) {
  const typeProblem = userTypeProblem(userType);
  if (typeProblem) return typeProblem;
  const { roleClass, problem } = roleClassOf(role);
  if (problem) return problem;
  return COMPATIBLE_CLASSES[upper(userType)].includes(roleClass) ? null : "ROLE_CLASS_MISMATCH";
}

/** Split `roles` into those a user of `userType` may hold and those it may not (with reasons). */
function partitionRoles(userType, roles) {
  const compatible = [];
  const incompatible = [];
  for (const role of Array.isArray(roles) ? roles : []) {
    if (!role) continue;
    const reason = incompatibility(userType, role);
    if (reason) incompatible.push({ role, reason });
    else compatible.push(role);
  }
  return { compatible, incompatible };
}

const mask = (v) => {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const s = String(v);
  return s.length > 8 ? `${s.slice(0, 4)}..${s.slice(-4)}` : "****";
};

function logRoleClass(event, { tenantId, userId, ...fields }) {
  const line = {
    event,
    ...(tenantId === undefined ? {} : { tenantId: mask(tenantId) }),
    ...(userId === undefined ? {} : { userId: mask(userId) }),
    ...fields,
  };
  console.warn("[ROLE_CLASS]", JSON.stringify(line));
}

class RoleClassError extends Error {
  constructor(details, message = "Role is not compatible with this user's type") {
    super(message);
    this.name = "RoleClassError";
    this.status = 409;
    this.code = "ROLE_CLASS_INCOMPATIBLE";
    this.details = details;
  }
}

/**
 * Assignment guard. Call with the roles being NEWLY given to `user`, before any change to the user.
 * off: nothing. shadow: logs what enforce would refuse, returns. enforce: throws RoleClassError
 * for the whole request when any role is incompatible, so nothing is assigned.
 */
function assertRoleClassAssignment({ user, roles, tenantId, path }) {
  const mode = roleClassMode();
  if (mode === "off") return;
  const userType = storedUserType(user);
  const { incompatible } = partitionRoles(userType, roles);
  if (incompatible.length === 0) return;
  const details = incompatible.map(({ role, reason }) => ({
    roleCode: roleCodeOf(role),
    roleClass: roleClassOf(role).roleClass,
    reason,
  }));
  logRoleClass(mode === "enforce" ? "role.class.enforce" : "role.class.shadow", {
    path,
    mode,
    outcome: mode === "enforce" ? "assignment_refused" : "assignment_would_be_refused",
    tenantId: tenantId ?? user?.tenantId,
    userId: user?._id,
    userType: userType ?? null,
    roles: details,
  });
  if (mode === "enforce") throw new RoleClassError(details);
}

/**
 * Sign-in / refresh refusal for a user whose stored type is missing or unknown (enforce only). A
 * plain AppError so every sign-in controller and the app error handler return it as a stable 403
 * with code USER_TYPE_INVALID; the specific reason is logged, not returned.
 */
function userTypeRefusal(reason) {
  const error = new AppError("Sign-in is not available for this account", 403, "USER_TYPE_INVALID");
  error.userTypeReason = reason;
  return error;
}

/** Boolean form for helpers that report failure by returning false (roleAssignment.js). */
function roleClassAllows({ user, role, tenantId, path }) {
  try {
    assertRoleClassAssignment({ user, roles: [role], tenantId, path });
    return true;
  } catch (error) {
    if (error instanceof RoleClassError) return false;
    throw error;
  }
}

module.exports = {
  ROLE_CLASS_MODES,
  ROLE_CLASSES,
  USER_TYPES,
  ROLE_CLASS_BY_CODE,
  roleClassMode,
  roleClassOf,
  storedUserType,
  userTypeProblem,
  incompatibility,
  partitionRoles,
  logRoleClass,
  mask,
  RoleClassError,
  userTypeRefusal,
  assertRoleClassAssignment,
  roleClassAllows,
};
