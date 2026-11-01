#!/usr/bin/env node
/**
 * Phase B / Z9: retire the legacy TENANT SU role - migrate every tenant's SU holders to that tenant's ASU.
 *
 * ASU is the highest tenant role (the explicit own-tenant administrator, services/policyEvaluationService.js
 * Rule 1). Per tenant, idempotently (safe to run again: a tenant without an SU role is a no-op):
 *   1. locate the tenant's SU role(s) and its single ASU role (reused; created only when the tenant has SU but
 *      no ASU; more than one ASU -> the tenant is BLOCKED, nothing written);
 *   2. compare permissions and add to ASU the SU entries ASU lacks (the legitimate tenant permission-code
 *      union). Never "*", never a platform-namespace or reserved permission (those are skipped and reported);
 *      ASU's own entries are never removed;
 *   3. give every holder of SU in that tenant the ASU role (no duplicate assignment) and remove SU from them -
 *      tenant-qualified writes only; User ownership is never touched (Z7/Z8 guard);
 *   4. default-role references: a connection whose defaultRoleId is the SU role BLOCKS the tenant (ASU is not
 *      a valid default role either - reported for an owner decision, nothing rewritten);
 *   5. invalidate that tenant's role / permission caches (the PDP decision cache is versioned by the Z9 epoch);
 *   6. verify no user of the tenant still holds SU;
 *   7. delete the SU role only when nothing references it any more (users, connections).
 * Nothing crosses tenants: every query carries the tenant; roles/permissions are never copied between tenants.
 *
 * Audit: each tenant that changes (or is blocked) -> tenant.lifecycle.changed.v1 action TENANT_ROLE_MIGRATED
 * (tenant-owned audit_logs row, actor_scope "system", actor "platform:migration"): counts and status
 * only - no user ids, emails or permission lists. A JSON backup of every SU role document and every affected
 * user's previous role list (ids only) is written to --backup for rollback.
 *
 * Usage (inside the service container, cwd /app):
 *   node scripts/migrate-su-to-asu.js                 # dry run (default): what would change, nothing written
 *   node scripts/migrate-su-to-asu.js --execute --backup /tmp/z9-su-backup.json --by <label> --approval <ref>
 * Output: tenant codes, masked ids, counts and permission codes only.
 */
const fs = require("fs");
const crypto = require("crypto");
const mongoose = require("mongoose");
const Tenant = require("../models/tenant.model");
const User = require("../models/user.model");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");
const { canonicalPermission, isPlatformNamespace, isLegacyReservedPermission, TENANT_WILDCARD } = require("../constants/permissionClassification");

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const m6 = (v) => (v ? "…" + String(v).slice(-6) : "-");
const out = (s) => console.log(`[su->asu] ${s}`);

function parseArgs(argv) {
  const o = { execute: false, backup: null, by: null, approval: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") o.execute = true;
    else if (a === "--backup") o.backup = argv[++i];
    else if (a === "--by") o.by = argv[++i];
    else if (a === "--approval") o.approval = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.execute && (!o.backup || !o.by || !o.approval)) throw new Error("--execute requires --backup, --by and --approval");
  return o;
}

async function canonicalMap(entries) {
  const list = (entries || []).map((e) => String(e).trim()).filter(Boolean);
  const ids = list.filter((e) => OBJECT_ID.test(e));
  const byId = new Map();
  if (ids.length) {
    for (const d of await Permission.find({ _id: { $in: ids } }).select("code resource action").lean()) {
      byId.set(String(d._id), d.resource && d.action ? `${d.resource}:${d.action}`.toLowerCase() : canonicalPermission(d.code));
    }
  }
  return list.map((e) => ({ entry: e, canonical: OBJECT_ID.test(e) ? byId.get(e) || `unresolved:${e}` : canonicalPermission(e) }));
}

const notGrantable = (c) => c === TENANT_WILDCARD || c === "*" || isPlatformNamespace(c) || isLegacyReservedPermission(c) || c.startsWith("unresolved:");

async function migrateTenant(tenant, opts, runId, backup) {
  const tid = String(tenant._id);
  const su = await Role.find({ tenantId: tid, code: "SU" }).lean();
  if (!su.length) return { tenant: tenant.code, outcome: "noop", reason: "no_su_role" };
  const suIds = su.map((r) => r._id);
  const asu = await Role.find({ tenantId: tid, code: "ASU" }).lean();
  if (asu.length > 1) return { tenant: tenant.code, outcome: "blocked", reason: "multiple_asu_roles" };

  const conns = (tenant.authenticationConnections || []).filter((c) => c.defaultRoleId && suIds.map(String).includes(String(c.defaultRoleId)));
  if (conns.length) return { tenant: tenant.code, outcome: "blocked", reason: "connection_default_role_is_su", affectedConnections: conns.length };

  // 2. permission union (ASU keeps all of its own entries; SU entries ASU lacks are added unless not grantable)
  const suPerms = await canonicalMap(su.flatMap((r) => r.permissions || []));
  const asuPerms = asu[0] ? await canonicalMap(asu[0].permissions || []) : [];
  const have = new Set(asuPerms.map((p) => p.canonical));
  const toAdd = [], skipped = [];
  for (const p of suPerms) {
    if (have.has(p.canonical)) continue;
    if (notGrantable(p.canonical)) { skipped.push(p.canonical); continue; }
    have.add(p.canonical);
    toAdd.push(p.entry);
  }
  const holders = await User.find({ tenantId: tid, roles: { $in: suIds } }).select({ _id: 1, roles: 1 }).lean();
  const plan = {
    tenant: tenant.code, tenantId: m6(tid), suRoles: su.length, asuRole: asu[0] ? m6(asu[0]._id) : "create",
    holders: holders.length, permissionsAdded: toAdd.length, addedCodes: [...new Set((await canonicalMap(toAdd)).map((p) => p.canonical))].sort(),
    skippedNotGrantable: [...new Set(skipped)].sort(),
  };
  if (!opts.execute) return { ...plan, outcome: "dry_run" };

  backup.tenants.push({ tenantId: tid, suRoles: su, asuBefore: asu[0] || null, users: holders.map((u) => ({ _id: String(u._id), roles: (u.roles || []).map(String) })) });
  fs.writeFileSync(opts.backup, JSON.stringify(backup, null, 1)); // durable before the first write

  // 1b. the ASU role (reused; created from SU's grantable entries only if the tenant has none)
  let asuId = asu[0] && asu[0]._id;
  if (!asuId) {
    const created = await Role.create({
      tenantId: tid, code: "ASU", name: "Assistant Super User", description: "Tenant administrator (highest tenant role)",
      category: su[0].category || "SYSTEM", isSystemRole: true, level: 95, isActive: true, permissions: toAdd, createdBy: "platform:migration",
    });
    asuId = created._id;
  } else if (toAdd.length) {
    await Role.updateOne({ _id: asuId, tenantId: tid, code: "ASU" }, { $addToSet: { permissions: { $each: toAdd } }, $set: { updatedBy: "platform:migration" } });
  }
  // 3. assignments: add ASU, then remove SU (both tenant-qualified; idempotent)
  const added = await User.updateMany({ tenantId: tid, roles: { $in: suIds } }, { $addToSet: { roles: asuId } });
  const pulled = await User.updateMany({ tenantId: tid, roles: { $in: suIds } }, { $pull: { roles: { $in: suIds } } });
  // 5. caches of this tenant
  try {
    await require("../services/roleHierarchyService").clearCache(tid);
    await require("../services/permissionsService").clearCache();
    await require("../services/cacheInvalidationService").invalidateTenantCache(tid);
  } catch (e) { out(`  cache invalidation warning: ${e.name}`); }
  // 6. verify, 7. retire
  const stillSU = await User.countDocuments({ tenantId: tid, roles: { $in: suIds } });
  const dupASU = await User.countDocuments({ tenantId: tid, $expr: { $gt: [{ $size: { $filter: { input: "$roles", cond: { $eq: ["$$this", asuId] } } } }, 1] } });
  let retired = 0;
  if (stillSU === 0) retired = (await Role.deleteMany({ _id: { $in: suIds }, tenantId: tid, code: "SU" })).deletedCount;
  return {
    ...plan, outcome: stillSU === 0 && retired === su.length ? "migrated" : "partial",
    usersGivenASU: added.modifiedCount, usersSURemoved: pulled.modifiedCount, stillSU, duplicateASUAssignments: dupASU, suRolesRetired: retired,
  };
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  await require("../config/db").mongooseConnection();
  const runId = `z9-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
  out(`run=${runId} mode=${opts.execute ? "EXECUTE" : "dry-run"}${opts.execute ? ` by=${opts.by} approval=${opts.approval}` : ""}`);
  const backup = { runId, at: new Date().toISOString(), by: opts.by, approval: opts.approval, tenants: [] };
  const results = [];
  for (const tenant of await Tenant.find({}).select({ _id: 1, code: 1, authenticationConnections: 1 }).lean()) {
    let r;
    try { r = await migrateTenant(tenant, opts, runId, backup); } catch (e) { r = { tenant: tenant.code, outcome: "error", reason: e.name }; }
    results.push({ tid: String(tenant._id), r });
    out(JSON.stringify(r));
  }
  if (opts.execute) {
    const audited = results.filter(({ r }) => ["migrated", "partial", "blocked", "error"].includes(r.outcome));
    if (audited.length) {
      await require("../rabbitMQ").initEventSystem(); // publisher only
      const { auditTenantRoleMigration } = require("../services/platformAuditService");
      for (const { tid, r } of audited) {
        const ok = await auditTenantRoleMigration({
          tenantId: tid, outcome: r.outcome, affectedUsers: r.holders || 0, affectedConnections: r.affectedConnections || 0,
          permissionsAdded: r.permissionsAdded || 0, suRolesRetired: r.suRolesRetired || 0, runId,
        });
        out(`audit ${r.tenant}: ${ok ? "published" : "NOT PUBLISHED (change persisted; see backup)"}`);
      }
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  const remaining = await Role.countDocuments({ code: "SU" });
  const holders = await User.countDocuments({ roles: { $in: (await Role.find({ code: "SU" }).select({ _id: 1 }).lean()).map((r) => r._id) } });
  out(`end: SU roles remaining=${remaining} users holding SU=${holders}`);
  await mongoose.disconnect();
  process.exit(results.some(({ r }) => ["blocked", "error", "partial"].includes(r.outcome)) ? 2 : 0);
})().catch((e) => { console.log("[su->asu] ERROR", e.name, String(e.message).slice(0, 160)); process.exit(1); });
