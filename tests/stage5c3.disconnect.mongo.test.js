/**
 * Stage 5c-3 Disconnect against a real MongoDB REPLICA SET (transactions), plus the index migration.
 *
 * Runs only when STAGE5B_MONGO_URI points at a DISPOSABLE MongoDB that is a replica set (same
 * variable as the Stage 5b / 5c database suites); skipped otherwise. Test databases are dropped.
 */
const mongoose = require("mongoose");

const URI = process.env.STAGE5B_MONGO_URI;
const run = URI ? describe : describe.skip;

const ENTRA = "Entra ID (Azure AD)";
const DIR = "11111111-2222-3333-4444-555555555555";
const DIR2 = "22222222-3333-4444-5555-666666666666";
const GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";
const OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const DEV_ENV = ["DEPLOYMENT_ENV", "ENTRA_ALLOW_SHARED_DIRECTORY", "ENTRA_SHARED_DIRECTORY_ALLOWLIST", "ENTRA_CRM_MULTI_DIRECTORY"];

run("Stage 5c-3 Disconnect against a MongoDB replica set", () => {
  let Tenant;
  let DirectoryClaim;
  let H;
  let service;
  const tA = new mongoose.Types.ObjectId();
  const tB = new mongoose.Types.ObjectId();
  const cA = new mongoose.Types.ObjectId();
  const cB = new mongoose.Types.ObjectId();
  const b2c = new mongoose.Types.ObjectId();
  const role = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await mongoose.connect(URI, { dbName: `stage5c3_test_${Date.now()}` });
    Tenant = require("../models/tenant.model");
    DirectoryClaim = require("../models/directoryClaim.model");
    H = require("../handlers/entraConnect.handler");
    service = require("../helpers/directoryClaimService");
    H._setTransactionRunnerForTests(null); // the real session.withTransaction
    await DirectoryClaim.init();
    await Tenant.createCollection().catch(() => {});
    await mongoose.connection.db.createCollection("users").catch(() => {});
    await mongoose.connection.db.createCollection("roles").catch(() => {});
  });
  beforeEach(async () => {
    for (const k of DEV_ENV) delete process.env[k];
    await DirectoryClaim.deleteMany({});
    await Tenant.collection.deleteMany({});
    const conn = (id, dir, extra = {}) => ({
      _id: id,
      connectionType: ENTRA,
      directoryId: dir,
      isActive: true,
      autoProvisionUsers: true,
      defaultRoleId: role,
      connectedAt: new Date("2026-10-16T10:00:00Z"),
      connectedBy: "u0",
      lastTestedAt: new Date("2026-10-16T11:00:00Z"),
      lastTestResult: { ok: true, code: "CONNECTED" },
      ...extra,
    });
    await Tenant.collection.insertMany([
      { _id: tA, name: "Org A", code: "ORGA", description: "Org A", domain: "orga.example", isActive: true, authenticationConnections: [conn(cA, DIR), { _id: b2c, connectionType: "Azure B2C", directoryId: "x", isActive: true }] },
      { _id: tB, name: "Org B", code: "ORGB", description: "Org B", domain: "orgb.example", isActive: true, authenticationConnections: [conn(cB, DIR2)] },
    ]);
    await service.recordVerifiedConnectClaim({ tenantId: String(tA), connectionId: String(cA), directoryId: DIR, userId: "u0", evidence: { directoryUserId: OID, roleTemplateId: GLOBAL_ADMIN } });
    await service.recordVerifiedConnectClaim({ tenantId: String(tB), connectionId: String(cB), directoryId: DIR2, userId: "u0", evidence: { directoryUserId: OID, roleTemplateId: GLOBAL_ADMIN } });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  const raw = async () => ({
    tenants: await Tenant.collection.find({}).sort({ _id: 1 }).toArray(),
    claims: await DirectoryClaim.collection.find({}).sort({ _id: 1 }).toArray(),
  });
  const disconnect = (over = {}) => H.disconnectConnection({ tenantId: String(tA), connectionId: String(cA), userId: "admin1", ...over });
  const code = async (p) => {
    try {
      await p;
      return "OK";
    } catch (e) {
      return e.code || e.name;
    }
  };

  test("atomic commit: connection inactive + claim revoked, one timestamp; nothing else changes", async () => {
    const before = await raw();
    const out = await disconnect();
    const after = await raw();
    const conn = after.tenants[0].authenticationConnections[0];
    const claim = after.claims.find((c) => c.connectionId === String(cA));
    expect(conn).toMatchObject({ isActive: false, disconnectedBy: "admin1" });
    expect(conn.disconnectedAt.getTime()).toBe(out.disconnectedAt.getTime());
    expect(claim).toMatchObject({ status: "revoked", revokedBy: "user:admin1" });
    expect(claim.revokedAt.getTime()).toBe(out.disconnectedAt.getTime());
    const strip = (c, keys) => Object.fromEntries(Object.entries(c).filter(([k]) => !keys.includes(k)));
    expect(strip(conn, ["isActive", "disconnectedAt", "disconnectedBy"])).toEqual(strip(before.tenants[0].authenticationConnections[0], ["isActive"]));
    expect(strip(claim, ["status", "revokedAt", "revokedBy", "updatedAt"])).toEqual(strip(before.claims.find((c) => c.connectionId === String(cA)), ["status", "revokedAt", "revokedBy", "updatedAt"]));
    expect(after.tenants[1]).toEqual(before.tenants[1]);
    expect(after.tenants[0].authenticationConnections[1]).toEqual(before.tenants[0].authenticationConnections[1]);
  });

  test("claim write failure after the connection write -> transaction rolled back: connection AND claim unchanged", async () => {
    const before = await raw();
    jest.spyOn(DirectoryClaim.prototype, "save").mockImplementationOnce(async function failingSave() {
      throw new Error("simulated claim write failure");
    });
    await expect(disconnect()).rejects.toThrow("simulated claim write failure");
    expect(await raw()).toEqual(before);
  });

  test("connection write failure -> claim unchanged", async () => {
    const before = await raw();
    jest.spyOn(Tenant, "updateOne").mockImplementationOnce(async () => {
      throw new Error("simulated connection write failure");
    });
    await expect(disconnect()).rejects.toThrow("simulated connection write failure");
    expect(await raw()).toEqual(before);
  });

  test("connection directory changed after the precondition -> CONNECTION_CHANGED, nothing written", async () => {
    const before = await raw();
    const realUpdate = Tenant.updateOne.bind(Tenant);
    jest.spyOn(Tenant, "updateOne").mockImplementationOnce((filter, update, opts) => {
      const f = JSON.parse(JSON.stringify(filter));
      f.authenticationConnections.$elemMatch.directoryId = DIR2; // as if edited in between
      f._id = filter._id;
      f.authenticationConnections.$elemMatch._id = filter.authenticationConnections.$elemMatch._id;
      return realUpdate(f, update, opts);
    });
    expect(await code(disconnect())).toBe("CONNECTION_CHANGED");
    expect(await raw()).toEqual(before);
  });

  test("users and roles are not touched", async () => {
    const db = mongoose.connection.db;
    await db.collection("users").insertOne({ tenantId: tA, userType: "CRM", roles: [{ roleId: role }] });
    await db.collection("roles").insertOne({ _id: role, tenantId: String(tA), code: "R" });
    const before = { u: await db.collection("users").find({}).toArray(), r: await db.collection("roles").find({}).toArray() };
    await disconnect();
    expect({ u: await db.collection("users").find({}).toArray(), r: await db.collection("roles").find({}).toArray() }).toEqual(before);
  });

  test("revoked history does not block a new verified claim: reconnect creates a new claim; the revoked one stays byte-identical", async () => {
    await disconnect();
    const revoked = await DirectoryClaim.collection.findOne({ connectionId: String(cA), status: "revoked" });
    const out = await service.recordVerifiedConnectClaim({ tenantId: String(tA), connectionId: String(cA), directoryId: DIR, userId: "admin2", evidence: { directoryUserId: OID, roleTemplateId: GLOBAL_ADMIN } });
    expect(out.created).toBe(true);
    expect(out.claimId).not.toBe(String(revoked._id));
    expect(await DirectoryClaim.collection.findOne({ _id: revoked._id })).toEqual(revoked);
    expect(await DirectoryClaim.countDocuments({ connectionId: String(cA) })).toBe(2);
    const c = await service.findConnectionClaim(String(cA));
    expect(c).toMatchObject({ status: "verified", verifiedBy: "user:admin2" });
  });

  test("another organisation may verify the released directory; the original organisation is then refused", async () => {
    await disconnect();
    await Tenant.collection.updateOne({ _id: tB, "authenticationConnections._id": cB }, { $set: { "authenticationConnections.$.directoryId": DIR } });
    await DirectoryClaim.deleteMany({ connectionId: String(cB) });
    await service.recordVerifiedConnectClaim({ tenantId: String(tB), connectionId: String(cB), directoryId: DIR, userId: "b1", evidence: { directoryUserId: OID, roleTemplateId: GLOBAL_ADMIN } });
    expect(await code(service.recordVerifiedConnectClaim({ tenantId: String(tA), connectionId: String(cA), directoryId: DIR, userId: "a1", evidence: { directoryUserId: OID, roleTemplateId: GLOBAL_ADMIN } }))).toBe("DIRECTORY_ALREADY_CLAIMED");
    expect(await DirectoryClaim.countDocuments({ directoryId: DIR, status: "verified" })).toBe(1);
  });

  test("race after a disconnect: several organisations reconnecting the same directory -> exactly one verified owner", async () => {
    await disconnect();
    const conns = ["X", "Y", "Z"].map((n) => ({ tenantId: `tenant${n}`, connectionId: `conn${n}` }));
    const results = await Promise.allSettled(
      [{ tenantId: String(tA), connectionId: String(cA) }, ...conns].map((c) =>
        service.recordVerifiedConnectClaim({ ...c, directoryId: DIR, userId: "u", evidence: { directoryUserId: OID, roleTemplateId: GLOBAL_ADMIN } })
      )
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await DirectoryClaim.countDocuments({ directoryId: DIR, status: "verified" })).toBe(1);
  });

  test("partial indexes: two ACTIVE claims for one connection / one tenant+directory are rejected; many revoked are allowed", async () => {
    const base = { connectionType: ENTRA, directoryId: DIR, tenantId: String(tA), connectionId: String(cA), method: "entra-admin-sign-in", claimedAt: new Date(), claimedBy: "u", sharedDirectoryException: false };
    await expect(DirectoryClaim.collection.insertOne({ ...base, status: "pending" })).rejects.toMatchObject({ code: 11000 });
    await expect(DirectoryClaim.collection.insertOne({ ...base, connectionId: "otherConn", status: "pending" })).rejects.toMatchObject({ code: 11000 });
    for (let i = 0; i < 3; i++) {
      await DirectoryClaim.collection.insertOne({ ...base, status: "revoked", verifiedAt: new Date(), verifiedBy: "u", revokedAt: new Date(Date.now() + i), revokedBy: "user:x" });
    }
    expect(await DirectoryClaim.countDocuments({ connectionId: String(cA), status: "revoked" })).toBe(3);
    // the active claim still wins the status lookup over revoked history
    expect(await service.findConnectionClaim(String(cA))).toMatchObject({ status: "verified" });
  });

  test("status, Test Connection and activation after disconnect (real database)", async () => {
    await disconnect();
    await expect(H.getConnectionStatus({ tenantId: String(tA), connectionId: String(cA) })).resolves.toMatchObject({ status: "disconnected", isActive: false });
    expect(await code(H.testConnection({ tenantId: String(tA), connectionId: String(cA) }))).toBe("CONNECTION_DISCONNECTED");
    const rules = require("../helpers/connectionDefaultRole");
    const stored = (await Tenant.collection.findOne({ _id: tA })).authenticationConnections[0];
    expect(
      await code(rules.assertConnectionWritable(String(tA), { connectionType: ENTRA, directoryId: DIR, isActive: true, autoProvisionUsers: false }, { connectionId: cA, stored }))
    ).toBe("CONNECTION_DISCONNECTED");
  });

  test("N sign-in after disconnect fails closed on every path (real tenant data)", async () => {
    await disconnect();
    const { resolveLoginTenant, loadLoginConnection } = require("../helpers/loginTenantContext");
    const { resolveTenantScopedUser, resolveApplicationTenant } = require("../helpers/identityTenantResolution");
    expect(await code(resolveLoginTenant("ORGA"))).toBe("NO_ENTRA_CONNECTION");
    expect(await code(loadLoginConnection({ tenantId: String(tA), connectionId: String(cA) }))).not.toBe("OK");
    const UserModel = { find: () => ({ lean: async () => [] }), findOne: () => ({ lean: async () => null }) };
    expect(
      await code(resolveTenantScopedUser({ tenantId: String(tA), connectionId: String(cA), connectionType: ENTRA, directoryId: DIR, email: "a@example.org", microsoftId: OID, UserModel }))
    ).toBe("CONNECTION_INVALID");
    expect(await code(resolveApplicationTenant({ connectionType: ENTRA, directoryId: DIR, email: "a@example.org", microsoftId: OID, UserModel, allowProvisioning: false }))).not.toBe("OK");
  });

  describe("delete / recreate bypass is closed (real connection write paths)", () => {
    const TH = () => require("../handlers/tenant.handler");
    const entra = (extra = {}) => ({ connectionType: ENTRA, directoryId: DIR, isActive: true, autoProvisionUsers: false, ...extra });
    const revokedClaim = () => DirectoryClaim.collection.findOne({ connectionId: String(cA), status: "revoked" });

    test("1 disconnect -> POST a new ACTIVE connection for the same directory -> 409 CONNECTION_DISCONNECTED (nothing written)", async () => {
      await disconnect();
      const before = await raw();
      expect(await code(TH().addAuthenticationConnection(String(tA), entra(), "admin1"))).toBe("CONNECTION_DISCONNECTED");
      expect(await raw()).toEqual(before);
    });

    test("1b disconnect -> soft DELETE -> POST new ACTIVE same directory -> 409; the revoked claim survives the delete", async () => {
      await disconnect();
      const revoked = await revokedClaim();
      await TH().removeAuthenticationConnection(String(tA), String(cA), "admin1");
      expect(await revokedClaim()).toEqual(revoked);
      expect(await code(TH().addAuthenticationConnection(String(tA), entra(), "admin1"))).toBe("CONNECTION_DISCONNECTED");
    });

    test("1c disconnect -> full-array PUT that drops the old connection and adds a new ACTIVE one -> 409, tenant unchanged", async () => {
      await disconnect();
      const before = await raw();
      const b2cConn = before.tenants[0].authenticationConnections[1];
      expect(await code(TH().updateTenant(String(tA), { authenticationConnections: [{ ...b2cConn, _id: String(b2cConn._id) }, entra()] }, "admin1"))).toBe("CONNECTION_DISCONNECTED");
      expect(await raw()).toEqual(before);
    });

    test("2-11 full replacement lifecycle: delete + inactive replacement -> 409 on activation -> Connect -> new claim -> activation allowed", async () => {
      const { makeTestKeypairAndJwks, signTestJwt } = require("./helpers/testJwt");
      const { _setJwksForTests } = require("../helpers/entraConnect");
      const { resolveEntraConnectConfig } = require("../helpers/connectionAuthConfig");
      const AzureADHandler = require("../handlers/azure.ad.handler");
      const kp = await makeTestKeypairAndJwks();
      _setJwksForTests(kp.jwks, resolveEntraConnectConfig().jwksUri);
      try {
        // 1-3 original verified, disconnect, claim revoked
        await disconnect();
        const revoked = await revokedClaim();
        expect(revoked).toBeTruthy();
        // 4-5 physically remove the old connection and add an INACTIVE replacement (full-array PUT)
        const t0 = await Tenant.collection.findOne({ _id: tA });
        const b2cConn = t0.authenticationConnections[1];
        await TH().updateTenant(String(tA), { authenticationConnections: [{ ...b2cConn, _id: String(b2cConn._id) }, entra({ isActive: false })] }, "admin1");
        const t1 = await Tenant.collection.findOne({ _id: tA });
        expect(t1.authenticationConnections.some((c) => String(c._id) === String(cA))).toBe(false); // old connection gone
        const replacement = t1.authenticationConnections.find((c) => c.connectionType === ENTRA);
        expect(replacement).toMatchObject({ directoryId: DIR, isActive: false });
        const rId = String(replacement._id);
        expect(await revokedClaim()).toEqual(revoked); // 7 deletion preserves the revoked history
        // 6 activation before Connect -> 409
        expect(await code(TH().updateAuthenticationConnection(String(tA), rId, { isActive: true }, "admin1"))).toBe("CONNECTION_DISCONNECTED");
        // 7-8 normal Connect on the replacement (Microsoft verification simulated with a signed ID token)
        const { authorizationUrl } = await H.startConnect({ tenantId: String(tA), connectionId: rId, userId: "admin1" });
        const u = new URL(authorizationUrl);
        jest.spyOn(AzureADHandler, "exchangeCodeForTokens").mockImplementation(async () => ({
          id_token: await signTestJwt(kp.privateKey, {
            iss: `https://login.microsoftonline.com/${DIR}/v2.0`,
            aud: process.env.AZURE_AD_CLIENT_ID,
            tid: DIR,
            oid: OID,
            nonce: u.searchParams.get("nonce"),
            wids: [GLOBAL_ADMIN],
          }),
        }));
        await H.completeConnect({ tenantId: String(tA), connectionId: rId, userId: "admin1", code: "c", state: u.searchParams.get("state") });
        // 9 a NEW verified claim for the replacement connection; 10 the old revoked claim is byte-identical
        const fresh = await DirectoryClaim.collection.findOne({ connectionId: rId, status: "verified" });
        expect(fresh).toBeTruthy();
        expect(String(fresh._id)).not.toBe(String(revoked._id));
        expect(fresh).toMatchObject({ tenantId: String(tA), directoryId: DIR, method: "entra-admin-sign-in" });
        expect(await revokedClaim()).toEqual(revoked);
        // 11 activation now succeeds
        await TH().updateAuthenticationConnection(String(tA), rId, { isActive: true }, "admin1");
        const t2 = await Tenant.collection.findOne({ _id: tA });
        expect(t2.authenticationConnections.find((c) => String(c._id) === rId)).toMatchObject({ isActive: true });
        expect(await revokedClaim()).toEqual(revoked);
      } finally {
        _setJwksForTests(null);
      }
    });

    test("8/9 other directory / other organisation's history do not trigger the guard (real data)", async () => {
      await disconnect(); // tenant A, DIR revoked
      await H.disconnectConnection({ tenantId: String(tB), connectionId: String(cB), userId: "b1" }); // tenant B, DIR2 revoked
      const DIR3 = "33333333-4444-5555-6666-777777777777";
      // tenant A: a different directory is unaffected
      await TH().addAuthenticationConnection(String(tA), entra({ directoryId: DIR3 }), "admin1");
      // tenant A: tenant B's revoked DIR2 history is not tenant A's (active Entra slot now taken, so add inactive and check the guard directly)
      const rules = require("../helpers/connectionDefaultRole");
      await expect(rules.assertConnectionWritable(String(tA), entra({ directoryId: DIR2 }))).resolves.toBeUndefined();
      expect(await code(rules.assertConnectionWritable(String(tB), entra({ directoryId: DIR2 })))).toBe("CONNECTION_DISCONNECTED");
    });
  });

  test("dev-exception and platform claims are refused and untouched", async () => {
    await DirectoryClaim.deleteMany({});
    await DirectoryClaim.collection.insertOne({ connectionType: ENTRA, directoryId: DIR, tenantId: String(tA), connectionId: String(cA), status: "verified", method: "platform", sharedDirectoryException: false, claimedAt: new Date(), claimedBy: "platform:x", verifiedAt: new Date(), verifiedBy: "platform:x" });
    const before = await raw();
    expect(await code(disconnect())).toBe("CLAIM_METHOD_CONFLICT");
    expect(await raw()).toEqual(before);
  });
});

run("migrate-directoryclaim-partial-indexes", () => {
  const migration = require("../scripts/migrate-directoryclaim-partial-indexes");
  let db;
  const names = async () => (await db.collection("directoryclaims").indexes()).map((i) => i.name).sort();
  const docs = async () => db.collection("directoryclaims").find({}).sort({ _id: 1 }).toArray();
  beforeAll(async () => {
    if (mongoose.connection.readyState !== 1) await mongoose.connect(URI, { dbName: `stage5c3_mig_${Date.now()}` });
  });
  beforeEach(async () => {
    db = mongoose.connection.useDb(`stage5c3_migration_${Date.now()}_${Math.floor(Math.random() * 1e6)}`).db;
    const coll = db.collection("directoryclaims");
    // the pre-5c-3 index set
    await coll.createIndex({ connectionType: 1, directoryId: 1 }, { name: "uniq_verified_directory", unique: true, partialFilterExpression: { status: "verified", sharedDirectoryException: false } });
    await coll.createIndex({ connectionType: 1, connectionId: 1 }, { name: "uniq_claim_per_connection", unique: true });
    await coll.createIndex({ connectionType: 1, directoryId: 1, tenantId: 1 }, { name: "uniq_claim_per_tenant_directory", unique: true });
    await coll.insertMany([
      { connectionType: ENTRA, directoryId: DIR, tenantId: "tA", connectionId: "cA", status: "verified", method: "dev-exception", sharedDirectoryException: true },
      { connectionType: ENTRA, directoryId: DIR, tenantId: "tB", connectionId: "cB", status: "verified", method: "dev-exception", sharedDirectoryException: true },
    ]);
  });
  afterAll(async () => {
    await mongoose.disconnect().catch(() => {});
  });

  test("dry run (default) makes zero changes", async () => {
    const before = { n: await names(), d: await docs() };
    const r = await migration.run(db);
    expect(r).toMatchObject({ ok: true, executed: false, created: [], dropped: [] });
    expect({ n: await names(), d: await docs() }).toEqual(before);
  });

  test("execute: creates the new partial indexes, verifies, then drops the old ones; documents untouched", async () => {
    const before = await docs();
    const r = await migration.run(db, { execute: true });
    expect(r).toMatchObject({ ok: true, executed: true });
    expect(r.created.sort()).toEqual(["uniq_active_claim_per_connection", "uniq_active_claim_per_tenant_directory"]);
    expect(r.dropped.sort()).toEqual(["uniq_claim_per_connection", "uniq_claim_per_tenant_directory"]);
    const idx = Object.fromEntries((await db.collection("directoryclaims").indexes()).map((i) => [i.name, i]));
    expect(idx.uniq_claim_per_connection).toBeUndefined();
    expect(idx.uniq_claim_per_tenant_directory).toBeUndefined();
    expect(idx.uniq_active_claim_per_connection).toMatchObject({ unique: true, key: { connectionType: 1, connectionId: 1 }, partialFilterExpression: { status: { $in: ["pending", "verified"] } } });
    expect(idx.uniq_active_claim_per_tenant_directory).toMatchObject({ unique: true, key: { connectionType: 1, directoryId: 1, tenantId: 1 }, partialFilterExpression: { status: { $in: ["pending", "verified"] } } });
    expect(idx.uniq_verified_directory.partialFilterExpression).toEqual({ status: "verified", sharedDirectoryException: false });
    expect(await docs()).toEqual(before);
  });

  test("execute is idempotent", async () => {
    await migration.run(db, { execute: true });
    const n = await names();
    const r = await migration.run(db, { execute: true });
    expect(r).toMatchObject({ ok: true, created: [], dropped: [] });
    expect(await names()).toEqual(n);
  });

  test("interrupted before the old-index drop: old and new coexist (stricter, safe); the next run completes", async () => {
    const r1 = await migration.run(db, { execute: true, dropOld: false });
    expect(r1).toMatchObject({ ok: true, dropped: [] });
    expect(await names()).toEqual(expect.arrayContaining(["uniq_claim_per_connection", "uniq_active_claim_per_connection"]));
    const r2 = await migration.run(db, { execute: true });
    expect(r2).toMatchObject({ ok: true, created: [] });
    expect(r2.dropped.sort()).toEqual(["uniq_claim_per_connection", "uniq_claim_per_tenant_directory"]);
  });

  test("data that would violate the new indexes -> refused before any change", async () => {
    const fresh = mongoose.connection.useDb(`stage5c3_migration_bad_${Date.now()}`).db;
    await fresh.collection("directoryclaims").insertMany([
      { connectionType: ENTRA, directoryId: DIR, tenantId: "t", connectionId: "c", status: "verified" },
      { connectionType: ENTRA, directoryId: DIR2, tenantId: "t", connectionId: "c", status: "pending" },
    ]);
    const before = (await fresh.collection("directoryclaims").indexes()).map((i) => i.name);
    const r = await migration.run(fresh, { execute: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/violate/);
    expect((await fresh.collection("directoryclaims").indexes()).map((i) => i.name)).toEqual(before);
  });
});
