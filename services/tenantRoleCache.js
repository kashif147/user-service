/**
 * P5: invalidate ONE tenant's role-derived caches after its roles or role permissions change (never a global
 * flush). Best effort and non-blocking for the caller's outcome: a cache failure is logged and reported
 * ({ invalidated: false, failed: [cache] }), never thrown and never turned into a failed write.
 *   - role hierarchy     role_hierarchy:<tenant>            (roleHierarchyService, 5 min)
 *   - role permissions   role_permissions:<tenant>:<code>   (permissionsService, 5 min; read when tokens are issued)
 * Deliberately NOT here:
 *   - PDP decision cache: keys are derived from the token's VERIFIED roles + permissions (+ decision epoch), and
 *     the PDP reads no role rows (ASU is recognised by code), so a token issued after the change never reads a
 *     decision cached for the previous role content; an older token keeps exactly the decision it would get anew.
 *   - cacheInvalidationService.invalidateTenantCache: its /me step calls a PolicyCache.delPattern that does not
 *     exist and its policy step blocks on Redis reconnect attempts (~55 s) when Redis is down - it has no callers
 *     and must not get one until fixed (recorded P5 finding).
 */
async function invalidateTenantRoleCaches(tenantId) {
  const tid = tenantId == null ? "" : String(tenantId).trim();
  if (!tid) return { invalidated: false, failed: [] };
  const steps = [
    ["role_hierarchy", () => require("./roleHierarchyService").clearCache(tid)],
    ["role_permissions", () => require("./permissionsService").clearTenantRoleCache(tid)],
  ];
  const failed = [];
  for (const [name, fn] of steps) {
    try { await fn(); } catch (e) { failed.push(name); console.warn("[tenant-role-cache]", JSON.stringify({ event: "tenant.role_cache.invalidate_failed", cache: name, error: e && e.name })); }
  }
  // invalidated = every tenant-scoped step succeeded; a partial failure is reported so the caller can retry.
  return { invalidated: failed.length === 0, failed };
}

module.exports = { invalidateTenantRoleCaches };
