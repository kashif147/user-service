/**
 * P5: ensureTenantRoles(targetTenantId, { version, sha256 }) - provision a tenant's roles from the versioned
 * tenant-roles manifest (services/tenantRoleManifest.js). Implemented and tested; NOT called by tenant creation,
 * any route or any template yet (standard-tenant v2 is design-only). Replaces - once approved - the legacy live
 * MAIN-tenant clone; there is no second canonical path.
 *
 * Semantics (insert-missing-only, like the grid-default components):
 *   1. explicit internal tenantId (24-hex) of an EXISTING tenant - never an org code, Entra tid or email domain;
 *   2. the requested version AND sha256 must equal the local manifest exactly (else MANIFEST_DIGEST_MISMATCH);
 *   3. the whole manifest is validated (structure, invariants, retired codes, no wildcard / ObjectId / platform
 *      permission, exactly one tenantAdmin = ASU) and every permission code against the ACTIVE catalogue - all
 *      BEFORE the first insert; any problem -> nothing is written;
 *   4. per manifest role, matched by {tenantId, code} on the target tenant only:
 *        - a role with that code exists (active or not)  -> skipped (never updated: tenant customisation and soft
 *          deletes are preserved);
 *        - another role of the tenant already holds the name -> conflict NAME_TAKEN (reported, not inserted);
 *        - otherwise inserted, tenant-owned, createdBy platform:provisioning, with the origin marker
 *          provisioning { component, manifestVersion, manifestSha256, insertedAt } (makes its code immutable);
 *   5. all planned inserts run in ONE transaction (all or nothing); a concurrent insert (duplicate key) aborts it
 *      and the call can simply be repeated (idempotent);
 *   6. after commit, and only if something was inserted, the target tenant's role caches are invalidated.
 * Returns { tenantId, manifestVersion, manifestSha256, inserted: [code], skipped: [{code, reason}],
 *           conflicts: [{code, reason}] }.
 */
const mongoose = require("mongoose");
const Role = require("../models/role.model");
const Tenant = require("../models/tenant.model");
const { loadManifest, catalogueProblems, TenantRoleManifestError } = require("./tenantRoleManifest");
const { isRetiredRoleCode } = require("../constants/retiredRoleCodes");
const { invalidateTenantRoleCaches } = require("./tenantRoleCache");

const ACTOR = "platform:provisioning";
const OBJECT_ID = /^[0-9a-f]{24}$/;

class TenantRoleProvisioningError extends Error {
  constructor(code, message, extras = {}) {
    super(message);
    this.name = "TenantRoleProvisioningError";
    this.code = code;
    Object.assign(this, extras);
  }
}

async function ensureTenantRoles(targetTenantId, { version, sha256 } = {}, { manifestFile, now = () => new Date(), invalidate = invalidateTenantRoleCaches } = {}) {
  const tenantId = typeof targetTenantId === "string" ? targetTenantId : "";
  if (!OBJECT_ID.test(tenantId)) throw new TenantRoleProvisioningError("INVALID_TENANT_ID", "An explicit internal tenant id is required");
  const loaded = manifestFile ? loadManifest(manifestFile) : loadManifest();
  if (version !== loaded.version || sha256 !== loaded.sha256) {
    throw new TenantRoleProvisioningError("MANIFEST_DIGEST_MISMATCH", "Requested tenant-roles manifest does not match the local manifest", { expected: { version: loaded.version, sha256: loaded.sha256 } });
  }
  const { manifest } = loaded;
  const catalogue = await catalogueProblems(manifest);
  if (catalogue.length) throw new TenantRoleManifestError(catalogue);
  if (manifest.roles.some((r) => isRetiredRoleCode(r.code))) throw new TenantRoleManifestError(["retired role code"]); // defence in depth

  const tenant = await Tenant.findOne({ _id: tenantId }).select({ _id: 1 }).lean();
  if (!tenant) throw new TenantRoleProvisioningError("TENANT_NOT_FOUND", "Target tenant does not exist");

  const existing = await Role.find({ tenantId }).select({ code: 1, name: 1, isActive: 1 }).lean();
  const byCode = new Map(existing.map((r) => [String(r.code).trim(), r]));
  const names = new Set(existing.map((r) => String(r.name).trim().toLowerCase()));
  const inserted = [];
  const skipped = [];
  const conflicts = [];
  const docs = [];
  const insertedAt = now();
  for (const r of manifest.roles) {
    const have = byCode.get(r.code);
    if (have) { skipped.push({ code: r.code, reason: have.isActive === false ? "EXISTS_INACTIVE" : "EXISTS" }); continue; }
    if (names.has(r.name.toLowerCase())) { conflicts.push({ code: r.code, reason: "NAME_TAKEN" }); continue; }
    docs.push({
      tenantId,
      code: r.code,
      name: r.name,
      description: r.description,
      category: r.category,
      level: r.level,
      isSystemRole: r.isSystemRole,
      permissions: [...r.permissions],
      isActive: true,
      createdBy: ACTOR,
      updatedBy: null,
      provisioning: { component: Role.TENANT_ROLES_COMPONENT, manifestVersion: loaded.version, manifestSha256: loaded.sha256, insertedAt },
    });
    inserted.push(r.code);
  }

  if (docs.length) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await Role.insertMany(docs, { session, ordered: true });
      });
    } catch (e) {
      if (e && (e.code === 11000 || /E11000/.test(String(e.message)))) {
        throw new TenantRoleProvisioningError("CONCURRENT_ROLE_WRITE", "A role was created concurrently; nothing was inserted - repeat the call");
      }
      throw e;
    } finally {
      await session.endSession();
    }
    await invalidate(tenantId);
  }
  return { tenantId, manifestVersion: loaded.version, manifestSha256: loaded.sha256, inserted, skipped, conflicts };
}

module.exports = { ensureTenantRoles, TenantRoleProvisioningError, ACTOR };
