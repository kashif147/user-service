/**
 * P5 additive permission-catalogue change (owner-approved 2026-11-02): adds exactly four tenant
 * permissions, nothing else.
 *
 *   REGISTRATIONS_CREATE  registrations:create  PORTAL  events-service self-service registration
 *   REGISTRATIONS_READ    registrations:read    PORTAL
 *   REGISTRATIONS_WRITE   registrations:write   PORTAL
 *   DIRECTORY_READ        directory:read        CRM     user-service /api/directory/* (id + display name)
 *
 * Additive only: never renames, deletes or changes an existing permission, and never touches roles
 * (no grant to any tenant role - grants are a separate, later, reviewed change). Rows are created
 * through the Permission model, so schema validation and the platform-namespace write guard apply.
 *
 * Serialisation guard (must pass for every code before anything is written): the token form issued
 * for a role code (helpers/jwt.js: lower-case, every "_" -> ":") must equal the PDP form
 * (`${resource}:${action}`); resource and action are single lower-case tokens; the action is one the
 * PDP accepts; no wildcard; not the platform namespace.
 *
 * Refuses (nothing written) on: a guard failure; a code that already exists with different
 * semantics; the same resource:action already defined under another code; a duplicated code.
 * A code already present with identical semantics is reported PRESENT and left alone (idempotent).
 *
 * Usage (inside the user-service container; MONGO_URI from its environment, never printed):
 *   node scripts/add-p5-catalogue-permissions.js
 *       dry run (default): guard + catalogue counts/hash + planned inserts; nothing written
 *   node scripts/add-p5-catalogue-permissions.js --execute --backup /path/catalogue-before-<ts>.json
 *       apply; the full catalogue snapshot is written to --backup BEFORE any insert
 *   node scripts/add-p5-catalogue-permissions.js --remove [--execute --backup <file>]
 *       rollback: delete exactly these four codes, and only while no role references them
 * Output: codes, counts and hashes only. No URIs, user data or secrets.
 */
const fs = require("fs");
const crypto = require("crypto");
const { canonicalPermission, isPlatformNamespace } = require("../constants/permissionClassification");

const SCRIPT = "add-p5-catalogue-permissions";
// The PDP's action map (services/policyEvaluationService.js evaluateActionPolicy).
const PDP_ACTIONS = new Set(["read", "create", "write", "update", "delete", "admin"]);
const TOKEN = /^[a-z][a-z0-9]*$/;

const PERMISSIONS = Object.freeze([
  Object.freeze({
    code: "REGISTRATIONS_CREATE",
    name: "Create Own Event Registration",
    description: "Portal self-service: register the verified caller for an event or course (events-service POST /registrations)",
    resource: "registrations",
    action: "create",
    category: "PORTAL",
    level: 1,
    isSystemPermission: true,
    isActive: true,
  }),
  Object.freeze({
    code: "REGISTRATIONS_READ",
    name: "Read Own Event Registrations",
    description: "Portal self-service: read the verified caller's own registrations (events-service /registrations/mine, own by id)",
    resource: "registrations",
    action: "read",
    category: "PORTAL",
    level: 1,
    isSystemPermission: true,
    isActive: true,
  }),
  Object.freeze({
    code: "REGISTRATIONS_WRITE",
    name: "Manage Own Event Registrations",
    description: "Portal self-service: cancel / check in on the verified caller's own registration (ownership enforced by events-service)",
    resource: "registrations",
    action: "write",
    category: "PORTAL",
    level: 1,
    isSystemPermission: true,
    isActive: true,
  }),
  Object.freeze({
    code: "DIRECTORY_READ",
    name: "Read User Directory",
    description: "Resolve tenant user ids to display names and list CRM users for pickers (id + display name only)",
    resource: "directory",
    action: "read",
    category: "CRM",
    level: 10,
    isSystemPermission: true,
    isActive: true,
  }),
]);
const CODES = PERMISSIONS.map((p) => p.code);
const SEMANTIC_FIELDS = ["name", "resource", "action", "category", "level", "isSystemPermission", "isActive"];

/** Serialisation guard for one definition. Returns a list of failures (empty = pass). */
function guard(p) {
  const fails = [];
  const token = canonicalPermission(p.code);
  const pdp = `${String(p.resource).toLowerCase()}:${String(p.action).toLowerCase()}`;
  if (token !== pdp) fails.push(`TOKEN_FORM_MISMATCH token=${token} pdp=${pdp}`);
  if (!TOKEN.test(p.resource)) fails.push("RESOURCE_NOT_SINGLE_TOKEN");
  if (!TOKEN.test(p.action)) fails.push("ACTION_NOT_SINGLE_TOKEN");
  if (!PDP_ACTIONS.has(p.action)) fails.push("ACTION_NOT_PDP_EVALUABLE");
  if (p.code.includes("*") || p.resource.includes("*") || p.action.includes("*")) fails.push("WILDCARD");
  if (isPlatformNamespace(p.code) || isPlatformNamespace(p.resource)) fails.push("PLATFORM_NAMESPACE");
  return fails;
}

/** Stable fingerprint of the whole catalogue (semantic fields only, sorted by code). */
function catalogueFingerprint(docs) {
  const rows = docs
    .map((d) => [d.code, d.resource, d.action, d.category, d.level, !!d.isSystemPermission, d.isActive !== false])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
}

function drift(doc, canonical) {
  return SEMANTIC_FIELDS.filter((f) => String(doc?.[f]) !== String(canonical[f]));
}

/**
 * @param {{ Permission: import("mongoose").Model, roles: import("mongodb").Collection }} deps
 * @param {{ execute?: boolean, remove?: boolean, backup?: string, log?: (l: string) => void }} opts
 */
async function run({ Permission, roles }, { execute = false, remove = false, backup, log = () => {} } = {}) {
  const report = { ok: false, executed: execute, mode: remove ? "remove" : "add", guard: {}, permissions: {}, inserted: 0, deleted: 0 };
  const refuse = (reason) => {
    report.reason = reason;
    log(`REFUSED: ${reason}. Nothing written.`);
    return report;
  };

  for (const p of PERMISSIONS) {
    const fails = guard(p);
    report.guard[p.code] = fails.length ? fails : "PASS";
    log(`guard ${p.code}: token=${canonicalPermission(p.code)} pdp=${p.resource}:${p.action} category=${p.category} -> ${fails.length ? fails.join(",") : "PASS"}`);
  }
  if (Object.values(report.guard).some((g) => g !== "PASS")) return refuse("SERIALISATION_GUARD_FAILED");
  if (execute && !backup) return refuse("BACKUP_REQUIRED (pass --backup <file> with --execute)");

  const before = await Permission.find({}).lean();
  report.before = { count: before.length, active: before.filter((d) => d.isActive !== false).length, fingerprint: catalogueFingerprint(before) };
  log(`catalogue before: count=${report.before.count} active=${report.before.active} fingerprint=${report.before.fingerprint}`);

  const toInsert = [];
  const toDelete = [];
  for (const p of PERMISSIONS) {
    const byCode = before.filter((d) => d.code === p.code);
    const others = before.filter((d) => d.code !== p.code && String(d.resource).toLowerCase() === p.resource && String(d.action).toLowerCase() === p.action);
    const tokenClash = before.filter((d) => d.code !== p.code && (canonicalPermission(d.code) === `${p.resource}:${p.action}`));
    if (byCode.length > 1) return refuse(`DUPLICATE_CODE ${p.code}`);
    if (others.length) return refuse(`CONFLICT ${p.resource}:${p.action} already defined as ${others.map((d) => d.code).join(",")}`);
    if (tokenClash.length) return refuse(`TOKEN_CLASH ${p.resource}:${p.action} is the token form of ${tokenClash.map((d) => d.code).join(",")}`);
    if (byCode[0]) {
      const d = drift(byCode[0], p);
      if (!remove && d.length) return refuse(`EXISTS_WITH_DIFFERENT_SEMANTICS ${p.code}: ${d.join(",")}`);
      report.permissions[p.code] = "PRESENT";
      if (remove) toDelete.push(byCode[0]);
    } else {
      report.permissions[p.code] = "MISSING";
      if (!remove) toInsert.push(p);
    }
    log(`permission ${p.code}: ${report.permissions[p.code]}`);
  }

  if (remove && toDelete.length) {
    const ids = toDelete.map((d) => String(d._id));
    const referencing = await roles
      .find({ permissions: { $in: [...CODES, ...ids, ...toDelete.map((d) => d._id)] } })
      .project({ code: 1, tenantId: 1 })
      .toArray();
    if (referencing.length) return refuse(`REFERENCED_BY_ROLES ${referencing.length} role(s) still reference these codes`);
  }

  log(`plan: insert=${toInsert.length} delete=${toDelete.length}`);
  if (!execute) {
    report.ok = true;
    log("DRY RUN: nothing written.");
    return report;
  }

  fs.writeFileSync(backup, JSON.stringify({ script: SCRIPT, takenAt: new Date().toISOString(), catalogue: before }, null, 1), { flag: "wx" });
  log(`backup written (${before.length} permission documents)`);

  for (const p of toInsert) {
    await Permission.create({ ...p, createdBy: `script:${SCRIPT}`, updatedBy: `script:${SCRIPT}` });
    report.inserted += 1;
  }
  for (const d of toDelete) {
    const r = await Permission.deleteOne({ _id: d._id, code: d.code });
    report.deleted += r.deletedCount || 0;
  }

  const after = await Permission.find({}).lean();
  const beforeCodes = new Set(before.map((d) => d.code));
  const added = after.filter((d) => !beforeCodes.has(d.code)).map((d) => d.code).sort();
  const unchanged = catalogueFingerprint(after.filter((d) => beforeCodes.has(d.code) && !CODES.includes(d.code))) ===
    catalogueFingerprint(before.filter((d) => !CODES.includes(d.code)));
  report.after = { count: after.length, active: after.filter((d) => d.isActive !== false).length, fingerprint: catalogueFingerprint(after), added, preExistingUnchanged: unchanged };
  log(`catalogue after: count=${report.after.count} active=${report.after.active} fingerprint=${report.after.fingerprint} added=${added.join(",") || "-"} preExistingUnchanged=${unchanged}`);
  report.ok = unchanged;
  return report;
}

module.exports = { run, guard, catalogueFingerprint, PERMISSIONS, CODES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  (async () => {
    const mongoose = require("mongoose");
    await mongoose.connect(process.env.MONGO_URI);
    const Permission = require("../models/permission.model");
    const report = await run(
      { Permission, roles: mongoose.connection.db.collection("roles") },
      { execute: args.includes("--execute"), remove: args.includes("--remove"), backup: opt("--backup"), log: (l) => console.log(`[${SCRIPT}] ${l}`) }
    );
    console.log(`[${SCRIPT}] result ok=${report.ok} inserted=${report.inserted} deleted=${report.deleted}${report.reason ? ` reason=${report.reason}` : ""}`);
    await mongoose.disconnect();
    process.exit(report.ok ? 0 : 1);
  })().catch((e) => {
    console.error(`[${SCRIPT}] ERROR ${e.name}: ${e.message}`);
    process.exit(1);
  });
}
