/**
 * Stage 5c-3 index migration for the `directoryclaims` collection.
 *
 * Replaces the always-on unique indexes
 *   uniq_claim_per_connection        {connectionType, connectionId}
 *   uniq_claim_per_tenant_directory  {connectionType, directoryId, tenantId}
 * with partial unique indexes over ACTIVE claims only (status pending | verified)
 *   uniq_active_claim_per_connection
 *   uniq_active_claim_per_tenant_directory
 * so revoked claims (Disconnect) stay as audit history and a reconnect can create a new claim.
 * uniq_verified_directory is not touched.
 *
 * Order: A inspect -> B check the data fits the new indexes -> C create the new indexes ->
 * D verify them (unique, key, partial filter) -> E only then drop the two old indexes ->
 * F re-read and confirm the final set. No document is read beyond index-compatibility counts and
 * none is written. Idempotent; a run interrupted before E leaves the old (stricter) indexes in place
 * and simply completes on the next run.
 *
 * Usage (inside the user-service container; MONGO_URI from its environment, never printed):
 *   node scripts/migrate-directoryclaim-partial-indexes.js            # dry run (default)
 *   node scripts/migrate-directoryclaim-partial-indexes.js --execute  # apply
 * Output: index names, keys, filters and counts only.
 */
const COLLECTION = "directoryclaims";
const ACTIVE_FILTER = { status: { $in: ["pending", "verified"] } };
const NEW_INDEXES = [
  { name: "uniq_active_claim_per_connection", key: { connectionType: 1, connectionId: 1 } },
  { name: "uniq_active_claim_per_tenant_directory", key: { connectionType: 1, directoryId: 1, tenantId: 1 } },
];
const OLD_INDEX_NAMES = ["uniq_claim_per_connection", "uniq_claim_per_tenant_directory"];
const KEPT_INDEX = {
  name: "uniq_verified_directory",
  key: { connectionType: 1, directoryId: 1 },
  partialFilterExpression: { status: "verified", sharedDirectoryException: false },
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const matchesNew = (idx, want) =>
  !!idx && idx.unique === true && same(idx.key, want.key) && same(idx.partialFilterExpression, ACTIVE_FILTER);

async function duplicateActiveGroups(coll, key) {
  const groupId = Object.fromEntries(Object.keys(key).map((k) => [k, `$${k}`]));
  const out = await coll
    .aggregate([{ $match: ACTIVE_FILTER }, { $group: { _id: groupId, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: "groups" }])
    .toArray();
  return out[0]?.groups || 0;
}

/**
 * @param {import("mongodb").Db} db
 * @param {{execute?: boolean, dropOld?: boolean, log?: (line: string) => void}} [opts]
 *   dropOld false stops after D (used to prove an interrupted run is safe)
 * @returns {Promise<{ok: boolean, executed: boolean, created: string[], dropped: string[], final: string[], reason?: string}>}
 */
async function run(db, { execute = false, dropOld = true, log = () => {} } = {}) {
  const coll = db.collection(COLLECTION);
  const report = { ok: false, executed: execute, created: [], dropped: [], final: [] };
  const list = async () => {
    try {
      return await coll.indexes();
    } catch (e) {
      if (e && e.codeName === "NamespaceNotFound") return [];
      throw e;
    }
  };

  // A. inspect
  const before = await list();
  const byName = Object.fromEntries(before.map((i) => [i.name, i]));
  log(`A. indexes before: ${before.map((i) => i.name).join(", ") || "(none)"}`);
  const kept = byName[KEPT_INDEX.name];
  if (kept && !(kept.unique === true && same(kept.key, KEPT_INDEX.key) && same(kept.partialFilterExpression, KEPT_INDEX.partialFilterExpression))) {
    report.reason = `${KEPT_INDEX.name} differs from the expected definition; refusing to continue`;
    log(`A. ${report.reason}`);
    return report;
  }
  for (const want of NEW_INDEXES) {
    const have = byName[want.name];
    if (have && !matchesNew(have, want)) {
      report.reason = `${want.name} exists with a different definition; refusing to continue`;
      log(`A. ${report.reason}`);
      return report;
    }
  }

  // B. the current data must fit the new partial unique indexes
  for (const want of NEW_INDEXES) {
    const dups = await duplicateActiveGroups(coll, want.key);
    log(`B. ${want.name}: duplicate active groups=${dups}`);
    if (dups > 0) {
      report.reason = `active claims violate ${want.name}`;
      return report;
    }
  }

  const toCreate = NEW_INDEXES.filter((w) => !byName[w.name]);
  const toDrop = OLD_INDEX_NAMES.filter((n) => byName[n]);
  log(`plan: create=[${toCreate.map((w) => w.name).join(", ")}] drop=[${toDrop.join(", ")}]`);
  if (!execute) {
    report.ok = true;
    report.final = before.map((i) => i.name);
    log("dry run: no change made");
    return report;
  }

  // C. create the new indexes
  for (const want of toCreate) {
    await coll.createIndex(want.key, { name: want.name, unique: true, partialFilterExpression: ACTIVE_FILTER });
    report.created.push(want.name);
    log(`C. created ${want.name}`);
  }

  // D. verify them before anything is dropped
  const afterCreate = Object.fromEntries((await list()).map((i) => [i.name, i]));
  for (const want of NEW_INDEXES) {
    if (!matchesNew(afterCreate[want.name], want)) {
      report.reason = `${want.name} could not be verified; old indexes kept`;
      log(`D. ${report.reason}`);
      return report;
    }
    log(`D. verified ${want.name} unique=true key=${JSON.stringify(want.key)} partial=${JSON.stringify(ACTIVE_FILTER)}`);
  }
  if (!dropOld) {
    report.ok = true;
    report.final = Object.keys(afterCreate);
    log("stopped before dropping the old indexes (old and new coexist; behaviour is the old, stricter one)");
    return report;
  }

  // E. drop the old indexes
  for (const name of OLD_INDEX_NAMES.filter((n) => afterCreate[n])) {
    await coll.dropIndex(name);
    report.dropped.push(name);
    log(`E. dropped ${name}`);
  }

  // F. confirm the final set
  const final = await list();
  report.final = final.map((i) => i.name);
  const finalByName = Object.fromEntries(final.map((i) => [i.name, i]));
  const ok =
    NEW_INDEXES.every((w) => matchesNew(finalByName[w.name], w)) &&
    OLD_INDEX_NAMES.every((n) => !finalByName[n]) &&
    (!finalByName[KEPT_INDEX.name] || same(finalByName[KEPT_INDEX.name].partialFilterExpression, KEPT_INDEX.partialFilterExpression));
  report.ok = ok;
  if (!ok) report.reason = "final index set is not the expected one";
  log(`F. indexes after: ${report.final.join(", ")} -> ${ok ? "OK" : "UNEXPECTED"}`);
  return report;
}

module.exports = { run, NEW_INDEXES, OLD_INDEX_NAMES, ACTIVE_FILTER, KEPT_INDEX, COLLECTION };

if (require.main === module) {
  const mongoose = require("mongoose");
  const execute = process.argv.includes("--execute");
  (async () => {
    // This service's own database (MONGO_URI), the same connection the service uses.
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false });
    const report = await run(mongoose.connection.db, { execute, log: (l) => console.log(l) });
    console.log(`RESULT ok=${report.ok} executed=${report.executed} created=${report.created.length} dropped=${report.dropped.length}${report.reason ? " reason=" + report.reason : ""}`);
    await mongoose.disconnect();
    process.exit(report.ok ? 0 : 1);
  })().catch((e) => {
    console.log(`RESULT ok=false error=${e && e.name}`);
    process.exit(1);
  });
}
