/**
 * Phase A / A7 — drop the stray GLOBAL unique index `code_1` on `producttypes`.
 *
 * Product types are tenant-owned; uniqueness is { code, tenantId } (index `code_1_tenantId_1`,
 * declared in models/productType.model.js). The model no longer declares `code` unique, but the
 * already-built global `code_1` still blocks two tenants from using the same code.
 *
 * Order: inspect -> verify code_1_tenantId_1 exists, is unique and covers {code, tenantId} ->
 * check no (code, tenantId) duplicates -> drop code_1 -> re-read. Idempotent. No document written.
 *
 * Usage (inside the user-service container; MONGO_URI never printed):
 *   node scripts/migrate-producttype-drop-global-code-index.js            # dry run (default)
 *   node scripts/migrate-producttype-drop-global-code-index.js --execute  # apply
 * Rollback: createIndex({ code: 1 }, { unique: true, name: "code_1" }) — valid only while no two
 * tenants share a product-type code.
 */
const mongoose = require("mongoose");
const EXECUTE = process.argv.includes("--execute");

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  const c = mongoose.connection.db.collection("producttypes");
  const idx = await c.indexes();
  console.log("[pt-idx] before", JSON.stringify(idx.map((i) => `${i.name}${i.unique ? "(U)" : ""}`)));
  const tenantIdx = idx.find((i) => i.name === "code_1_tenantId_1");
  const tenantOk = !!tenantIdx && tenantIdx.unique === true && JSON.stringify(tenantIdx.key) === JSON.stringify({ code: 1, tenantId: 1 });
  const dups = (await c.aggregate([{ $group: { _id: { c: "$code", t: "$tenantId" }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray()).length;
  const crossTenantSharedCodes = (await c.aggregate([{ $group: { _id: "$code", t: { $addToSet: "$tenantId" } } }, { $match: { "t.1": { $exists: true } } }]).toArray()).length;
  console.log(`[pt-idx] tenant-aware index healthy=${tenantOk} duplicate(code,tenant)=${dups} codesSharedAcrossTenants=${crossTenantSharedCodes} globalPresent=${idx.some((i) => i.name === "code_1")}`);
  if (!tenantOk || dups) { console.log("[pt-idx] PRECONDITION FAIL — nothing changed"); process.exitCode = 2; return mongoose.disconnect(); }
  if (!EXECUTE) { console.log("[pt-idx] dry run — would drop code_1"); return mongoose.disconnect(); }
  if (idx.some((i) => i.name === "code_1")) { await c.dropIndex("code_1"); console.log("[pt-idx] dropped code_1"); } else console.log("[pt-idx] code_1 already absent");
  console.log("[pt-idx] after", JSON.stringify((await c.indexes()).map((i) => `${i.name}${i.unique ? "(U)" : ""}`)));
  await mongoose.disconnect();
})().catch((e) => { console.log("[pt-idx] ERROR", e.name, e.code || "", String(e.message).slice(0, 120)); process.exit(1); });
