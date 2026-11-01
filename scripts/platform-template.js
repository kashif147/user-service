/**
 * Phase B / P1: the ONLY writer of PlatformTemplate records. Publishes a template version from its reviewed
 * code definition (constants/platformTemplates.js) - never from a database row, a tenant or a request body.
 *
 *   node scripts/platform-template.js list
 *   node scripts/platform-template.js verify  --key <key> --version <n>
 *   node scripts/platform-template.js publish --key <key> --version <n> --by <operator> --approval <ref> \
 *        --expect-db <connected database name> [--execute]
 *   node scripts/platform-template.js retire  --key <key> --version <n> --by <operator> --approval <ref> \
 *        --expect-db <connected database name> [--execute]
 *
 * Dry run unless --execute. Every publish / retire (dry run included) needs --expect-db: the explicit target
 * database, which must equal the database the connection actually opened - otherwise nothing is read or written. publish is insert-only: an already published version with the SAME contentHash is
 * reported and left untouched; a different contentHash for an existing key+version is refused (versions are
 * immutable - add a new version instead). retire only flips published -> retired; nothing is ever deleted.
 *
 * Audit: every executed publish / retire (and every executed one that fails) is published as
 * platform.provisioning.template.published.v1 -> audit-service platform_audit_logs, actor_scope "system",
 * actor_id "platform:provisioning". --by / --approval are operator-SUPPLIED labels, not authenticated identity.
 * Output: key, version, status, content hash prefix, component count. Never the connection string.
 */
const mongoose = require("mongoose");
const PlatformTemplate = require("../models/platformTemplate.model");
const { DEFINITIONS, getDefinition, templateContentHash, validateDefinition } = require("../constants/platformTemplates");
const { auditTemplatePublished } = require("../services/platformAuditService");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, execute: false };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--execute") opts.execute = true;
    else if (a.startsWith("--")) { opts[a.slice(2)] = rest[i + 1]; i += 1; }
    else throw new Error(`unexpected argument ${a}`);
  }
  if (opts.version !== undefined) opts.version = Number(opts.version);
  return opts;
}

function requireActor(opts) {
  if (!opts.by || !opts.approval) throw new Error("--by and --approval are required for every write");
  if (/@/.test(opts.by) || /@/.test(opts.approval)) throw new Error("--by / --approval must not be an email address");
  if (String(opts.by).length > 120 || String(opts.approval).length > 120) throw new Error("--by / --approval: at most 120 characters");
}

function definitionFor(opts) {
  const def = getDefinition(opts.key, opts.version);
  if (!def) throw new Error(`no reviewed definition for ${opts.key} v${opts.version}`);
  validateDefinition(def);
  return { def, hash: templateContentHash(def) };
}

const show = (t) => `${t.key} v${t.version} status=${t.status} contentHash=${String(t.contentHash).slice(0, 12)} components=${(t.components || []).length}`;

let eventsReady = false;
async function audit(opts, fields) {
  if (!eventsReady) {
    await require("../rabbitMQ").initEventSystem(); // publisher only
    eventsReady = true;
  }
  const ok = await auditTemplatePublished({
    ...fields,
    templateKey: opts.key,
    templateVersion: opts.version,
    operatorLabel: opts.by,
    approvalRef: opts.approval,
    correlationId: `template-admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  });
  console.log(ok ? "AUDIT published (platform_audit_logs, system actor platform:provisioning)" : "AUDIT FAILED - change persisted");
  if (!ok) process.exitCode = 2;
}

function requireTarget(opts) {
  const db = mongoose.connection.db && mongoose.connection.db.databaseName;
  if (!opts["expect-db"]) throw new Error("--expect-db <database name> is required (explicit target)");
  if (opts["expect-db"] !== db) throw new Error(`refusing: connected to "${db}" but --expect-db="${opts["expect-db"]}"`);
  console.log(`target database: ${db}`);
}

async function publish(opts) {
  requireActor(opts);
  requireTarget(opts);
  const { def, hash } = definitionFor(opts);
  const existing = await PlatformTemplate.findOne({ key: def.key, version: def.version }).lean();
  if (existing) {
    if (existing.contentHash === hash) return console.log(`already published, identical - nothing written: ${show(existing)}`);
    throw new Error(`refusing: ${def.key} v${def.version} is already published with a DIFFERENT contentHash (versions are immutable)`);
  }
  console.log(`would publish ${def.key} v${def.version} contentHash=${hash.slice(0, 12)} components=${def.components.length}`);
  for (const c of def.components) console.log(`  ${c.order}. ${c.component} v${c.version} sha=${c.manifestSha256.slice(0, 12)}`);
  if (!opts.execute) return console.log("DRY RUN: nothing written (add --execute)");
  try {
    const t = await PlatformTemplate.create({
      key: def.key, version: def.version, description: def.description, components: def.components.map((c) => ({ ...c })),
      contentHash: hash, status: "published", publishedAt: new Date(), publishedBy: opts.by,
    });
    console.log(`PUBLISHED ${show(t)}`);
    await audit(opts, { action: "PLATFORM_TEMPLATE_PUBLISHED", result: "success", contentHash: hash, componentCount: def.components.length });
  } catch (err) {
    await audit(opts, { action: "PLATFORM_TEMPLATE_PUBLISHED", result: "failure", reason: err && err.code === 11000 ? "conflict" : "error" });
    throw err;
  }
}

async function retire(opts) {
  requireActor(opts);
  requireTarget(opts);
  const existing = await PlatformTemplate.findOne({ key: opts.key, version: opts.version }).lean();
  if (!existing) throw new Error("template version not found");
  if (existing.status === "retired") return console.log(`already retired - nothing written: ${show(existing)}`);
  if (!opts.execute) return console.log(`would retire ${show(existing)}\nDRY RUN: nothing written (add --execute)`);
  const r = await PlatformTemplate.updateOne({ key: opts.key, version: opts.version, status: "published" }, { $set: { status: "retired", retiredAt: new Date(), retiredBy: opts.by } });
  console.log(r.modifiedCount === 1 ? "RETIRED" : "not retired (concurrent change)");
  await audit(opts, { action: "PLATFORM_TEMPLATE_RETIRED", result: r.modifiedCount === 1 ? "success" : "failure", contentHash: existing.contentHash });
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.command === "definitions") {
    for (const d of DEFINITIONS) console.log(`${d.key} v${d.version} contentHash=${templateContentHash(d).slice(0, 12)} components=${d.components.length}`);
    return;
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  try {
    if (opts.command === "list") {
      for (const t of await PlatformTemplate.find({}).sort({ key: 1, version: 1 }).lean()) console.log(show(t));
    } else if (opts.command === "verify") {
      const { hash } = definitionFor(opts);
      const t = await PlatformTemplate.findOne({ key: opts.key, version: opts.version }).lean();
      console.log(!t ? "not published" : t.contentHash === hash && templateContentHash(t) === hash ? `VERIFIED ${show(t)}` : `MISMATCH ${show(t)}`);
    } else if (opts.command === "publish") await publish(opts);
    else if (opts.command === "retire") await retire(opts);
    else throw new Error("usage: definitions | list | verify | publish | retire (see header)");
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(process.exitCode || 0))
    .catch((err) => {
      console.error(`ERROR: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { main, parseArgs };
