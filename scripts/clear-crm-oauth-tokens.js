/**
 * CRM Microsoft-token containment: removes Microsoft OAuth credential material stored on CRM users
 * by logins before the containment change (CRM sign-in no longer stores any).
 *
 * Touches ONLY users with userType "CRM", and on them ONLY the OAuth credential fields:
 *   tokens.id_token, tokens.refresh_token, tokens.id_token_expires_in,
 *   tokens.refresh_token_expires_in, tokens.refresh_token_expires_at (set to null, the same shape a
 *   CRM login now writes) and a legacy tokens.access_token (removed).
 * Never touches PORTAL (B2C) users, identity linkage (userMicrosoftId, issuer), roles, tenantId or
 * account status - proven by a non-reversible fingerprint of those fields before and after.
 * Not reversible by design (the values are credentials and are not backed up).
 *
 * Usage (inside the user-service container; MONGO_URI from its environment, never printed):
 *   node scripts/clear-crm-oauth-tokens.js            # dry run (default): counts only
 *   node scripts/clear-crm-oauth-tokens.js --execute  # clear
 * Output: counts and fingerprints only - never a token value or any part of one.
 */
const crypto = require("crypto");

const COLLECTION = "users";
const CRM = { userType: "CRM" };
const PORTAL = { userType: "PORTAL" };
const NULLED_FIELDS = [
  "tokens.id_token",
  "tokens.refresh_token",
  "tokens.id_token_expires_in",
  "tokens.refresh_token_expires_in",
  "tokens.refresh_token_expires_at",
];
const REMOVED_FIELDS = ["tokens.access_token"];
const present = (path) => ({ [path]: { $exists: true, $ne: null } });
const HAS_ANY = { $or: [...NULLED_FIELDS, ...REMOVED_FIELDS].map(present) };

/** Counts only, for one user type. */
async function counts(coll, scope) {
  const [users, refreshToken, idToken, accessToken, anyMaterial] = await Promise.all([
    coll.countDocuments(scope),
    coll.countDocuments({ ...scope, ...present("tokens.refresh_token") }),
    coll.countDocuments({ ...scope, ...present("tokens.id_token") }),
    coll.countDocuments({ ...scope, ...present("tokens.access_token") }),
    coll.countDocuments({ ...scope, ...HAS_ANY }),
  ]);
  return { users, refreshToken, idToken, accessToken, anyMaterial };
}

/** Non-reversible fingerprint of what must NOT change (identity, tenant, roles, status). */
async function protectedFingerprint(coll, scope) {
  const docs = await coll
    .find(scope, { projection: { _id: 1, tenantId: 1, userType: 1, userMicrosoftId: 1, userIssuer: 1, userEmail: 1, roles: 1, isActive: 1 } })
    .sort({ _id: 1 })
    .toArray();
  return crypto.createHash("sha256").update(JSON.stringify(docs)).digest("hex").slice(0, 16);
}

/** Non-reversible fingerprint of PORTAL users including their tokens (must not change). */
async function portalFingerprint(coll) {
  const docs = await coll.find(PORTAL, { projection: { _id: 1, tokens: 1, roles: 1, tenantId: 1, isActive: 1 } }).sort({ _id: 1 }).toArray();
  return crypto.createHash("sha256").update(JSON.stringify(docs)).digest("hex").slice(0, 16);
}

/**
 * @param {import("mongodb").Db} db
 * @param {{execute?: boolean, log?: (line: string) => void}} [opts]
 */
async function run(db, { execute = false, log = () => {} } = {}) {
  const coll = db.collection(COLLECTION);
  const fmt = (c) => `users=${c.users} refresh_token=${c.refreshToken} id_token=${c.idToken} access_token=${c.accessToken} withAnyTokenMaterial=${c.anyMaterial}`;
  const before = { crm: await counts(coll, CRM), portal: await counts(coll, PORTAL) };
  const fpBefore = { crm: await protectedFingerprint(coll, CRM), portal: await portalFingerprint(coll) };
  log(`BEFORE CRM:    ${fmt(before.crm)}`);
  log(`BEFORE PORTAL: ${fmt(before.portal)} (not modified)`);
  log(`BEFORE fingerprints: crmProtected=${fpBefore.crm} portal=${fpBefore.portal}`);

  const report = { executed: execute, before, matched: 0, modified: 0, ok: true };
  if (!execute) {
    log(`DRY RUN: ${before.crm.anyMaterial} CRM user(s) would be cleared. Re-run with --execute to apply.`);
    return report;
  }

  const res = await coll.updateMany(
    { ...CRM, ...HAS_ANY },
    {
      $set: Object.fromEntries(NULLED_FIELDS.map((f) => [f, null])),
      $unset: Object.fromEntries(REMOVED_FIELDS.map((f) => [f, ""])),
    }
  );
  report.matched = res.matchedCount;
  report.modified = res.modifiedCount;

  const after = { crm: await counts(coll, CRM), portal: await counts(coll, PORTAL) };
  const fpAfter = { crm: await protectedFingerprint(coll, CRM), portal: await portalFingerprint(coll) };
  report.after = after;
  report.ok =
    after.crm.anyMaterial === 0 &&
    after.crm.users === before.crm.users &&
    fpAfter.crm === fpBefore.crm &&
    fpAfter.portal === fpBefore.portal &&
    JSON.stringify(after.portal) === JSON.stringify(before.portal);
  log(`EXECUTED: matched=${res.matchedCount} modified=${res.modifiedCount}`);
  log(`AFTER CRM:    ${fmt(after.crm)}`);
  log(`AFTER PORTAL: ${fmt(after.portal)}`);
  log(`AFTER fingerprints: crmProtected=${fpAfter.crm} (${fpAfter.crm === fpBefore.crm ? "unchanged" : "CHANGED"}) portal=${fpAfter.portal} (${fpAfter.portal === fpBefore.portal ? "unchanged" : "CHANGED"})`);
  return report;
}

module.exports = { run, counts, NULLED_FIELDS, REMOVED_FIELDS, COLLECTION };

if (require.main === module) {
  const mongoose = require("mongoose");
  const execute = process.argv.includes("--execute");
  (async () => {
    // This service's own database (MONGO_URI), the same connection the service uses.
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false });
    const report = await run(mongoose.connection.db, { execute, log: (l) => console.log(l) });
    console.log(`RESULT ok=${report.ok} executed=${report.executed} modified=${report.modified}`);
    await mongoose.disconnect();
    process.exit(report.ok ? 0 : 1);
  })().catch((e) => {
    console.log(`RESULT ok=false error=${e && e.name}`);
    process.exit(1);
  });
}
