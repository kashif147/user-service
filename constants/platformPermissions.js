/**
 * Phase B / Z1: the platform permission catalogue.
 *
 * Platform authority is NOT a tenant permission. These codes are granted only through a
 * PlatformPrincipal record (models/platformPrincipal.model.js), never through a tenant Role, and the
 * tenant wildcard "*" never stands for any of them. They live in code, not in the tenant Permission
 * collection, so no tenant-admin API can create, grant or edit them.
 *
 * Minimal catalogue for Phase B, from the inventory of platform-level operations (design Z1 §3), names
 * revised in Z2 (owner decision D1) so that tenant-targeting codes say "ANY tenant" - ordinary own-tenant
 * administration stays in the tenant permission domain (tenant:read, TENANT_ADMIN, ...):
 *  - platform:tenant:create                      POST /tenants
 *  - platform:tenant:read:any                    read any tenant: list-all, by internal id, stats. NOT the
 *                                                organisation locators /tenants/code/:code and /tenants/domain/:domain,
 *                                                which stay tenant / login-locator scoped (owner decision, Z7): no
 *                                                global organisation-code / domain enumeration path.
 *  - platform:tenant:update:any                  update any tenant (profile, branding, regional settings,
 *                                                status incl. suspend/reactivate until P2 - decision D2)
 *  - platform:tenant:delete:any                  delete / decommission any tenant
 *  - platform:tenant:auth-connections:manage:any auth connections / connect / test / disconnect of any tenant
 *  - platform:cache:admin                        /cache/*, /lookup/clear|stats, /country/clear, role-hierarchy, permissions-map
 *  - platform:permission-catalogue:manage        the global permission catalogue (permission.routes writes)
 *  - platform:reference-data:manage              shared reference data writes (lookups, lookup types, countries,
 *                                                contacts, contact types)
 *  - platform:provisioning:admin                 platform templates, provisioning runs (reserved until P3)
 *  - platform:principals:manage                  PlatformPrincipal records (reserved; the reviewed script is the only writer)
 *
 * Each code is matched EXACTLY (middlewares/requirePlatformPermission.js): no wildcard, no prefix, no
 * hierarchy - one platform permission never implies another.
 */
const PLATFORM_PERMISSIONS = Object.freeze([
  "platform:tenant:create",
  "platform:tenant:read:any",
  "platform:tenant:update:any",
  "platform:tenant:delete:any",
  "platform:tenant:auth-connections:manage:any",
  "platform:cache:admin",
  "platform:permission-catalogue:manage",
  "platform:reference-data:manage",
  "platform:provisioning:admin",
  "platform:principals:manage",
]);

const PLATFORM_PERMISSION_SET = new Set(PLATFORM_PERMISSIONS);

function isPlatformPermission(code) {
  return typeof code === "string" && PLATFORM_PERMISSION_SET.has(code);
}

module.exports = { PLATFORM_PERMISSIONS, isPlatformPermission };
