/**
 * PDP rollout P5 - permission audience back-fill (bounded-pdp-implementation-proposal §2b). Writes ONLY the
 * `audience` field of ACTIVE tenant catalogue rows, so that P5 enforcement can read audiences from the catalogue
 * alone:
 *   - a code in constants/permissionAudience.js PROPOSED_AUDIENCE -> its audience (CRM | PORTAL | BOTH);
 *   - every other ACTIVE row -> "LEGACY" (deliberately left on the legacy per-resource category rule; the
 *     evaluator can then tell an intentional legacy row from a row whose audience is missing or invalid).
 * Inactive rows are never touched (reported). Platform-namespace rows are never touched (reported).
 *
 * Refuses (nothing written, non-zero exit) on:
 *   STORED_CONFLICT        an active row already carries an audience different from the planned one
 *   ALIAS_CONFLICT         active rows sharing one resource:action (case-insensitive) would get different values
 *   INVALID_PLANNED_VALUE  a planned value outside CRM | PORTAL | BOTH | LEGACY
 *   MAP_CODE_MISSING       a PROPOSED_AUDIENCE code with no active catalogue row
 *   DUPLICATE_CODE         a code present on more than one row
 *   PLATFORM_NAMESPACE     a PROPOSED_AUDIENCE code whose row is in the platform namespace
 *
 * Writes go through the native `permissions` collection (only `audience`, `updatedAt`, `updatedBy`), so the
 * Permission model's audience enum must already accept "LEGACY" in the DEPLOYED user-service before --apply
 * (otherwise a later model save of a LEGACY row would fail validation). After --apply the catalogue cache must be
 * cleared or expire (permissionsService.clearCache, 5 minutes, or a user-service recreate) before enforcement.
 *
 * Usage (inside the user-service container; MONGO_URI from its environment, never printed):
 *   node scripts/backfill-permission-audience.js [--dry-run] [--export <file>]
 *       default: READ-ONLY (the collection handle is wrapped so every write method throws). Prints every planned
 *       row, counts, alias groups and the before / predicted-after fingerprints; --export writes the proposed
 *       active catalogue (code, resource, action, category, planned audience) as JSON.
 *   node scripts/backfill-permission-audience.js --apply --out-dir <dir>
 *       full-catalogue backup + ledger (per row: id, code, previous audience or ABSENT, planned) written with
 *       flag "wx" BEFORE the first update; each update is guarded on {_id, previous audience}; then re-read and
 *       verified against the predicted fingerprint.
 *   node scripts/backfill-permission-audience.js --rollback <ledger.json> [--apply]
 *       dry run unless --apply: restores exactly ($set previous, or $unset where it was ABSENT), only for rows still
 *       at the planned value; anything else is reported and left alone.
 * Output: codes, counts and hashes only. No URIs, ids of users, data or secrets.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { isPlatformNamespace } = require("../constants/permissionClassification");
const { PROPOSED_AUDIENCE } = require("../constants/permissionAudience");

const SCRIPT = "backfill-permission-audience";
const ALLOWED = Object.freeze(["CRM", "PORTAL", "BOTH", "LEGACY"]);
const LEGACY = "LEGACY";
const ABSENT = "ABSENT";

const isActive = (d) => d.isActive !== false;
const raKey = (d) => `${String(d.resource || "").toLowerCase()}:${String(d.action || "").toLowerCase()}`;
const current = (d) => (d.audience === undefined || d.audience === null || d.audience === "" ? ABSENT : d.audience);

/** Fingerprint over [code, resource, action, category, audience|null, isActive], rows sorted by code. */
function catalogueFingerprint(docs) {
  const rows = docs
    .map((d) => [d.code, d.resource, d.action, d.category, d.audience ?? null, isActive(d)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
}

/**
 * Pure plan for a catalogue snapshot. Returns { rows, refusals, counts, aliasGroups, skipped, before, predictedAfter }.
 * `map` defaults to PROPOSED_AUDIENCE (injectable for tests).
 */
function plan(catalogue, map = PROPOSED_AUDIENCE) {
  const refusals = [];
  const byCode = new Map();
  for (const d of catalogue) {
    const k = String(d.code);
    if (byCode.has(k)) refusals.push(`DUPLICATE_CODE ${k}`);
    else byCode.set(k, d);
  }
  const rows = [];
  const skipped = { inactive: 0, platform: [] };
  for (const d of catalogue) {
    if (!isActive(d)) {
      skipped.inactive += 1;
      continue;
    }
    const platform = isPlatformNamespace(String(d.resource || "")) || isPlatformNamespace(raKey(d));
    if (platform) {
      skipped.platform.push(d.code);
      if (map[d.code] !== undefined) refusals.push(`PLATFORM_NAMESPACE ${d.code}`);
      continue;
    }
    const planned = map[d.code] !== undefined ? map[d.code] : LEGACY;
    if (!ALLOWED.includes(planned)) refusals.push(`INVALID_PLANNED_VALUE ${d.code}=${planned}`);
    const cur = current(d);
    if (cur !== ABSENT && cur !== planned) refusals.push(`STORED_CONFLICT ${d.code} stored=${cur} planned=${planned}`);
    rows.push({
      id: d._id === undefined ? undefined : String(d._id),
      code: d.code,
      resource: d.resource,
      action: d.action,
      category: d.category,
      current: cur,
      planned,
      change: cur === planned ? "unchanged" : "change",
    });
  }
  for (const code of Object.keys(map)) {
    const d = byCode.get(code);
    if (!d || !isActive(d)) refusals.push(`MAP_CODE_MISSING ${code}`);
  }
  const groups = new Map();
  for (const r of rows) {
    const k = raKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const aliasGroups = [];
  for (const [k, rs] of groups) {
    if (rs.length < 2) continue;
    const values = [...new Set(rs.map((r) => r.planned))];
    aliasGroups.push({ resourceAction: k, codes: rs.map((r) => r.code).sort(), planned: values });
    if (values.length > 1) refusals.push(`ALIAS_CONFLICT ${k} ${rs.map((r) => `${r.code}=${r.planned}`).join(",")}`);
  }
  const counts = { CRM: 0, PORTAL: 0, BOTH: 0, LEGACY: 0, change: 0, unchanged: 0, inactive: skipped.inactive, platform: skipped.platform.length };
  for (const r of rows) {
    counts[r.planned] = (counts[r.planned] || 0) + 1;
    counts[r.change] += 1;
  }
  const plannedByCode = new Map(rows.map((r) => [r.code, r.planned]));
  const afterDocs = catalogue.map((d) => (plannedByCode.has(d.code) && isActive(d) ? { ...d, audience: plannedByCode.get(d.code) } : d));
  return {
    rows: rows.sort((a, b) => String(a.code).localeCompare(String(b.code))),
    refusals,
    counts,
    aliasGroups: aliasGroups.sort((a, b) => a.resourceAction.localeCompare(b.resourceAction)),
    skipped,
    before: catalogueFingerprint(catalogue),
    predictedAfter: catalogueFingerprint(afterDocs),
  };
}

const WRITE_METHODS = ["insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "bulkWrite", "drop", "create", "save"];

/** Dry-run guarantee: every write method throws before reaching the driver. */
function readOnly(obj, label) {
  return new Proxy(obj, {
    get(target, prop) {
      if (WRITE_METHODS.includes(prop)) {
        return () => {
          throw new Error(`READ_ONLY_VIOLATION ${label}.${String(prop)} in dry-run`);
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

function writeNew(file, data) {
  fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 }); // never overwrite an existing backup / ledger
}

const readAll = async (permissions) => permissions.find({}).toArray();

/**
 * @param {{ permissions: import("mongodb").Collection }} deps native `permissions` collection
 * @param {{ apply?: boolean, outDir?: string, rollback?: string, exportFile?: string, map?: object,
 *           log?: (l: string) => void, now?: () => Date }} opts
 */
async function run(deps, { apply = false, outDir, rollback, exportFile, map, log = () => {}, now = () => new Date() } = {}) {
  const mode = rollback ? "rollback" : "backfill";
  const report = { ok: false, applied: apply, mode, updated: 0, skippedConcurrent: [], restored: 0 };
  const refuse = (reason) => {
    report.reason = reason;
    log(`REFUSED: ${reason}. Nothing written.`);
    return report;
  };
  const permissions = apply ? deps.permissions : readOnly(deps.permissions, "permissions");
  if (mode === "rollback") return runRollback(permissions, { apply, ledgerFile: rollback, log, report, refuse });
  if (apply && !outDir) return refuse("OUT_DIR_REQUIRED (pass --out-dir <dir> with --apply)");

  const before = await readAll(permissions);
  const p = plan(before, map);
  report.plan = { counts: p.counts, aliasGroups: p.aliasGroups, refusals: p.refusals, before: p.before, predictedAfter: p.predictedAfter, platformSkipped: p.skipped.platform };
  log(`catalogue: rows=${before.length} active=${before.filter(isActive).length} inactive=${p.skipped.inactive} platformSkipped=${p.skipped.platform.length}`);
  for (const r of p.rows) log(`row ${r.code} ${r.resource}:${r.action} category=${r.category} current=${r.current} planned=${r.planned} ${r.change}`);
  log(`counts: CRM=${p.counts.CRM} BOTH=${p.counts.BOTH} PORTAL=${p.counts.PORTAL} LEGACY=${p.counts.LEGACY} change=${p.counts.change} unchanged=${p.counts.unchanged} inactive(untouched)=${p.counts.inactive}`);
  for (const g of p.aliasGroups) log(`alias ${g.resourceAction}: ${g.codes.join(",")} -> ${g.planned.join("|")}`);
  log(`fingerprint before=${p.before} predicted-after=${p.predictedAfter}`);
  if (exportFile) {
    const exp = p.rows.map(({ code, resource, action, category, planned }) => ({ code, resource, action, category, audience: planned, isActive: true }));
    writeNew(exportFile, JSON.stringify({ script: SCRIPT, generatedAt: now().toISOString(), before: p.before, predictedAfter: p.predictedAfter, catalogue: exp }, null, 1));
    log(`export written: ${exp.length} active rows`);
  }
  if (p.refusals.length) {
    for (const r of p.refusals) log(`refusal: ${r}`);
    return refuse(p.refusals[0].split(" ")[0]);
  }
  if (!apply) {
    report.ok = true;
    log("DRY RUN: nothing written. After a real --apply: clear the catalogue cache (permissionsService.clearCache, 5 min, or recreate user-service) before any enforcement.");
    return report;
  }

  const runId = now().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(outDir, `${SCRIPT}-backup-${runId}.json`);
  const ledgerFile = path.join(outDir, `${SCRIPT}-ledger-${runId}.json`);
  const backupJson = JSON.stringify({ script: SCRIPT, takenAt: now().toISOString(), fingerprint: p.before, catalogue: before }, null, 1);
  writeNew(backupFile, backupJson);
  const changes = p.rows.filter((r) => r.change === "change");
  const ledger = {
    script: SCRIPT,
    runId,
    status: "planned",
    before: p.before,
    predictedAfter: p.predictedAfter,
    backup: { file: path.basename(backupFile), sha256: crypto.createHash("sha256").update(backupJson).digest("hex"), count: before.length },
    rows: changes.map((r) => ({ id: r.id, code: r.code, previous: r.current, planned: r.planned, done: false })),
  };
  writeNew(ledgerFile, JSON.stringify(ledger, null, 2));
  const saveLedger = () => fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  report.ledgerFile = ledgerFile;
  report.backupFile = backupFile;
  log(`backup written (${before.length} rows); ledger written (${changes.length} planned changes)`);

  const { ObjectId } = require(require.resolve("mongodb", { paths: [process.cwd(), __dirname] }));
  const idOf = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : id);
  for (const rec of ledger.rows) {
    const filter = { _id: idOf(rec.id), code: rec.code, audience: rec.previous === ABSENT ? { $exists: false } : rec.previous };
    const res = await permissions.updateOne(filter, { $set: { audience: rec.planned, updatedAt: now(), updatedBy: `script:${SCRIPT}` } });
    if ((res.modifiedCount || 0) === 1) {
      rec.done = true;
      report.updated += 1;
    } else {
      report.skippedConcurrent.push(rec.code);
    }
    saveLedger();
  }

  const after = await readAll(permissions);
  const fpAfter = catalogueFingerprint(after);
  const verified = fpAfter === p.predictedAfter && report.skippedConcurrent.length === 0;
  ledger.status = verified ? "applied" : "applied-with-verification-errors";
  ledger.verification = { fingerprint: fpAfter, expected: p.predictedAfter, skippedConcurrent: report.skippedConcurrent };
  saveLedger();
  report.after = ledger.verification;
  log(`applied: updated=${report.updated} skippedConcurrent=${report.skippedConcurrent.length} fingerprint after=${fpAfter} expected=${p.predictedAfter} -> ${verified ? "VERIFIED" : "VERIFICATION ERRORS"}`);
  log("NEXT: clear the catalogue cache (permissionsService.clearCache, 5 min, or recreate user-service) before any enforcement.");
  report.ok = verified;
  return report;
}

async function runRollback(permissions, { apply, ledgerFile, log, report, refuse }) {
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  } catch (e) {
    return refuse(`LEDGER_UNREADABLE ${e.name}`);
  }
  if (ledger.script !== SCRIPT || !Array.isArray(ledger.rows)) return refuse("LEDGER_NOT_FROM_THIS_SCRIPT");
  const { ObjectId } = require(require.resolve("mongodb", { paths: [process.cwd(), __dirname] }));
  const idOf = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : id);
  const actions = [];
  for (const rec of ledger.rows) {
    const doc = (await permissions.find({ _id: idOf(rec.id), code: rec.code }).toArray())[0];
    if (!doc) actions.push({ rec, action: "GONE" });
    else if (current(doc) !== rec.planned) actions.push({ rec, action: "KEPT_MODIFIED" });
    else actions.push({ rec, action: rec.previous === ABSENT ? "UNSET" : "RESTORE" });
  }
  report.rollback = actions.map(({ rec, action }) => ({ code: rec.code, action, previous: rec.previous }));
  for (const a of report.rollback) log(`rollback ${a.code}: ${a.action}${a.action === "RESTORE" ? ` -> ${a.previous}` : ""}`);
  if (!apply) {
    report.ok = true;
    log("DRY RUN: nothing written.");
    return report;
  }
  for (const { rec, action } of actions) {
    if (action !== "UNSET" && action !== "RESTORE") continue;
    const update = action === "UNSET" ? { $unset: { audience: "" } } : { $set: { audience: rec.previous } };
    const r = await permissions.updateOne({ _id: idOf(rec.id), code: rec.code, audience: rec.planned }, update);
    report.restored += r.modifiedCount || 0;
  }
  const after = await readAll(permissions);
  report.after = { fingerprint: catalogueFingerprint(after), expected: ledger.before };
  log(`rollback applied: restored=${report.restored} fingerprint=${report.after.fingerprint} (pre-backfill ${ledger.before}) -> ${report.after.fingerprint === ledger.before ? "RESTORED" : "DIFFERS (see KEPT_MODIFIED / GONE rows)"}`);
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
    else if (a === "--export") out.exportFile = argv[(i += 1)];
    else if (a.startsWith("--export=")) out.exportFile = a.slice("--export=".length);
    else throw new Error(`UNKNOWN_ARGUMENT ${a}`);
  }
  if (out.apply && out.dryRun) throw new Error("CONTRADICTORY_FLAGS --apply and --dry-run");
  if (out.rollback === undefined && argv.some((a) => a === "--rollback")) throw new Error("ROLLBACK_LEDGER_REQUIRED");
  if (out.exportFile === undefined && argv.some((a) => a === "--export")) throw new Error("EXPORT_FILE_REQUIRED");
  return out;
}

const safeMessage = (m) => String(m || "").replace(/mongodb(\+srv)?:\/\/\S+/gi, "<uri>");

module.exports = { run, plan, catalogueFingerprint, parseArgs, readOnly, safeMessage, ALLOWED, LEGACY, ABSENT, SCRIPT };

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const mongoose = require(require.resolve("mongoose", { paths: [process.cwd(), "/app", __dirname] }));
    await mongoose.connect(process.env.MONGO_URI);
    const report = await run(
      { permissions: mongoose.connection.db.collection("permissions") },
      { apply: args.apply, outDir: args.outDir, rollback: args.rollback, exportFile: args.exportFile, log: (l) => console.log(`[${SCRIPT}] ${l}`) }
    );
    console.log(`[${SCRIPT}] result ok=${report.ok} mode=${report.mode} applied=${report.applied} updated=${report.updated} restored=${report.restored}${report.reason ? ` reason=${report.reason}` : ""}`);
    await mongoose.disconnect();
    process.exit(report.ok ? 0 : 1);
  })().catch((e) => {
    console.error(`[${SCRIPT}] ERROR ${e.name}: ${safeMessage(e.message)}`);
    process.exit(1);
  });
}
