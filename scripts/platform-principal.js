/**
 * Phase B / Z1: the ONLY writer of PlatformPrincipal records until the Z2 platform API exists.
 *
 * Every write needs --by (operator, non-identifying) and --approval (owner approval reference).
 * A principal is created for one VERIFIED Entra identity (issuer + oid) - never from an email, name,
 * tenant role (SU / ASU / "*") or organisation code, and never by promoting an existing user
 * implicitly. Nothing is deleted: disable keeps the record as history.
 *
 * Usage (inside the user-service container; MONGO_URI from its environment, never printed):
 *   node scripts/platform-principal.js list
 *   node scripts/platform-principal.js create  --issuer <entra v2 issuer> --oid <guid> \
 *        --permissions <code,code> --by <operator> --approval <ref> [--label <text>] [--execute]
 *   node scripts/platform-principal.js disable|enable --id <principal id> --by <op> --approval <ref> [--execute]
 *   node scripts/platform-principal.js set-permissions --id <id> --permissions <codes> --by <op> --approval <ref> [--execute]
 * Dry run unless --execute. Output: masked ids, status, revision, permission codes, counts.
 */
const mongoose = require("mongoose");
const PlatformPrincipal = require("../models/platformPrincipal.model");
const { isPlatformPermission } = require("../constants/platformPermissions");

const mask = (v) => (v ? `…${String(v).slice(-6)}` : "-");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, execute: false };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--execute") opts.execute = true;
    else if (a.startsWith("--")) { opts[a.slice(2)] = rest[i + 1]; i += 1; }
    else throw new Error(`unexpected argument ${a}`);
  }
  return opts;
}

function permissionList(raw) {
  const list = String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((p) => !isPlatformPermission(p));
  if (bad.length) throw new Error(`not platform permission codes: ${bad.join(", ")}`);
  if (new Set(list).size !== list.length) throw new Error("duplicate permission codes");
  return list;
}

function requireActor(opts) {
  if (!opts.by || !opts.approval) throw new Error("--by and --approval are required for every write");
  if (/@/.test(opts.by) || /@/.test(opts.approval) || /@/.test(opts.label || "")) {
    throw new Error("--by / --approval / --label must not be an email address");
  }
}

const show = (p) => ({
  id: mask(p._id), tid: mask(p.tid), oid: mask(p.oid), status: p.status, revision: p.revision,
  permissions: p.permissions, label: p.label || null, changes: (p.changes || []).length,
});

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await require("../config/db").mongooseConnection();
  if (mongoose.connection.readyState !== 1) throw new Error("no database connection");
  await PlatformPrincipal.init(); // ensures uniq_platform_identity exists

  if (opts.command === "list") {
    const all = await PlatformPrincipal.find({}).lean();
    console.log(JSON.stringify({ count: all.length, principals: all.map(show) }, null, 1));
    return;
  }

  requireActor(opts);
  const now = new Date();

  if (opts.command === "create") {
    const m = PlatformPrincipal.ENTRA_V2_ISSUER.exec(opts.issuer || "");
    if (!m) throw new Error("--issuer must be an Entra v2 issuer https://login.microsoftonline.com/<tid>/v2.0");
    const doc = {
      issuer: opts.issuer, oid: String(opts.oid || "").toLowerCase(), tid: m[1], status: "active",
      permissions: permissionList(opts.permissions), revision: 1, label: opts.label || null,
      createdBy: opts.by, updatedBy: opts.by,
    };
    doc.changes = [{ at: now, by: opts.by, action: "create", approval: opts.approval, revision: 1, status: "active", permissions: doc.permissions }];
    await new PlatformPrincipal(doc).validate();
    if (!opts.execute) { console.log("DRY RUN create", JSON.stringify(show(doc))); return; }
    const created = await PlatformPrincipal.create(doc);
    console.log("CREATED", JSON.stringify(show(created.toObject())));
    return;
  }

  if (!mongoose.isValidObjectId(opts.id)) throw new Error("--id must be a principal id");
  const current = await PlatformPrincipal.findById(opts.id).lean();
  if (!current) throw new Error("principal not found");

  let set;
  if (opts.command === "disable") set = { status: "disabled" };
  else if (opts.command === "enable") set = { status: "active" };
  else if (opts.command === "set-permissions") set = { permissions: permissionList(opts.permissions) };
  else throw new Error(`unknown command ${opts.command}`);

  const next = { status: current.status, permissions: current.permissions, ...set };
  const revision = current.revision + 1;
  if (!opts.execute) { console.log(`DRY RUN ${opts.command}`, JSON.stringify({ ...show(current), ...next, revision })); return; }
  // Optimistic: only applies if nobody changed the record since it was read.
  const updated = await PlatformPrincipal.findOneAndUpdate(
    { _id: current._id, revision: current.revision },
    {
      $set: { ...set, revision, updatedBy: opts.by },
      $push: { changes: { at: now, by: opts.by, action: opts.command, approval: opts.approval, revision, ...next } },
    },
    { new: true, runValidators: true }
  ).lean();
  if (!updated) throw new Error("principal changed concurrently; re-run");
  console.log("UPDATED", JSON.stringify(show(updated)));
}

if (require.main === module) {
  main()
    .catch((err) => { console.error("FAILED:", err.message); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}

module.exports = { parseArgs, permissionList, requireActor };
