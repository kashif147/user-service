/**
 * PDP rollout P1 - additive, inert permission-catalogue change (bounded-pdp-implementation-proposal §1 P1,
 * §2a). Adds exactly these nine tenant permissions, nothing else:
 *
 *   PAYMENTS.BANK_READ          payments.bank:read          CRM      audience CRM
 *   TENANT.AUTH_READ            tenant.auth:read            CRM      audience CRM
 *   REPORTING.STATISTICS_READ   reporting.statistics:read   CRM      audience CRM
 *   REPORTING.LISTINGS_READ     reporting.listings:read     CRM      audience CRM
 *   REPORTING.FINANCE_READ      reporting.finance:read      CRM      audience CRM
 *   REPORTING.TEMPLATES_READ    reporting.templates:read    CRM      audience CRM
 *   REPORTING.TEMPLATES_WRITE   reporting.templates:write   CRM      audience CRM
 *   ACCOUNTS.MEMBER_READ        accounts.member:read        ACCOUNT  audience BOTH
 *   CONTACT_READ                contact:read                CRM      audience CRM
 *
 * Inert: no role is granted anything (grants are a separate, reviewed change), and the evaluator ignores
 * `audience` until P4/P5. Never renames, changes, deactivates or deletes an existing permission. Rows are
 * created through the Permission model, so schema validation (incl. the audience enum) and the
 * platform-namespace write guard apply.
 *
 * Serialisation guard (every code, before anything is read or written): the token form issued for the code
 * (constants/permissionClassification canonicalPermission, as helpers/jwt.js: lower-case, "_" -> ":") must
 * equal the PDP form `${resource}:${action}`; the code has exactly one "_" (the resource/action boundary);
 * resource is lower-case with at most one "." (the live accounts.reports precedent; "." survives both
 * transforms, only "_" is rewritten); action is a single lower-case word the PDP accepts; no wildcard; not the platform namespace; no
 * duplicate code / resource:action / token inside the nine.
 *
 * Refuses (nothing written) on any collision with the live catalogue:
 *   CONFLICT              the same resource:action already defined under another code
 *   TOKEN_CLASH           another code whose token form (code transform) equals one of the new tokens
 *   EXISTS_WITH_DIFFERENT_SEMANTICS  one of the nine codes present with different fields
 *   DUPLICATE_CODE        a code present more than once
 * A code already present with identical semantics is PRESENT and left alone (idempotent).
 *
 * Usage (inside the user-service container; MONGO_URI from its environment, never printed):
 *   node scripts/add-p6-catalogue-permissions.js [--dry-run]
 *       default: guard + catalogue counts/fingerprint + planned inserts + collisions; READ-ONLY (the
 *       database handles are wrapped so any write method throws)
 *   node scripts/add-p6-catalogue-permissions.js --apply --out-dir <dir>
 *       backup of the full catalogue + ledger (planned codes) written BEFORE any insert (never overwrites)
 *   node scripts/add-p6-catalogue-permissions.js --rollback <ledger.json> [--apply]
 *       dry run unless --apply. For each row the ledger inserted: still exactly as inserted and referenced by
 *       no role -> deleted; referenced by a role -> deactivated (isActive:false, so tokens drop it at once);
 *       modified since insert -> kept and reported. Nothing outside the ledger is touched.
 * Output: codes, counts and hashes only. No URIs, user data or secrets.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { canonicalPermission, isPlatformNamespace } = require("../constants/permissionClassification");

const SCRIPT = "add-p6-catalogue-permissions";
// The PDP's action map (services/policyEvaluationService.js evaluateActionPolicy).
const PDP_ACTIONS = new Set(["read", "create", "write", "update", "delete", "admin"]);
const RESOURCE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$/;
const ACTION_RE = /^[a-z]+$/;
const AUDIENCES = ["CRM", "PORTAL", "BOTH"];

const def = (code, resource, action, category, audience, name, description) =>
  Object.freeze({ code, name, description, resource, action, category, audience, level: 1, isSystemPermission: false, isActive: true });

const PERMISSIONS = Object.freeze([
  def("PAYMENTS.BANK_READ", "payments.bank", "read", "CRM", "CRM", "Read Bank Details",
    "Plaintext debtor IBAN/BIC and SEPA files: direct-debit run read routes (incl. PAIN.008 download), payment-form full detail/PDF, mandates-for-prepare; organisation banking fields on GET /tenants/:id"),
  def("TENANT.AUTH_READ", "tenant.auth", "read", "CRM", "CRM", "Read Authentication Configuration",
    "Tenant authentication connections, connection status, default-role options and security settings (password policy, session timeout, self-registration, max users)"),
  def("REPORTING.STATISTICS_READ", "reporting.statistics", "read", "CRM", "CRM", "Read Membership Statistics",
    "Aggregate reports: dashboard, comparison, live stats, statistics, workplace breakdown, year reconciliation (counts)"),
  def("REPORTING.LISTINGS_READ", "reporting.listings", "read", "CRM", "CRM", "Read Membership Listings",
    "Row-level member listings (presets new-members/joiners/resigned/cancelled/active/suspended/archived/lapsed; listing)"),
  def("REPORTING.FINANCE_READ", "reporting.finance", "read", "CRM", "CRM", "Read Financial Reports",
    "Creditors list and debtors list (per-member balances with names/addresses)"),
  def("REPORTING.TEMPLATES_READ", "reporting.templates", "read", "CRM", "CRM", "Read Report Views",
    "Saved report views (Save View) - list/get/default"),
  def("REPORTING.TEMPLATES_WRITE", "reporting.templates", "write", "CRM", "CRM", "Manage Report Views",
    "Create/update/delete own saved report views"),
  def("ACCOUNTS.MEMBER_READ", "accounts.member", "read", "ACCOUNT", "BOTH", "Read Member Account",
    "A member's own account (portal, ownership-enforced) or a member's account in CRM: statement, net balance, summary, ledger, credit notes, ledger actions"),
  def("CONTACT_READ", "contact", "read", "CRM", "CRM", "Read Contacts",
    "Read the contacts / service-provider reference list (user-service GET /contacts, /contact-types), used by the complaint form"),
]);
const CODES = PERMISSIONS.map((p) => p.code);
const SEMANTIC_FIELDS = ["name", "resource", "action", "category", "audience", "level", "isSystemPermission", "isActive"];

const pdpForm = (p) => `${String(p.resource).toLowerCase()}:${String(p.action).toLowerCase()}`;

/** Serialisation guard for one definition. Returns a list of failures (empty = pass). */
function guard(p) {
  const fails = [];
  const token = canonicalPermission(p.code);
  const pdp = pdpForm(p);
  if (token !== pdp) fails.push(`TOKEN_FORM_MISMATCH token=${token} pdp=${pdp}`);
  if (p.code !== String(p.code).trim().toUpperCase()) fails.push("CODE_NOT_UPPERCASE");
  if ((String(p.code).match(/_/g) || []).length !== 1) fails.push("CODE_NOT_ONE_UNDERSCORE");
  if (!RESOURCE_RE.test(p.resource)) fails.push("RESOURCE_FORMAT");
  if (!ACTION_RE.test(p.action)) fails.push("ACTION_NOT_SINGLE_TOKEN");
  if (!PDP_ACTIONS.has(p.action)) fails.push("ACTION_NOT_PDP_EVALUABLE");
  if ([p.code, p.resource, p.action].some((v) => String(v).includes("*"))) fails.push("WILDCARD");
  if (isPlatformNamespace(p.code) || isPlatformNamespace(p.resource) || isPlatformNamespace(pdp)) fails.push("PLATFORM_NAMESPACE");
  if (p.audience !== undefined && !AUDIENCES.includes(p.audience)) fails.push("AUDIENCE_INVALID");
  return fails;
}

/** Guard for the set: no duplicate code, resource:action or token inside the definitions. */
function guardSet(defs) {
  const fails = [];
  for (const [label, key] of [["CODE", (p) => p.code], ["RESOURCE_ACTION", pdpForm], ["TOKEN", (p) => canonicalPermission(p.code)]]) {
    const seen = new Map();
    for (const p of defs) {
      const k = key(p);
      if (seen.has(k)) fails.push(`DUPLICATE_${label} ${k} (${seen.get(k)},${p.code})`);
      else seen.set(k, p.code);
    }
  }
  return fails;
}

/** Stable fingerprint of a catalogue (semantic fields only, sorted by code). */
function catalogueFingerprint(docs) {
  const rows = docs
    .map((d) => [d.code, d.resource, d.action, d.category, d.audience ?? null, d.level, !!d.isSystemPermission, d.isActive !== false])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
}

function rowHash(d) {
  return crypto.createHash("sha256").update(JSON.stringify(SEMANTIC_FIELDS.map((f) => d?.[f] ?? null).concat([d?.code ?? null]))).digest("hex");
}

function drift(doc, canonical) {
  return SEMANTIC_FIELDS.filter((f) => String(doc?.[f]) !== String(canonical[f]));
}

const WRITE_METHODS = ["create", "insertMany", "insertOne", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany", "findOneAndUpdate", "findOneAndDelete", "findByIdAndUpdate", "findByIdAndDelete", "bulkWrite", "save", "drop"];

/** Dry-run guarantee: expose read methods only; every write method throws before reaching the driver. */
function readOnly(obj, label) {
  return new Proxy(obj, {
    get(target, prop) {
      if (WRITE_METHODS.includes(prop)) {
        return () => {
          throw new Error(`READ_ONLY_VIOLATION ${label}.${String(prop)} in dry-run`);
        };
      }
      return target[prop];
    },
  });
}

/** Collisions of the definitions with the live catalogue (pure; used by plan and tests). */
function collisions(catalogue) {
  const out = [];
  const status = {};
  for (const p of PERMISSIONS) {
    const token = canonicalPermission(p.code);
    const byCode = catalogue.filter((d) => String(d.code).trim().toUpperCase() === p.code);
    const sameRA = catalogue.filter((d) => String(d.code).trim().toUpperCase() !== p.code && pdpForm(d) === pdpForm(p));
    const tokenClash = catalogue.filter((d) => String(d.code).trim().toUpperCase() !== p.code && canonicalPermission(d.code) === token);
    if (byCode.length > 1) out.push(`DUPLICATE_CODE ${p.code}`);
    if (sameRA.length) out.push(`CONFLICT ${pdpForm(p)} already defined as ${sameRA.map((d) => d.code).join(",")}`);
    if (tokenClash.length) out.push(`TOKEN_CLASH ${token} is the token form of ${tokenClash.map((d) => d.code).join(",")}`);
    if (byCode.length === 1) {
      const d = drift(byCode[0], p);
      if (d.length) out.push(`EXISTS_WITH_DIFFERENT_SEMANTICS ${p.code}: ${d.join(",")}`);
      status[p.code] = "PRESENT";
    } else if (byCode.length === 0) {
      status[p.code] = "MISSING";
    }
  }
  return { collisions: out, status };
}

function writeNew(file, data) {
  fs.writeFileSync(file, data, { flag: "wx" }); // never overwrite an existing backup/ledger
}

/**
 * @param {{ Permission: import("mongoose").Model, roles: import("mongodb").Collection }} deps
 * @param {{ apply?: boolean, outDir?: string, rollback?: string, log?: (l: string) => void, now?: () => Date }} opts
 */
async function run(deps, { apply = false, outDir, rollback, log = () => {}, now = () => new Date() } = {}) {
  const mode = rollback ? "rollback" : "add";
  const report = { ok: false, applied: apply, mode, guard: {}, permissions: {}, collisions: [], inserted: 0, deleted: 0, deactivated: 0 };
  const refuse = (reason) => {
    report.reason = reason;
    log(`REFUSED: ${reason}. Nothing written.`);
    return report;
  };
  const { Permission, roles } = apply ? deps : { Permission: readOnly(deps.Permission, "Permission"), roles: readOnly(deps.roles, "roles") };

  for (const p of PERMISSIONS) {
    const fails = guard(p);
    report.guard[p.code] = fails.length ? fails : "PASS";
    log(`guard ${p.code}: token=${canonicalPermission(p.code)} pdp=${pdpForm(p)} category=${p.category} audience=${p.audience} -> ${fails.length ? fails.join(",") : "PASS"}`);
  }
  const setFails = guardSet(PERMISSIONS);
  if (setFails.length) report.guard.SET = setFails;
  if (Object.values(report.guard).some((g) => g !== "PASS")) return refuse("SERIALISATION_GUARD_FAILED");

  if (mode === "rollback") return runRollback({ Permission, roles }, { apply, ledgerFile: rollback, log, report, refuse });

  if (apply && !outDir) return refuse("OUT_DIR_REQUIRED (pass --out-dir <dir> with --apply)");

  const before = await Permission.find({}).lean();
  report.before = { count: before.length, active: before.filter((d) => d.isActive !== false).length, fingerprint: catalogueFingerprint(before) };
  log(`catalogue before: count=${report.before.count} active=${report.before.active} fingerprint=${report.before.fingerprint}`);

  const { collisions: found, status } = collisions(before);
  report.permissions = status;
  report.collisions = found;
  for (const p of PERMISSIONS) log(`permission ${p.code}: ${status[p.code] || "AMBIGUOUS"}`);
  log(`collisions: ${found.length}${found.length ? ` -> ${found.join("; ")}` : ""}`);
  if (found.length) return refuse(found[0].split(" ")[0]);

  const toInsert = PERMISSIONS.filter((p) => status[p.code] === "MISSING");
  report.planned = toInsert.map((p) => p.code);
  log(`plan: insert=${toInsert.length} [${report.planned.join(",") || "-"}] present=${PERMISSIONS.length - toInsert.length}`);
  if (!apply) {
    report.ok = true;
    log("DRY RUN: nothing written.");
    return report;
  }

  const runId = now().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(outDir, `${SCRIPT}-backup-${runId}.json`);
  const ledgerFile = path.join(outDir, `${SCRIPT}-ledger-${runId}.json`);
  const backupJson = JSON.stringify({ script: SCRIPT, takenAt: now().toISOString(), catalogue: before }, null, 1);
  writeNew(backupFile, backupJson);
  const ledger = {
    script: SCRIPT,
    runId,
    status: "planned",
    backup: { file: path.basename(backupFile), sha256: crypto.createHash("sha256").update(backupJson).digest("hex"), count: before.length },
    planned: report.planned,
    inserted: [],
  };
  writeNew(ledgerFile, JSON.stringify(ledger, null, 2));
  const saveLedger = () => fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  report.ledgerFile = ledgerFile;
  report.backupFile = backupFile;
  log(`backup written (${before.length} permission documents); ledger written (planned ${report.planned.length})`);

  for (const p of toInsert) {
    try {
      const doc = await Permission.create({ ...p, createdBy: `script:${SCRIPT}`, updatedBy: `script:${SCRIPT}` });
      ledger.inserted.push({ id: String(doc._id), code: p.code, hash: rowHash(p) });
      report.inserted += 1;
      saveLedger();
    } catch (err) {
      ledger.status = "failed";
      ledger.error = `${err.name}${err.code ? ` ${err.code}` : ""}`;
      saveLedger();
      return refuse(`INSERT_FAILED ${p.code} ${ledger.error} (ledger records ${ledger.inserted.length} insert(s); roll back with it)`);
    }
  }

  const after = await Permission.find({}).lean();
  const beforeCodes = new Set(before.map((d) => d.code));
  const added = after.filter((d) => !beforeCodes.has(d.code)).map((d) => d.code).sort();
  const unchanged =
    catalogueFingerprint(after.filter((d) => beforeCodes.has(d.code))) === catalogueFingerprint(before);
  report.after = { count: after.length, active: after.filter((d) => d.isActive !== false).length, fingerprint: catalogueFingerprint(after), added, preExistingUnchanged: unchanged };
  ledger.status = unchanged ? "applied" : "applied-with-verification-errors";
  ledger.verification = report.after;
  saveLedger();
  log(`catalogue after: count=${report.after.count} active=${report.after.active} fingerprint=${report.after.fingerprint} added=${added.join(",") || "-"} preExistingUnchanged=${unchanged}`);
  report.ok = unchanged;
  return report;
}

async function runRollback({ Permission, roles }, { apply, ledgerFile, log, report, refuse }) {
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  } catch (e) {
    return refuse(`LEDGER_UNREADABLE ${e.name}`);
  }
  if (ledger.script !== SCRIPT || !Array.isArray(ledger.inserted)) return refuse("LEDGER_NOT_FROM_THIS_SCRIPT");
  const foreign = ledger.inserted.filter((r) => !CODES.includes(r.code));
  if (foreign.length) return refuse(`LEDGER_CODE_OUTSIDE_SCOPE ${foreign.map((r) => r.code).join(",")}`);

  const actions = [];
  for (const rec of ledger.inserted) {
    const docs = await Permission.find({ _id: rec.id, code: rec.code }).lean();
    const doc = docs[0];
    if (!doc) {
      actions.push({ code: rec.code, action: "GONE" });
      continue;
    }
    if (rowHash(doc) !== rec.hash) {
      actions.push({ code: rec.code, action: "KEPT_MODIFIED" });
      continue;
    }
    const referencing = await roles
      .find({ permissions: { $in: [rec.code, rec.id, doc._id] } })
      .project({ code: 1, tenantId: 1 })
      .toArray();
    actions.push({ code: rec.code, action: referencing.length ? "DEACTIVATE" : "DELETE", referencedBy: referencing.length, doc });
  }
  report.rollback = actions.map(({ code, action, referencedBy }) => ({ code, action, referencedBy: referencedBy || 0 }));
  for (const a of report.rollback) log(`rollback ${a.code}: ${a.action}${a.referencedBy ? ` (referenced by ${a.referencedBy} role(s))` : ""}`);
  if (!apply) {
    report.ok = true;
    log("DRY RUN: nothing written.");
    return report;
  }
  for (const a of actions) {
    if (a.action === "DELETE") {
      const r = await Permission.deleteOne({ _id: a.doc._id, code: a.code });
      report.deleted += r.deletedCount || 0;
    } else if (a.action === "DEACTIVATE") {
      const r = await Permission.updateOne({ _id: a.doc._id, code: a.code }, { $set: { isActive: false, updatedBy: `script:${SCRIPT}:rollback`, updatedAt: new Date() } });
      report.deactivated += r.modifiedCount || 0;
    }
  }
  log(`rollback applied: deleted=${report.deleted} deactivated=${report.deactivated}`);
  report.ok = true;
  return report;
}

/** CLI argument parsing; refuses unknown or contradictory flags. */
function parseArgs(argv) {
  const out = { apply: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--out-dir") out.outDir = argv[(i += 1)];
    else if (a.startsWith("--out-dir=")) out.outDir = a.slice("--out-dir=".length);
    else if (a === "--rollback") out.rollback = argv[(i += 1)];
    else if (a.startsWith("--rollback=")) out.rollback = a.slice("--rollback=".length);
    else throw new Error(`UNKNOWN_ARGUMENT ${a}`);
  }
  if (out.apply && out.dryRun) throw new Error("CONTRADICTORY_FLAGS --apply and --dry-run");
  if (out.rollback === undefined && argv.some((a) => a === "--rollback")) throw new Error("ROLLBACK_LEDGER_REQUIRED");
  return out;
}

/** Strip anything URI-like from an error message before printing it. */
const safeMessage = (m) => String(m || "").replace(/mongodb(\+srv)?:\/\/\S+/gi, "<uri>");

module.exports = { run, guard, guardSet, collisions, catalogueFingerprint, rowHash, parseArgs, readOnly, safeMessage, PERMISSIONS, CODES, SCRIPT };

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const mongoose = require("mongoose");
    await mongoose.connect(process.env.MONGO_URI);
    const Permission = require("../models/permission.model");
    const report = await run(
      { Permission, roles: mongoose.connection.db.collection("roles") },
      { apply: args.apply, outDir: args.outDir, rollback: args.rollback, log: (l) => console.log(`[${SCRIPT}] ${l}`) }
    );
    console.log(`[${SCRIPT}] result ok=${report.ok} mode=${report.mode} applied=${report.applied} inserted=${report.inserted} deleted=${report.deleted} deactivated=${report.deactivated}${report.reason ? ` reason=${report.reason}` : ""}`);
    await mongoose.disconnect();
    process.exit(report.ok ? 0 : 1);
  })().catch((e) => {
    console.error(`[${SCRIPT}] ERROR ${e.name}: ${safeMessage(e.message)}`);
    process.exit(1);
  });
}
