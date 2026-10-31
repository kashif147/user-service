/**
 * Grants the deferred application payment-link permissions (account-service
 * docs/design/IMPLEMENTATION_PLAN.md s.6) to named CRM roles in named tenants:
 *
 *   APPLICATION_PAYMENT_LINKS_READ  -> application-payment-links:read   (profile GET /applications/:id/payment)
 *   APPLICATION_PAYMENT_LINKS_WRITE -> application-payment-links:write  (profile POST /applications/:id/payment-link)
 *
 * Without the catalogue rows the PDP answers UNKNOWN_RESOURCE; without the role grant it answers
 * INSUFFICIENT_RESOURCE_PERMISSION. Role permissions are resolved through the catalogue at token
 * time (handlers/role.handler.js getUserPermissions), so a grant reaches a user at their next
 * sign-in / token issue, and the PDP's permission cache (services/permissionsService.js) can hold
 * an empty resource lookup for up to 5 minutes.
 *
 * Permissions (identity = unique `code`):
 *   - missing and no other code defines the same resource/action -> created (canonical).
 *   - present -> semantic fields compared; drift is REPORTED, never overwritten.
 *   - the resource/action exists under another code, or a code is duplicated -> CONFLICT: nothing
 *     is written at all.
 * Roles: resolved per tenant by CODE (never by id, never by the unreliable `category` field),
 * isActive true. A permission counts as held by code or by its ObjectId string. Missing codes are
 * appended ($addToSet); nothing else on the role changes. A role code absent from a tenant is
 * reported and skipped - roles are never created. Users are never read or written.
 *
 * Usage (inside the user-service container; MONGO_URI from its environment, never printed):
 *   node scripts/grant-application-payment-links.js --tenant MULTIAUTH,DEVTENANTB --read-roles MO,REO --write-roles MO
 *       dry run (default): role inventory + planned writes, nothing written
 *   node scripts/grant-application-payment-links.js --tenant MULTIAUTH,DEVTENANTB --read-roles MO,REO --write-roles MO \
 *       --execute --backup /home/deploy-dev/backups/payment-link-roles-<ts>.json
 *       apply; the backup (affected roles' current permissions) is written BEFORE any change
 *   node scripts/grant-application-payment-links.js --tenant ... --read-roles ... --write-roles ... --revoke [--execute --backup <file>]
 *       rollback: pull exactly these two codes (and their ObjectId strings) from the named roles;
 *       catalogue rows are left in place (inert without a grant)
 *   --read-roles MO,REO   roles that get APPLICATION_PAYMENT_LINKS_READ
 *   --write-roles MO      roles that get APPLICATION_PAYMENT_LINKS_WRITE
 *                         Independent sets (a role may be in one, both or neither); at least one
 *                         is required and there is no default - role codes are never guessed.
 *                         --revoke pulls only the code(s) each named role is listed for.
 * Output: tenant codes, role codes/names/categories, counts. No URIs, user data or secrets.
 */
const fs = require("fs");

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const SCRIPT = "grant-application-payment-links";

const PERMISSIONS = Object.freeze([
  Object.freeze({
    code: "APPLICATION_PAYMENT_LINKS_READ",
    name: "Read Application Payment Links",
    description: "View an application's payment-link / payment status (profile-service GET /applications/:id/payment)",
    resource: "application-payment-links",
    action: "read",
    category: "CRM",
    level: 10,
    isSystemPermission: true,
    isActive: true,
  }),
  Object.freeze({
    code: "APPLICATION_PAYMENT_LINKS_WRITE",
    name: "Manage Application Payment Links",
    description: "Issue, resend or replace an application's Stripe payment link (profile-service POST /applications/:id/payment-link)",
    resource: "application-payment-links",
    action: "write",
    category: "CRM",
    level: 30,
    isSystemPermission: true,
    isActive: true,
  }),
]);
const CODES = PERMISSIONS.map((p) => p.code);
const READ = "APPLICATION_PAYMENT_LINKS_READ";
const WRITE = "APPLICATION_PAYMENT_LINKS_WRITE";
// Never granted by this script: wildcard/admin roles already pass, and member (PORTAL) roles must
// not get staff payment-link access (design s.6).
const REFUSED_ROLE_CODES = new Set(["SU", "ASU", "MEMBER", "NON-MEMBER"]);
const SEMANTIC_FIELDS = ["name", "resource", "action", "category", "level", "isSystemPermission", "isActive"];

function parseList(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function permissionDrift(doc, canonical) {
  return SEMANTIC_FIELDS.filter((f) => String(doc?.[f]) !== String(canonical[f]));
}

function heldCodes(rolePermissions, idsByCode) {
  const held = new Set();
  for (const p of rolePermissions || []) {
    if (typeof p !== "string") continue;
    for (const code of CODES) {
      if (p === code || (idsByCode[code] && p === idsByCode[code])) held.add(code);
    }
  }
  return held;
}

async function resolveTenants(db, selectors) {
  const tenants = db.collection("tenants");
  const out = [];
  for (const raw of selectors) {
    const t = OBJECT_ID.test(raw)
      ? await tenants.findOne({ _id: new (require("mongoose").Types.ObjectId)(raw) }, { projection: { _id: 1, code: 1, name: 1, isActive: 1, status: 1 } })
      : await tenants.findOne({ code: raw.toUpperCase() }, { projection: { _id: 1, code: 1, name: 1, isActive: 1, status: 1 } });
    if (!t) return { error: `TENANT_NOT_FOUND:${raw}` };
    out.push(t);
  }
  return { tenants: out };
}

/**
 * @param {import("mongodb").Db} db
 * @param {{tenants: string[], roles?: string[], execute?: boolean, revoke?: boolean,
 *          backup?: string, inventory?: boolean, log?: (line: string) => void}} opts
 */
async function run(db, { tenants: tenantSelectors = [], readRoles = [], writeRoles = [], execute = false, revoke = false, backup, inventory = true, log = () => {} } = {}) {
  const permissions = db.collection("permissions");
  const rolesCol = db.collection("roles");
  const report = {
    ok: false,
    executed: execute,
    mode: revoke ? "revoke" : "grant",
    permissions: {},
    drift: {},
    rolesMatched: 0,
    rolesNeedingChange: 0,
    rolesMissing: [],
    rolesUpdated: 0,
    permissionsCreated: 0,
    writes: 0,
  };
  const refuse = (reason) => {
    report.reason = reason;
    log(`REFUSED: ${reason}. Nothing written.`);
    return report;
  };

  if (!tenantSelectors.length) return refuse("TENANT_REQUIRED (pass --tenant CODE[,CODE])");
  const norm = (list) => [...new Set((list || []).map((c) => String(c).trim().toUpperCase()).filter(Boolean))];
  const readCodes = norm(readRoles);
  const writeCodes = norm(writeRoles);
  const codes = [...new Set([...readCodes, ...writeCodes])];
  if (!codes.length) return refuse("ROLES_REQUIRED (pass --read-roles and/or --write-roles)");
  // The permission code(s) each role code is named for.
  const wantedFor = (code) => [...(readCodes.includes(code) ? [READ] : []), ...(writeCodes.includes(code) ? [WRITE] : [])];
  log(`role sets: READ=${readCodes.join(",") || "-"} WRITE=${writeCodes.join(",") || "-"}`);
  const refused = codes.filter((c) => REFUSED_ROLE_CODES.has(c));
  if (refused.length) return refuse(`ROLE_NOT_ALLOWED:${refused.join(",")}`);
  if (execute && !backup) return refuse("BACKUP_REQUIRED (pass --backup <file> with --execute)");

  const scope = await resolveTenants(db, tenantSelectors);
  if (scope.error) return refuse(scope.error);
  const tenantIds = scope.tenants.flatMap((t) => [String(t._id), t._id]);
  const tenantCode = new Map(scope.tenants.map((t) => [String(t._id), t.code]));
  log(`tenants: ${scope.tenants.map((t) => `${t.code}${t.isActive === false ? "(INACTIVE)" : ""}`).join(", ")}`);

  // 1. Catalogue: by code, and conflicts on the same resource/action under another code.
  const idsByCode = {};
  for (const canonical of PERMISSIONS) {
    const byCode = await permissions.find({ code: canonical.code }).toArray();
    const sameMeaning = await permissions
      .find({ resource: canonical.resource, action: canonical.action })
      .project({ _id: 1, code: 1 })
      .toArray();
    const others = sameMeaning.filter((p) => p.code !== canonical.code);
    if (byCode.length > 1 || others.length > 0) {
      report.permissions[canonical.code] = "CONFLICT";
      return refuse(
        `CONFLICT ${canonical.resource}:${canonical.action} defined ${byCode.length}x as ${canonical.code} and under other code(s): ${others.map((p) => p.code).join(",") || "-"}`
      );
    }
    if (byCode[0]) {
      idsByCode[canonical.code] = String(byCode[0]._id);
      report.permissions[canonical.code] = "PRESENT";
      report.drift[canonical.code] = permissionDrift(byCode[0], canonical);
      log(`permission ${canonical.code}: present; ${report.drift[canonical.code].length ? `METADATA DRIFT in ${report.drift[canonical.code].join(",")} (reported only)` : "metadata canonical"}`);
    } else {
      report.permissions[canonical.code] = "MISSING";
      log(`permission ${canonical.code}: MISSING -> ${revoke ? "left missing (revoke)" : execute ? "creating" : "would be created"}`);
    }
  }

  // 2. Inventory (read-only): every active role in the named tenants, for role-code confirmation.
  if (inventory) {
    const all = await rolesCol
      .find({ tenantId: { $in: tenantIds }, isActive: true })
      .project({ tenantId: 1, code: 1, name: 1, category: 1, roleCategory: 1, permissions: 1 })
      .sort({ tenantId: 1, code: 1 })
      .toArray();
    log(`role inventory (active roles): ${all.length}`);
    for (const r of all) {
      const held = heldCodes(r.permissions, idsByCode);
      const drives = (r.permissions || []).some((p) => typeof p === "string" && /^MEMBERSHIP_DRIVES_/.test(p));
      log(
        `  ${tenantCode.get(String(r.tenantId)) || "?"} ${r.code} "${r.name}" category=${r.category}${r.roleCategory ? `/${r.roleCategory}` : ""} payLinks=${[...held].map((c) => c.replace("APPLICATION_PAYMENT_LINKS_", "")).join("+") || "-"} drives=${drives ? "Y" : "-"}${codes.includes(r.code) ? `  <- target ${wantedFor(r.code).map((c) => c.replace("APPLICATION_PAYMENT_LINKS_", "")).join("+")}` : ""}`
      );
    }
  }

  // 3. Target roles.
  const targets = await rolesCol
    .find({ tenantId: { $in: tenantIds }, code: { $in: codes }, isActive: true })
    .project({ _id: 1, tenantId: 1, code: 1, permissions: 1 })
    .toArray();
  report.rolesMatched = targets.length;
  for (const t of scope.tenants) {
    for (const c of codes) {
      if (!targets.some((r) => String(r.tenantId) === String(t._id) && r.code === c)) {
        report.rolesMissing.push(`${t.code}:${c}`);
      }
    }
  }
  if (report.rolesMissing.length) log(`role codes not found (skipped, never created): ${report.rolesMissing.join(", ")}`);

  const plan = targets
    .map((r) => {
      const held = heldCodes(r.permissions, idsByCode);
      const wanted = wantedFor(r.code);
      if (revoke) {
        const pull = [];
        for (const c of wanted) {
          if (!held.has(c)) continue;
          pull.push(c);
          if (idsByCode[c]) pull.push(idsByCode[c]);
        }
        return { role: r, change: pull };
      }
      return { role: r, change: wanted.filter((c) => !held.has(c)) };
    })
    .filter((p) => p.change.length > 0);
  report.rolesNeedingChange = plan.length;
  for (const p of plan) {
    log(`  ${revoke ? "revoke" : "grant"} ${tenantCode.get(String(p.role.tenantId))} ${p.role.code}: ${p.change.filter((c) => !OBJECT_ID.test(c)).join(", ")}`);
  }

  const catalogueWrites = revoke ? 0 : PERMISSIONS.filter((p) => report.permissions[p.code] === "MISSING").length;
  if (!execute) {
    report.writesRequired = catalogueWrites + plan.length;
    log(`DRY RUN: ${report.writesRequired} write(s) required. Re-run with --execute --backup <file> to apply.`);
    report.ok = true;
    return report;
  }

  // 4. Backup BEFORE any write (affected roles' current permission arrays).
  const snapshot = await rolesCol
    .find({ _id: { $in: plan.map((p) => p.role._id) } })
    .project({ _id: 1, tenantId: 1, code: 1, permissions: 1 })
    .toArray();
  fs.writeFileSync(
    backup,
    JSON.stringify({ script: SCRIPT, mode: report.mode, takenAt: new Date().toISOString(), roles: snapshot }, null, 2),
    { flag: "wx", mode: 0o600 }
  );
  log(`backup written: ${snapshot.length} role(s)`);

  if (!revoke) {
    for (const canonical of PERMISSIONS) {
      if (report.permissions[canonical.code] !== "MISSING") continue;
      const now = new Date();
      const res = await permissions.updateOne(
        { code: canonical.code },
        { $setOnInsert: { ...canonical, createdBy: SCRIPT, updatedBy: null, createdAt: now, updatedAt: now } },
        { upsert: true }
      );
      report.permissionsCreated += res.upsertedCount;
      report.writes += res.upsertedCount;
    }
  }
  for (const { role, change } of plan) {
    const update = revoke
      ? { $pull: { permissions: { $in: change } }, $set: { updatedBy: SCRIPT, updatedAt: new Date() } }
      : { $addToSet: { permissions: { $each: change } }, $set: { updatedBy: SCRIPT, updatedAt: new Date() } };
    const res = await rolesCol.updateOne({ _id: role._id, tenantId: role.tenantId, code: role.code }, update);
    report.rolesUpdated += res.modifiedCount;
    report.writes += res.modifiedCount;
  }
  log(`EXECUTED (${report.mode}): permissions created=${report.permissionsCreated} roles updated=${report.rolesUpdated}`);
  report.ok = true;
  return report;
}

module.exports = { run, PERMISSIONS };

if (require.main === module) {
  const mongoose = require("mongoose");
  const args = process.argv.slice(2);
  const val = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const opts = {
    tenants: parseList(val("--tenant")),
    readRoles: parseList(val("--read-roles")),
    writeRoles: parseList(val("--write-roles")),
    execute: args.includes("--execute"),
    revoke: args.includes("--revoke"),
    backup: val("--backup"),
    log: (l) => console.log(l),
  };
  (async () => {
    // This service's own database (MONGO_URI), the same connection the service uses.
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false });
    const r = await run(mongoose.connection.db, opts);
    console.log(
      `RESULT ok=${r.ok} mode=${r.mode} executed=${r.executed} rolesMatched=${r.rolesMatched} rolesNeedingChange=${r.rolesNeedingChange} missingRoles=${r.rolesMissing.length} writes=${r.writes}${r.writesRequired !== undefined ? ` writesRequired=${r.writesRequired}` : ""}${r.reason ? " reason=" + r.reason : ""}`
    );
    await mongoose.disconnect();
    process.exit(r.ok ? 0 : 1);
  })().catch((e) => {
    console.log(`RESULT ok=false error=${e && e.name}`);
    process.exit(1);
  });
}
