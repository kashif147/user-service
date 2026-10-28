/**
 * Phase B / Z3: permission classification - the single place that decides what kind of code a permission is.
 *
 * INVARIANT (enforced structurally, not by convention):
 *   - "*" (TENANT_WILDCARD) may stand for every TENANT permission, inside the caller's own tenant.
 *   - "*" NEVER stands for any platform permission.
 *   - No tenant role may hold a platform permission - neither today's catalogue codes nor any future one.
 *
 * The platform namespace is reserved by RULE, not by list: every code whose resource segment is "platform"
 * (any case, CODE_FORMAT or canonical, surrounding whitespace ignored) is a platform code, so a platform
 * permission added later is excluded from tenant roles automatically. Platform authority is granted only
 * by a PlatformPrincipal (exact catalogue codes, constants/platformPermissions.js) and checked only by the
 * platform evaluator (services/platformAuthorizationService.js, exact match, never "*").
 *
 * Classes (classifyPermission):
 *   PLATFORM  - platform namespace. Never tenant-grantable (no actor, SU included), never satisfied by
 *               "*", never evaluated by the tenant PDP.
 *   RESERVED  - "*" and the legacy reserved tenant codes (global admin / catalogue / tenant creation /
 *               super_admin / shared-metadata writes). Only a legacy SU may grant them (role.handler).
 *   TENANT    - everything else: ordinary tenant permissions.
 *
 * Enforced by: models/role.model.js and models/permission.model.js (write guards),
 * handlers/role.handler.js (role API boundary), services/policyEvaluationService.js and
 * services/permissionsService.js (tenant evaluation via tenantPermissionGranted).
 */
const TENANT_WILDCARD = "*";
const PLATFORM_RESOURCE = "platform";

/** CODE_FORMAT -> resource:action (as helpers/jwt.js); "*" stays "*"; trimmed, lower-cased. */
function canonicalPermission(perm) {
  if (perm == null || typeof perm !== "string") return null;
  const p = perm.trim();
  if (p === TENANT_WILDCARD) return TENANT_WILDCARD;
  if (p.includes(":")) return p.toLowerCase();
  return p.toLowerCase().replace(/_/g, ":");
}

/** True for any code in the reserved platform namespace (current catalogue or future). */
function isPlatformNamespace(perm) {
  const c = canonicalPermission(perm);
  if (!c) return false;
  const resource = c.split(":")[0].replace(/\s+/g, "");
  return resource === PLATFORM_RESOURCE || resource.startsWith(`${PLATFORM_RESOURCE}.`);
}

/** Legacy reserved tenant codes: only a legacy SU may grant these (Phase 1C-2B / A14 rules). */
function isLegacyReservedPermission(canonical) {
  if (!canonical) return false;
  if (canonical === TENANT_WILDCARD) return true;
  const [resource, action] = canonical.split(":");
  if (action === "super_admin") return true;
  if (resource === "admin") return true; // platform admin resource (e.g. global cache control)
  if (resource === "permission" && action !== "read") return true; // global permission catalogue
  if (resource === "tenant" && action === "create") return true; // new tenants
  // Phase A / A14: lookups and lookup types are still global (shared by every tenant) until the
  // Phase D/E cutover, so a tenant must not be able to grant itself write access to them. The
  // write APIs are also frozen (423). delete is deliberately not reserved here: an existing JIT
  // default role (DEV) carries lookuptype:delete, and reserving it would refuse that sign-up path.
  if ((resource === "lookup" || resource === "lookuptype") && action === "write") return true;
  return false;
}

/**
 * A "*" anywhere but the whole entry ("*") or the whole action ("payments:*") is not a meaningful
 * permission ("*:*", "*:read", "pay*:read", "**").
 */
function isMalformedWildcard(perm) {
  if (typeof perm !== "string" || !perm.includes("*")) return false;
  const p = perm.trim();
  if (p === TENANT_WILDCARD) return false;
  return !/^[^*:\s]+:\*$/.test(p);
}

function classifyPermission(perm) {
  if (isPlatformNamespace(perm)) return "PLATFORM";
  if (isLegacyReservedPermission(canonicalPermission(perm))) return "RESERVED";
  return "TENANT";
}

/**
 * TENANT permission evaluation: does `held` (the caller's tenant-scoped permissions) satisfy `required`?
 * Exact match or "*" - but never for a platform code, whatever `held` contains. Callers still apply the
 * tenant boundary themselves; this never widens it.
 */
function tenantPermissionGranted(held, required) {
  if (!Array.isArray(held) || typeof required !== "string" || !required) return false;
  if (isPlatformNamespace(required)) return false;
  return held.includes(required) || held.includes(TENANT_WILDCARD);
}

/** The "*" half of tenantPermissionGranted: does the tenant wildcard cover `required`? */
function tenantWildcardCovers(held, required) {
  if (!Array.isArray(held) || typeof required !== "string" || !required) return false;
  return !isPlatformNamespace(required) && held.includes(TENANT_WILDCARD);
}

module.exports = {
  TENANT_WILDCARD,
  PLATFORM_RESOURCE,
  canonicalPermission,
  isPlatformNamespace,
  isLegacyReservedPermission,
  isMalformedWildcard,
  classifyPermission,
  tenantPermissionGranted,
  tenantWildcardCovers,
};
