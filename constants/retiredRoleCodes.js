/**
 * P5: role codes that must never be provisioned again (Phase B / Z9 tenant SU retirement). Used by the tenant-roles
 * manifest validator and ensureTenantRoles as a hard refusal - never as a grant. Allow-listed in
 * tests/tenantSuRetirement.z9.test.js for exactly that reason.
 */
const RETIRED_TENANT_ROLE_CODES = Object.freeze(["SU"]);
const isRetiredRoleCode = (code) => RETIRED_TENANT_ROLE_CODES.includes(String(code == null ? "" : code).trim().toUpperCase());

module.exports = { RETIRED_TENANT_ROLE_CODES, isRetiredRoleCode };
