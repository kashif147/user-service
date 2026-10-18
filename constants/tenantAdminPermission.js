/**
 * TENANT_ADMIN - the single source-controlled definition of the `tenant:admin` permission (the
 * permission every authentication-connection route checks; tenant:read is the read side), and the
 * rule for which role holds it.
 *
 * Used by the empty-catalogue seed (handlers/permission.handler.js initializeDefaultPermissions),
 * the runtime fallback catalogue (services/permissionsService.js getFallbackPermissions), new-tenant
 * provisioning (handlers/tenant.handler.js) and scripts/ensure-tenant-admin.js (existing
 * environments). Never contains environment-specific ids.
 *
 * Recipient: ONLY each tenant's role with code ASU (by tenantId + code), which gets TENANT_READ and
 * TENANT_ADMIN. Never SU, staff, default or portal roles, and never users directly.
 */

const TENANT_ADMIN_PERMISSION = Object.freeze({
  name: "Administer Tenants",
  code: "TENANT_ADMIN",
  description: "Manage tenant authentication connections",
  resource: "tenant",
  action: "admin",
  category: "TENANT",
  level: 80,
  isActive: true,
  isSystemPermission: true,
});

/** Fields that define the permission's meaning (compared for drift; never overwritten). */
const SEMANTIC_FIELDS = Object.freeze(Object.keys(TENANT_ADMIN_PERMISSION));

const TENANT_ADMIN_ROLE_CODE = "ASU";
/** What the ASU role must hold (codes, in the order they are appended). */
const TENANT_ADMIN_ROLE_PERMISSIONS = Object.freeze(["TENANT_READ", "TENANT_ADMIN"]);

/** Semantic fields of an existing permission document that differ from the canonical definition. */
function permissionDrift(doc) {
  return SEMANTIC_FIELDS.filter((k) => (doc ? doc[k] : undefined) !== TENANT_ADMIN_PERMISSION[k]);
}

/**
 * Codes from TENANT_ADMIN_ROLE_PERMISSIONS that a role's permissions array does not yet hold. A role
 * may reference a permission by its code or by its ObjectId (string); either counts as present.
 * @param {Array} rolePermissions  the role's `permissions`
 * @param {Object<string, string|undefined>} idsByCode  catalogue _id (string) per code, if known
 */
function missingRolePermissions(rolePermissions, idsByCode = {}) {
  const held = new Set((rolePermissions || []).map(String));
  return TENANT_ADMIN_ROLE_PERMISSIONS.filter((code) => !held.has(code) && !(idsByCode[code] && held.has(String(idsByCode[code]))));
}

module.exports = {
  TENANT_ADMIN_PERMISSION,
  SEMANTIC_FIELDS,
  TENANT_ADMIN_ROLE_CODE,
  TENANT_ADMIN_ROLE_PERMISSIONS,
  permissionDrift,
  missingRolePermissions,
};
