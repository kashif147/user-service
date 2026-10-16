/**
 * Stage 5b database-level guarantees for DirectoryClaim, against a real MongoDB.
 *
 * Runs only when STAGE5B_MONGO_URI points at a DISPOSABLE MongoDB (for example a throwaway local
 * container); skipped otherwise, so the default suite needs no database. The test database is
 * dropped at the end.
 *
 *  - one VERIFIED directory -> one organisation, enforced by the unique index even when two
 *    organisations verify concurrently (exactly one write wins);
 *  - pending claims do not block; one claim per connection and per (organisation, directory);
 *  - DEV shared-directory exception claims coexist with each other but never with a verified
 *    normal claim for the same directory.
 */
const mongoose = require("mongoose");

const URI = process.env.STAGE5B_MONGO_URI;
const run = URI ? describe : describe.skip;

const ENTRA = "Entra ID (Azure AD)";
const DIR = "11111111-2222-3333-4444-555555555555";
const DEV_DIR = "39866a06-30bc-4a89-80c6-9dd9357dd453";
const DEV_ENV = { DEPLOYMENT_ENV: "dev", ENTRA_ALLOW_SHARED_DIRECTORY: "true", ENTRA_SHARED_DIRECTORY_ALLOWLIST: DEV_DIR };

run("DirectoryClaim against MongoDB", () => {
  let DirectoryClaim;
  const claim = (tenantId, connectionId, extra = {}) => ({
    connectionType: ENTRA,
    directoryId: DIR,
    tenantId,
    connectionId,
    method: "entra-admin-sign-in",
    claimedBy: "platform-test",
    ...extra,
  });
  const asVerified = (c) => ({ ...c, status: "verified", verifiedAt: new Date(), verifiedBy: "admin-oid-test" });

  beforeAll(async () => {
    await mongoose.connect(URI, { dbName: `stage5b_test_${Date.now()}` });
    DirectoryClaim = require("../models/directoryClaim.model");
    await DirectoryClaim.init(); // build the indexes before any write
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

  test("indexes exist in the database as designed", async () => {
    const idx = await DirectoryClaim.collection.indexes();
    const v = idx.find((i) => i.name === "uniq_verified_directory");
    expect(v).toMatchObject({ unique: true, key: { connectionType: 1, directoryId: 1 } });
    expect(v.partialFilterExpression).toEqual({ status: "verified", sharedDirectoryException: false });
    // Stage 5c-3: active-claim partial indexes (revoked history is outside them).
    const active = { status: { $in: ["pending", "verified"] } };
    expect(idx.find((i) => i.name === "uniq_active_claim_per_connection")).toMatchObject({ unique: true, key: { connectionType: 1, connectionId: 1 }, partialFilterExpression: active });
    expect(idx.find((i) => i.name === "uniq_active_claim_per_tenant_directory")).toMatchObject({ unique: true, key: { connectionType: 1, directoryId: 1, tenantId: 1 }, partialFilterExpression: active });
    expect(idx.find((i) => i.name === "uniq_claim_per_connection")).toBeUndefined();
    expect(idx.find((i) => i.name === "uniq_claim_per_tenant_directory")).toBeUndefined();
  });

  test("race: two organisations verifying the same directory concurrently -> exactly one wins", async () => {
    for (let round = 0; round < 10; round++) {
      await DirectoryClaim.deleteMany({});
      const writers = ["A", "B", "C", "D"].map((t) =>
        DirectoryClaim.collection.insertOne({
          ...asVerified(claim(`tenant${t}`, `conn${t}`)),
          sharedDirectoryException: false,
          claimedAt: new Date(),
        })
      );
      const results = await Promise.allSettled(writers);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((x) => x.status === "rejected")) expect(r.reason.code).toBe(11000);
    }
  });

  test("race through the model (pre-checks passed by both) -> exactly one wins via the index", async () => {
    const results = await Promise.allSettled([
      DirectoryClaim.create(asVerified(claim("tenantA", "connA"))),
      DirectoryClaim.create(asVerified(claim("tenantB", "connB"))),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await DirectoryClaim.countDocuments({ directoryId: DIR, status: "verified" })).toBe(1);
  });

  test("pending claims for the same directory do not block; verifying the second one is refused", async () => {
    await DirectoryClaim.create(claim("tenantA", "connA"));
    const b = await DirectoryClaim.create(claim("tenantB", "connB"));
    await DirectoryClaim.updateOne({ tenantId: "tenantA" }, { status: "verified", verifiedAt: new Date(), verifiedBy: "x" });
    b.status = "verified";
    b.verifiedAt = new Date();
    b.verifiedBy = "y";
    await expect(b.save()).rejects.toMatchObject({ code: 11000 });
  });

  test("one claim per connection, and per (organisation, directory)", async () => {
    await DirectoryClaim.create(claim("tenantA", "connA"));
    await expect(DirectoryClaim.create(claim("tenantA", "connA", { directoryId: "22222222-3333-4444-5555-666666666666" }))).rejects.toMatchObject({
      code: 11000,
    });
    await expect(DirectoryClaim.create(claim("tenantA", "connZ"))).rejects.toMatchObject({ code: 11000 });
  });

  test("directory ids are stored lower case, so case variants collide", async () => {
    await DirectoryClaim.create(asVerified(claim("tenantA", "connA", { directoryId: DIR.toUpperCase() })));
    expect((await DirectoryClaim.findOne({ tenantId: "tenantA" }).lean()).directoryId).toBe(DIR);
    await expect(DirectoryClaim.create(asVerified(claim("tenantB", "connB")))).rejects.toMatchObject({ code: 11000 });
  });

  test("ownership cannot be moved by an update", async () => {
    await DirectoryClaim.create(asVerified(claim("tenantA", "connA")));
    await DirectoryClaim.updateOne({ connectionId: "connA" }, { tenantId: "tenantB", directoryId: DEV_DIR, connectionId: "connX" });
    expect(await DirectoryClaim.findOne({ connectionId: "connA" }).lean()).toMatchObject({ tenantId: "tenantA", directoryId: DIR });
  });

  test("DEV exception: shared verified claims coexist under the DEV conditions, never with a normal verified claim", async () => {
    Object.assign(process.env, DEV_ENV);
    const dev = (t) => asVerified(claim(`tenant${t}`, `conn${t}`, { directoryId: DEV_DIR, method: "dev-exception" }));
    await DirectoryClaim.create(dev("A"));
    await DirectoryClaim.create(dev("B"));
    expect(await DirectoryClaim.countDocuments({ directoryId: DEV_DIR, status: "verified" })).toBe(2);
    await expect(DirectoryClaim.create(asVerified(claim("tenantC", "connC", { directoryId: DEV_DIR })))).rejects.toMatchObject({
      code: "DIRECTORY_ALREADY_CLAIMED",
    });
  });

  test("DEV exception claim cannot be created outside the DEV conditions", async () => {
    await expect(
      DirectoryClaim.create(asVerified(claim("tenantA", "connA", { directoryId: DEV_DIR, method: "dev-exception" })))
    ).rejects.toMatchObject({ name: "ValidationError" });
  });

  test("a verified normal claim blocks later DEV-exception claims for that directory", async () => {
    Object.assign(process.env, DEV_ENV);
    await DirectoryClaim.create(asVerified(claim("tenantA", "connA", { directoryId: DEV_DIR })));
    await expect(
      DirectoryClaim.create(asVerified(claim("tenantB", "connB", { directoryId: DEV_DIR, method: "dev-exception" })))
    ).rejects.toMatchObject({ code: "DIRECTORY_ALREADY_CLAIMED" });
  });
});
