/**
 * Stage 5c-1 claim writes against a real MongoDB (helpers/directoryClaimService.js).
 *
 * Runs only when STAGE5B_MONGO_URI points at a DISPOSABLE MongoDB (same variable as the Stage 5b
 * database suite); skipped otherwise. The test database is dropped at the end.
 */
const mongoose = require("mongoose");

const URI = process.env.STAGE5B_MONGO_URI;
const run = URI ? describe : describe.skip;

const ENTRA = "Entra ID (Azure AD)";
const DIR = "11111111-2222-3333-4444-555555555555";
const DEV_DIR = "39866a06-30bc-4a89-80c6-9dd9357dd453";
const GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";
const APP_ADMIN = "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3";
const OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const DEV_ENV = { DEPLOYMENT_ENV: "dev", ENTRA_ALLOW_SHARED_DIRECTORY: "true", ENTRA_SHARED_DIRECTORY_ALLOWLIST: DEV_DIR };

run("Connect claim writes against MongoDB", () => {
  let DirectoryClaim;
  let service;
  const evidence = (roleTemplateId = GLOBAL_ADMIN) => ({ directoryUserId: OID, roleTemplateId });
  const connect = (t, extra = {}) =>
    service.recordVerifiedConnectClaim({ tenantId: `tenant${t}`, connectionId: `conn${t}`, directoryId: DIR, userId: `user${t}`, evidence: evidence(), ...extra });

  beforeAll(async () => {
    await mongoose.connect(URI, { dbName: `stage5c_test_${Date.now()}` });
    DirectoryClaim = require("../models/directoryClaim.model");
    service = require("../helpers/directoryClaimService");
    await DirectoryClaim.init();
  });
  beforeEach(async () => {
    await DirectoryClaim.deleteMany({});
    for (const k of Object.keys(DEV_ENV)) delete process.env[k];
  });
  afterAll(async () => {
    for (const k of Object.keys(DEV_ENV)) delete process.env[k];
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test("creates exactly the specified verified claim with evidence (two keys, nothing else)", async () => {
    const out = await connect("A");
    expect(out.created).toBe(true);
    const c = await DirectoryClaim.findById(out.claimId).lean();
    expect(c).toMatchObject({
      connectionType: ENTRA,
      directoryId: DIR,
      tenantId: "tenantA",
      connectionId: "connA",
      status: "verified",
      method: "entra-admin-sign-in",
      sharedDirectoryException: false,
      claimedBy: "user:userA",
      verifiedBy: "user:userA",
      verificationEvidence: { directoryUserId: OID, roleTemplateId: GLOBAL_ADMIN },
    });
    expect(Object.keys(c.verificationEvidence).sort()).toEqual(["directoryUserId", "roleTemplateId"]);
  });

  test("race: two organisations connecting the same directory concurrently -> exactly one wins", async () => {
    for (let round = 0; round < 10; round++) {
      await DirectoryClaim.deleteMany({});
      const results = await Promise.allSettled(["A", "B", "C", "D"].map((t) => connect(t)));
      const ok = results.filter((r) => r.status === "fulfilled");
      expect(ok).toHaveLength(1);
      for (const r of results.filter((x) => x.status === "rejected")) expect(r.reason.code).toBe("DIRECTORY_ALREADY_CLAIMED");
      expect(await DirectoryClaim.countDocuments({ directoryId: DIR, status: "verified" })).toBe(1);
    }
  });

  test("reconnect refreshes evidence and verifiedAt on the same claim; ownership unchanged", async () => {
    const first = await connect("A");
    const before = await DirectoryClaim.findById(first.claimId).lean();
    await new Promise((r) => setTimeout(r, 10));
    const again = await connect("A", { evidence: evidence(APP_ADMIN) });
    expect(again).toEqual({ claimId: first.claimId, created: false });
    const after = await DirectoryClaim.findById(first.claimId).lean();
    expect(after.verificationEvidence.roleTemplateId).toBe(APP_ADMIN);
    expect(after.verifiedAt.getTime()).toBeGreaterThan(before.verifiedAt.getTime());
    expect(after.claimedAt.getTime()).toBe(before.claimedAt.getTime());
    expect(await DirectoryClaim.countDocuments({})).toBe(1);
  });

  test("an own pending claim is upgraded; another organisation's verified claim is never transferred", async () => {
    await DirectoryClaim.create({ connectionType: ENTRA, directoryId: DIR, tenantId: "tenantA", connectionId: "connA", method: "entra-admin-sign-in", claimedBy: "user:x" });
    const up = await connect("A");
    expect(up.created).toBe(false);
    expect(await DirectoryClaim.findById(up.claimId).lean()).toMatchObject({ status: "verified" });
    await expect(connect("B")).rejects.toMatchObject({ code: "DIRECTORY_ALREADY_CLAIMED" });
    expect(await DirectoryClaim.findOne({ directoryId: DIR, status: "verified" }).lean()).toMatchObject({ tenantId: "tenantA" });
  });

  test("DEV exception claims refuse Connect and stay byte-identical", async () => {
    Object.assign(process.env, DEV_ENV);
    const dev = (t) => ({ connectionType: ENTRA, directoryId: DEV_DIR, tenantId: `tenant${t}`, connectionId: `conn${t}`, status: "verified", method: "dev-exception", claimedBy: "platform:dev-backfill", verifiedAt: new Date(), verifiedBy: "platform:dev-backfill" });
    await DirectoryClaim.create(dev("A"));
    await DirectoryClaim.create(dev("B"));
    const before = JSON.stringify(await DirectoryClaim.find({}).sort({ _id: 1 }).lean());
    await expect(connect("A", { directoryId: DEV_DIR })).rejects.toMatchObject({ code: "DIRECTORY_SHARED_EXCEPTION" });
    await expect(connect("C", { directoryId: DEV_DIR })).rejects.toMatchObject({ code: "DIRECTORY_SHARED_EXCEPTION" });
    expect(JSON.stringify(await DirectoryClaim.find({}).sort({ _id: 1 }).lean())).toBe(before);
  });

  test("existing claims without verificationEvidence (DEV exceptions) stay valid under the new schema", async () => {
    Object.assign(process.env, DEV_ENV);
    await DirectoryClaim.collection.insertOne({ connectionType: ENTRA, directoryId: DEV_DIR, tenantId: "tenantA", connectionId: "connA", status: "verified", method: "dev-exception", sharedDirectoryException: true, claimedAt: new Date(), claimedBy: "platform:dev-backfill", verifiedAt: new Date(), verifiedBy: "platform:dev-backfill" });
    const doc = await DirectoryClaim.findOne({ connectionId: "connA" });
    await expect(doc.validate()).resolves.toBeUndefined();
  });
});
