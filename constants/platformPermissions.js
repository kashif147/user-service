/**
 * Phase B / Z1: the platform permission catalogue.
 *
 * Platform authority is NOT a tenant permission. These codes are granted only through a
 * PlatformPrincipal record (models/platformPrincipal.model.js), never through a tenant Role, and the
 * tenant wildcard "*" never stands for any of them. They live in code, not in the tenant Permission
 * collection, so no tenant-admin API can create, grant or edit them.
 *
 * Minimal catalogue for Phase B, from the inventory of platform-level operations (design Z1 §3):
 *  - platform:tenant:create                  POST /tenants
 *  - platform:tenant:read                    read any tenant (list-all, by id/code/domain, stats)
 *  - platform:tenant:update                  update any tenant (profile, status, branding, regional settings)
 *  - platform:tenant:delete                  DELETE /tenants/:id
 *  - platform:tenant:auth-connections:manage auth connections / connect / test / disconnect of any tenant
 *  - platform:cache:admin                    /cache/*, /lookup/clear|stats, /country/clear, role-hierarchy, permissions-map
 *  - platform:permissions:manage             the global permission catalogue (permission.routes writes)
 *  - platform:catalogue:manage               shared reference data writes (lookups, lookup types, countries, contact types)
 *  - platform:provisioning:admin             platform templates, provisioning runs, tenant lifecycle (P1-P6)
 *  - platform:principals:manage              PlatformPrincipal records (Z2 API; Z1 uses the reviewed script only)
 *
 * Z1 defines the codes only: no route checks them yet (Z2 onwards).
 */
const PLATFORM_PERMISSIONS = Object.freeze([
  "platform:tenant:create",
  "platform:tenant:read",
  "platform:tenant:update",
  "platform:tenant:delete",
  "platform:tenant:auth-connections:manage",
  "platform:cache:admin",
  "platform:permissions:manage",
  "platform:catalogue:manage",
  "platform:provisioning:admin",
  "platform:principals:manage",
]);

const PLATFORM_PERMISSION_SET = new Set(PLATFORM_PERMISSIONS);

function isPlatformPermission(code) {
  return typeof code === "string" && PLATFORM_PERMISSION_SET.has(code);
}

module.exports = { PLATFORM_PERMISSIONS, isPlatformPermission };
