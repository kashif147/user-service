/**
 * Ensures the source-controlled TENANT_ADMIN permission (constants/tenantAdminPermission.js) exists
 * and that every active ASU role holds TENANT_READ + TENANT_ADMIN - for EXISTING environments, where
 * the empty-catalogue seed (initializeDefaultPermissions) never runs again.
 *
 * Permission (identity = unique `code`):
 *   - TENANT_ADMIN missing and no other permission defines tenant/admin -> created (canonical).
 *   - TENANT_ADMIN present -> semantic fields compared; drift is REPORTED, never overwritten.
 *   - tenant/admin defined under another code, or more than one candidate -> CONFLICT: nothing is
 *     written at all.
 * Roles: only roles with code ASU (resolved per tenant by code, never by id), isActive true. A
 * permission counts as held by code or by its ObjectId string; missing codes are appended
 * ($addToSet). Nothing is removed, no role id changes, no other role is touched, users are never
 * read or written.
 *
 * Usage (inside the user-service container; MONGO_URI from its environment, never printed):
 *   node scripts/ensure-tenant-admin.js                     # dry run (default): counts only
 *   node scripts/ensure-tenant-admin.js --execute           # apply
 *   node scripts/ensure-tenant-admin.js --tenant <CODE|id>  # one tenant (24-hex id or code)
 * Output: counts, codes and status only.
 */
const {
  TENANT_ADMIN_PERMISSION,
  TENANT_ADMIN_ROLE_CODE,
  TENANT_ADMIN_ROLE_PERMISSIONS,
  permissionDrift,
  missingRolePermissions,
} = require("../constants/tenantAdminPermission");

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** Tenant filter for roles: all tenants, or exactly one (by 24-hex id or code). */
async function tenantScope(db, selector) {
  if (selector === undefined || selector === null) return { filter: {}, label: "all tenants" };
  const raw = String(selector).trim();
  const tenants = db.collection("tenants");
  const t = OBJECT_ID.test(raw)
    ? await tenants.findOne({ _id: new (require("mongoose").Types.ObjectId)(raw) }, { projection: { _id: 1, code: 1 } })
    : await tenants.findOne({ code: raw.toUpperCase() }, { projection: { _id: 1, code: 1 } });
  if (!t) return { error: "TENANT_NOT_FOUND" };
  // Role.tenantId is stored as a string in this service.
  return { filter: { tenantId: { $in: [String(t._id), t._id] } }, label: `tenant ${t.code}` };
}

/**
 * @param {import("mongodb").Db} db
 * @param {{execute?: boolean, tenant?: string, log?: (line: string) => void}} [opts]
 */
async function run(db, { execute = false, tenant, log = () => {} } = {}) {
  const permissions = db.collection("permissions");
  const roles = db.collection("roles");
  const report = { ok: false, executed: execute, permission: null, drift: [], asuRoles: 0, asuNeedingChange: 0, rolesUpdated: 0, permissionCreated: false, writes: 0 };

  const scope = await tenantScope(db, tenant);
  if (scope.error) {
    report.reason = scope.error;
    log(`REFUSED: ${scope.error}`);
    return report;
  }

  // 1-2. permission by code + tenant/admin conflicts
  const byCode = await permissions.find({ code: TENANT_ADMIN_PERMISSION.code }).toArray();
  const byResourceAction = await permissions
    .find({ resource: TENANT_ADMIN_PERMISSION.resource, action: TENANT_ADMIN_PERMISSION.action })
    .project({ _id: 1, code: 1 })
    .toArray();
  const otherCodes = byResourceAction.filter((p) => p.code !== TENANT_ADMIN_PERMISSION.code);
  if (byCode.length > 1 || otherCodes.length > 0) {
    report.permission = "CONFLICT";
    report.reason = `tenant/admin is defined ${byCode.length} time(s) as ${TENANT_ADMIN_PERMISSION.code} and ${otherCodes.length} time(s) under other code(s): ${otherCodes.map((p) => p.code).join(",") || "-"}`;
    log(`CONFLICT: ${report.reason}. Nothing written.`);
    return report;
  }
  let perm = byCode[0] || null;
  if (perm) {
    report.permission = "PRESENT";
    report.drift = permissionDrift(perm);
    log(`permission ${TENANT_ADMIN_PERMISSION.code}: present; ${report.drift.length ? `METADATA DRIFT in ${report.drift.join(",")} (reported only, not overwritten)` : "metadata canonical"}`);
  } else {
    report.permission = "MISSING";
    log(`permission ${TENANT_ADMIN_PERMISSION.code}: MISSING -> ${execute ? "creating" : "would be created"} (canonical)`);
  }
  const readPerm = await permissions.findOne({ code: "TENANT_READ" }, { projection: { _id: 1 } });
  log(`permission TENANT_READ: ${readPerm ? "present" : "MISSING (not created by this script; ASU still gets the code)"}`);

  // 5-7. ASU roles
  const asuRoles = await roles.find({ ...scope.filter, code: TENANT_ADMIN_ROLE_CODE, isActive: true }).project({ _id: 1, tenantId: 1, permissions: 1 }).toArray();
  report.asuRoles = asuRoles.length;
  const idsByCode = { TENANT_READ: readPerm && String(readPerm._id), TENANT_ADMIN: perm && String(perm._id) };
  const plan = asuRoles.map((r) => ({ role: r, missing: missingRolePermissions(r.permissions, idsByCode) })).filter((p) => p.missing.length > 0);
  report.asuNeedingChange = plan.length;
  const tally = TENANT_ADMIN_ROLE_PERMISSIONS.map((c) => `${c}=${plan.filter((p) => p.missing.includes(c)).length}`).join(" ");
  log(`ASU roles (${scope.label}): ${asuRoles.length} active; needing permissions: ${plan.length} (missing ${tally})`);

  if (!execute) {
    const required = (report.permission === "MISSING" ? 1 : 0) + plan.length;
    log(`DRY RUN: ${required} write(s) required. Re-run with --execute to apply.`);
    report.ok = true;
    report.writesRequired = required;
    return report;
  }

  if (!perm) {
    const now = new Date();
    const res = await permissions.insertOne({ ...TENANT_ADMIN_PERMISSION, createdBy: "ensure-tenant-admin", updatedBy: null, createdAt: now, updatedAt: now });
    perm = { _id: res.insertedId };
    report.permissionCreated = true;
    report.writes += 1;
  }
  for (const { role, missing } of plan) {
    const res = await roles.updateOne(
      { _id: role._id, code: TENANT_ADMIN_ROLE_CODE },
      { $addToSet: { permissions: { $each: missing } }, $set: { updatedBy: "ensure-tenant-admin", updatedAt: new Date() } }
    );
    report.rolesUpdated += res.modifiedCount;
    report.writes += res.modifiedCount;
  }
  log(`EXECUTED: permission created=${report.permissionCreated} ASU roles updated=${report.rolesUpdated}`);
  report.ok = true;
  return report;
}

module.exports = { run };

if (require.main === module) {
  const mongoose = require("mongoose");
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const ti = args.indexOf("--tenant");
  const tenant = ti >= 0 ? args[ti + 1] : undefined;
  (async () => {
    // This service's own database (MONGO_URI), the same connection the service uses.
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false });
    const report = await run(mongoose.connection.db, { execute, tenant, log: (l) => console.log(l) });
    console.log(`RESULT ok=${report.ok} executed=${report.executed} permission=${report.permission} drift=${report.drift.length} asuRoles=${report.asuRoles} asuNeedingChange=${report.asuNeedingChange} writes=${report.writes}${report.reason ? " reason=" + report.reason : ""}`);
    await mongoose.disconnect();
    process.exit(report.ok ? 0 : 1);
  })().catch((e) => {
    console.log(`RESULT ok=false error=${e && e.name}`);
    process.exit(1);
  });
}
