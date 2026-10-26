/**
 * Phase A / A8 — partial identity uniqueness on `users`.
 *
 * Replaces the always-on unique indexes
 *   tenantId_1_userMicrosoftId_1   {tenantId, userMicrosoftId}
 *   tenantId_1_userSubject_1       {tenantId, userSubject}
 * with partial unique indexes over POPULATED identifiers only ({ field: { $gt: "" } }: non-empty
 * strings; null / missing / "" excluded), named *_partial. Real ids stay unique per tenant.
 *
 * Order: inspect -> check the data fits (no duplicate populated id per tenant) -> create the new
 * indexes (they coexist with the old ones; different filter) -> verify -> drop the old pair ->
 * re-read. Idempotent; an interrupted run leaves the stricter old indexes in place.
 *
 * Usage (inside the user-service container; MONGO_URI from its environment, never printed):
 *   node scripts/migrate-user-identity-partial-indexes.js            # dry run (default)
 *   node scripts/migrate-user-identity-partial-indexes.js --execute  # apply
 * Output: index names, keys, filters and counts only. Rollback: recreate the two non-partial
 * indexes (valid only while each tenant has <= 1 user with a null/missing/"" id).
 */
const mongoose = require("mongoose");
const EXECUTE = process.argv.includes("--execute");
const FIELDS = ["userMicrosoftId", "userSubject"];
const newName = (f) => `tenantId_1_${f}_1_partial`;
const oldName = (f) => `tenantId_1_${f}_1`;
const filterOf = (f) => ({ [f]: { $gt: "" } });

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  const c = mongoose.connection.db.collection("users");
  const show = async (label) =>
    console.log(`[idn-idx] ${label}`, JSON.stringify((await c.indexes()).filter((i) => i.name.includes("userMicrosoftId") || i.name.includes("userSubject")).map((i) => ({ name: i.name, unique: !!i.unique, partial: i.partialFilterExpression || null }))));
  await show("before");
  let bad = 0;
  for (const f of FIELDS) {
    const shape = {
      populated: await c.countDocuments(filterOf(f)),
      nullOrMissing: await c.countDocuments({ [f]: null }),
      empty: await c.countDocuments({ [f]: "" }),
    };
    const dups = (await c.aggregate([{ $match: filterOf(f) }, { $group: { _id: { t: "$tenantId", v: `$${f}` }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray()).length;
    console.log(`[idn-idx] ${f}: ${JSON.stringify(shape)} duplicatePopulatedPerTenant=${dups}`);
    bad += dups;
  }
  if (bad) { console.log("[idn-idx] PRECONDITION FAIL — nothing changed"); process.exitCode = 2; return mongoose.disconnect(); }
  if (!EXECUTE) { console.log("[idn-idx] dry run — would create " + FIELDS.map(newName).join(", ") + " and drop " + FIELDS.map(oldName).join(", ")); return mongoose.disconnect(); }
  for (const f of FIELDS) await c.createIndex({ tenantId: 1, [f]: 1 }, { unique: true, name: newName(f), partialFilterExpression: filterOf(f) });
  const idx = await c.indexes();
  const ok = FIELDS.every((f) => idx.some((i) => i.name === newName(f) && i.unique && JSON.stringify(i.partialFilterExpression) === JSON.stringify(filterOf(f))));
  console.log("[idn-idx] new partial indexes verified:", ok);
  if (!ok) { process.exitCode = 3; return mongoose.disconnect(); }
  for (const f of FIELDS) if (idx.some((i) => i.name === oldName(f))) { await c.dropIndex(oldName(f)); console.log(`[idn-idx] dropped ${oldName(f)}`); }
  await show("after");
  await mongoose.disconnect();
})().catch((e) => { console.log("[idn-idx] ERROR", e.name, e.code || "", String(e.message).slice(0, 120)); process.exit(1); });
