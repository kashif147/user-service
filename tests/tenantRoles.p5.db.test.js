/**
 * P5 - ensureTenantRoles + Role ownership / code immutability against a REAL single-node replica set (transactions).
 * Skipped without mongod. Nothing here is called by the service at runtime yet (no route, no template, no tenant
 * creation path).
 */
// The role handlers invalidate the tenant's role caches after every write; the cache module is replaced so this
// suite touches no Redis (the real helper is covered by tests/tenantRoles.p5.manifest.test.js).
const mockInvalidated = [];
jest.mock("../services/tenantRoleCache", () => ({ invalidateTenantRoleCaches: async (t) => { mockInvalidated.push(String(t)); return { invalidated: true, failed: [] }; } }));
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { mongodBin, startReplSet } = require("./helpers/replSetMongod");
const Role = require("../models/role.model");
const Permission = require("../models/permission.model");
const RoleHandler = require("../handlers/role.handler");
const { ensureTenantRoles } = require("../services/tenantRoleProvisioning");

jest.setTimeout(120000);
const describeDb = mongodBin ? describe : describe.skip;

const FIXTURE = {
  kind: "user-service:tenant-roles",
  version: 1,
  source: "test fixture",
  invariants: { insertMissingOnly: true },
  roles: [
    { code: "ASU", name: "Assistant Super User", description: "Highest tenant-level administrator", category: "SYSTEM", level: 95, isSystemRole: true, tenantAdmin: true, permissions: ["TENANT_ADMIN", "TENANT_READ"] },
    { code: "MO", name: "Membership Officer", description: "Membership Officer", category: "CRM", level: 60, isSystemRole: false, tenantAdmin: false, permissions: ["PROFILE_READ", "TENANT_READ"] },
    { code: "MEMBER", name: "Member", description: "Registered member", category: "PORTAL", level: 1, isSystemRole: false, tenantAdmin: false, permissions: ["PROFILE_READ"] },
  ],
};
const writeManifest = (m) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p5-roles-")), "tenantRoles.v1.json");
  fs.writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  return { file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), version: m.version };
};
const seedCatalogue = async (codes, { inactive = [] } = {}) => {
  await Permission.deleteMany({});
  await Permission.insertMany([...new Set(codes)].map((code) => {
    const i = code.lastIndexOf("_");
    return { code, name: code, description: code, resource: code.slice(0, i).toLowerCase(), action: code.slice(i + 1).toLowerCase(), category: "GENERAL", isActive: !inactive.includes(code) };
  }));
};
const hashDocs = async (filter) => crypto.createHash("md5").update(JSON.stringify(await mongoose.connection.db.collection("roles").find(filter).sort({ code: 1 }).toArray())).digest("hex");

describeDb("ensureTenantRoles (real replica set)", () => {
  let rs, A, B, fx, invalidate;
  beforeAll(async () => {
    rs = await startReplSet("p5-roles", "p5-roles-test");
    await Role.init();
    await Permission.init();
  });
  afterAll(async () => { if (rs) await rs.stop(); });
  beforeEach(async () => {
    const db = mongoose.connection.db;
    for (const c of ["roles", "tenants", "permissions"]) await db.collection(c).deleteMany({});
    A = String(new mongoose.Types.ObjectId());
    B = String(new mongoose.Types.ObjectId());
    await db.collection("tenants").insertMany([{ _id: new mongoose.Types.ObjectId(A), code: "P5A", domain: "p5a.test" }, { _id: new mongoose.Types.ObjectId(B), code: "P5B", domain: "p5b.test" }]);
    await seedCatalogue(FIXTURE.roles.flatMap((r) => r.permissions));
    fx = writeManifest(FIXTURE);
    invalidate = jest.fn(async () => ({ invalidated: true }));
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  const run = (tenant, over = {}, opts = {}) => ensureTenantRoles(tenant, { version: fx.version, sha256: fx.sha256, ...over }, { manifestFile: fx.file, invalidate, ...opts });

  test("empty tenant -> every manifest role inserted, tenant-owned, origin-marked; caches invalidated once for that tenant", async () => {
    const r = await run(A);
    expect(r).toMatchObject({ tenantId: A, manifestVersion: 1, manifestSha256: fx.sha256, inserted: ["ASU", "MO", "MEMBER"], skipped: [], conflicts: [] });
    const rows = await Role.find({ tenantId: A }).sort({ code: 1 }).lean();
    expect(rows.map((x) => x.code)).toEqual(["ASU", "MEMBER", "MO"]);
    for (const row of rows) {
      const m = FIXTURE.roles.find((x) => x.code === row.code);
      expect(row).toMatchObject({ tenantId: A, name: m.name, description: m.description, category: m.category, level: m.level, isSystemRole: m.isSystemRole, permissions: m.permissions, isActive: true, createdBy: "platform:provisioning" });
      expect(row.provisioning).toMatchObject({ component: "user-service:tenant-roles", manifestVersion: 1, manifestSha256: fx.sha256 });
    }
    expect(await Role.countDocuments({ tenantId: B })).toBe(0);
    expect(invalidate.mock.calls).toEqual([[A]]);
    expect(r.cache).toEqual({ invalidated: true, failed: [] });
  });

  test("duplicate invocation / replay is idempotent: nothing inserted or updated; caches re-invalidated for that tenant only", async () => {
    await run(A);
    const before = await hashDocs({ tenantId: A });
    invalidate.mockClear();
    const r = await run(A);
    expect(r.inserted).toEqual([]);
    expect(r.skipped).toEqual([{ code: "ASU", reason: "EXISTS" }, { code: "MO", reason: "EXISTS" }, { code: "MEMBER", reason: "EXISTS" }]);
    expect(await hashDocs({ tenantId: A })).toBe(before);
    expect(invalidate.mock.calls).toEqual([[A]]);
    expect(r.cache).toEqual({ invalidated: true, failed: [] });
  });

  test("two concurrent invocations: one complete role set, never a half set; the loser is CONCURRENT_ROLE_WRITE and a repeat is all EXISTS", async () => {
    const results = await Promise.allSettled([run(A), run(A)]);
    expect(results.filter((x) => x.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    for (const x of results.filter((y) => y.status === "rejected")) expect(x.reason).toMatchObject({ code: "CONCURRENT_ROLE_WRITE" });
    expect((await Role.find({ tenantId: A }).lean()).map((x) => x.code).sort()).toEqual(["ASU", "MEMBER", "MO"]);
    const r = await run(A);
    expect(r.inserted).toEqual([]);
    expect(r.skipped.map((x) => x.reason)).toEqual(["EXISTS", "EXISTS", "EXISTS"]);
  });

  test("tenant customisation preserved: customised / inactive roles skipped untouched; name collision reported; only missing inserted", async () => {
    await mongoose.connection.db.collection("roles").insertMany([
      { tenantId: A, code: "MO", name: "Membership Lead", description: "custom", category: "PORTAL", level: 7, permissions: ["X_CUSTOM"], isActive: true, isSystemRole: false },
      { tenantId: A, code: "MEMBER", name: "Member", description: "soft-deleted", category: "PORTAL", level: 1, permissions: [], isActive: false, isSystemRole: false },
      { tenantId: A, code: "CUSTOM", name: "Assistant Super User", description: "a custom role holding the ASU name", category: "CRM", level: 2, permissions: [], isActive: true, isSystemRole: false },
    ]);
    const before = await hashDocs({ tenantId: A, code: { $in: ["MO", "MEMBER", "CUSTOM"] } });
    const r = await run(A);
    expect(r.inserted).toEqual([]);
    expect(r.skipped).toEqual([{ code: "MO", reason: "EXISTS" }, { code: "MEMBER", reason: "EXISTS_INACTIVE" }]);
    expect(r.conflicts).toEqual([{ code: "ASU", reason: "NAME_TAKEN" }]);
    expect(await hashDocs({ tenantId: A, code: { $in: ["MO", "MEMBER", "CUSTOM"] } })).toBe(before);
    expect(await Role.countDocuments({ tenantId: A, code: "ASU" })).toBe(0);
  });

  test("no cross-tenant reuse: tenant B's roles neither satisfy nor are touched by provisioning A", async () => {
    await run(B);
    const bHash = await hashDocs({ tenantId: B });
    const r = await run(A);
    expect(r.inserted).toEqual(["ASU", "MO", "MEMBER"]);
    const aIds = (await Role.find({ tenantId: A }).lean()).map((x) => String(x._id));
    const bIds = (await Role.find({ tenantId: B }).lean()).map((x) => String(x._id));
    expect(aIds.filter((id) => bIds.includes(id))).toEqual([]);
    expect(await hashDocs({ tenantId: B })).toBe(bHash);
    expect(await mongoose.connection.db.collection("roles").countDocuments({ $or: [{ tenantId: null }, { tenantId: { $exists: false } }, { tenantId: "" }] })).toBe(0);
  });

  test.each([
    ["not an id", "P5A"],
    ["org code / Entra tid shaped", "39866a06-30bc-4a89-80c6-9dd9357dd453"],
    ["missing", undefined],
    ["non-existent tenant", "6b00000000000000000000ff"],
  ])("refused target tenant (%s) -> nothing written", async (_n, t) => {
    await expect(run(t)).rejects.toMatchObject({ code: t === "6b00000000000000000000ff" ? "TENANT_NOT_FOUND" : "INVALID_TENANT_ID" });
    expect(await Role.countDocuments()).toBe(0);
  });

  test("version / sha256 must match the local manifest exactly", async () => {
    await expect(run(A, { version: 2 })).rejects.toMatchObject({ code: "MANIFEST_DIGEST_MISMATCH" });
    await expect(run(A, { sha256: "0".repeat(64) })).rejects.toMatchObject({ code: "MANIFEST_DIGEST_MISMATCH" });
    await expect(run(A, { sha256: undefined })).rejects.toMatchObject({ code: "MANIFEST_DIGEST_MISMATCH" });
    expect(await Role.countDocuments()).toBe(0);
  });

  test("catalogue validation happens before the first insert: a missing or inactive code -> nothing written", async () => {
    await seedCatalogue(["TENANT_ADMIN", "TENANT_READ"]); // PROFILE_READ missing
    await expect(run(A)).rejects.toMatchObject({ code: "TENANT_ROLE_MANIFEST_INVALID" });
    await seedCatalogue(["TENANT_ADMIN", "TENANT_READ", "PROFILE_READ"], { inactive: ["PROFILE_READ"] });
    await expect(run(A)).rejects.toMatchObject({ code: "TENANT_ROLE_MANIFEST_INVALID", problems: ["permission PROFILE_READ is inactive in the catalogue"] });
    expect(await Role.countDocuments()).toBe(0);
  });

  test.each([
    ["retired SU role", (m) => m.roles.push({ ...m.roles[1], code: "SU", name: "Super User" })],
    ["platform permission", (m) => { m.roles[1].permissions = ["PLATFORM_TENANT_READ", "TENANT_READ"]; }],
    ["wildcard", (m) => { m.roles[1].permissions = ["*"]; }],
    ["second tenant admin", (m) => { m.roles[1].tenantAdmin = true; }],
  ])("an invalid manifest (%s) is refused before any write", async (_n, mutate) => {
    const m = JSON.parse(JSON.stringify(FIXTURE));
    mutate(m);
    fx = writeManifest(m);
    await expect(run(A)).rejects.toMatchObject({ code: "TENANT_ROLE_MANIFEST_INVALID" });
    expect(await Role.countDocuments()).toBe(0);
  });

  test("all or nothing: a concurrent insert of one role aborts the whole set; a repeat completes it", async () => {
    const original = Role.insertMany.bind(Role);
    jest.spyOn(Role, "insertMany").mockImplementationOnce(async (docs, opts) => {
      await mongoose.connection.db.collection("roles").insertOne({ tenantId: A, code: "MEMBER", name: "Member (concurrent)", description: "x", category: "PORTAL", level: 1, permissions: [], isActive: true });
      return original(docs, opts);
    });
    await expect(run(A)).rejects.toMatchObject({ code: "CONCURRENT_ROLE_WRITE" });
    expect((await Role.find({ tenantId: A }).lean()).map((x) => x.code)).toEqual(["MEMBER"]); // only the concurrent row
    expect(invalidate).not.toHaveBeenCalled();
    const r = await run(A);
    expect([r.inserted, r.skipped]).toEqual([["ASU", "MO"], [{ code: "MEMBER", reason: "EXISTS" }]]);
  });

  test("manifest absent from the build -> MANIFEST_NOT_FOUND, fail closed, nothing written", async () => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p5-roles-")), "tenantRoles.v1.json");
    await expect(ensureTenantRoles(A, { version: 1, sha256: fx.sha256 }, { manifestFile: missing, invalidate })).rejects.toMatchObject({ name: "TenantRoleProvisioningError", code: "MANIFEST_NOT_FOUND" });
    expect(await Role.countDocuments()).toBe(0);
    expect(invalidate).not.toHaveBeenCalled();
  });

  test("transaction failure / crash before commit: insertMany ran inside the transaction, then the transaction throws -> zero rows persisted, ROLE_TRANSACTION_FAILED; retry completes", async () => {
    const original = Role.insertMany.bind(Role);
    jest.spyOn(Role, "insertMany").mockImplementationOnce(async (docs, opts) => {
      await original(docs, opts); // rows written inside the session...
      expect(await Role.countDocuments({ tenantId: A }).session(opts.session)).toBe(3);
      throw new Error("simulated crash before commit"); // ...and the process dies before commit
    });
    await expect(run(A)).rejects.toMatchObject({ code: "ROLE_TRANSACTION_FAILED" });
    expect(await Role.countDocuments({ tenantId: A })).toBe(0);
    expect(invalidate).not.toHaveBeenCalled();
    const r = await run(A); // retry after failure
    expect(r.inserted).toEqual(["ASU", "MO", "MEMBER"]);
    expect(await Role.countDocuments({ tenantId: A })).toBe(3);
  });

  test("retry after a refused attempt (catalogue mismatch) completes once the catalogue is fixed", async () => {
    await seedCatalogue(["TENANT_ADMIN", "TENANT_READ"]);
    await expect(run(A)).rejects.toMatchObject({ code: "TENANT_ROLE_MANIFEST_INVALID" });
    expect(await Role.countDocuments()).toBe(0);
    await seedCatalogue(FIXTURE.roles.flatMap((r) => r.permissions));
    expect((await run(A)).inserted).toEqual(["ASU", "MO", "MEMBER"]);
  });

  test.each([
    ["reports a failed step", async () => ({ invalidated: false, failed: ["role_hierarchy"] })],
    ["throws", async () => { throw new Error("redis down"); }],
  ])("cache invalidation failure (%s): roles stay committed, result reports CACHE_INVALIDATION_FAILED; a retry re-invalidates", async (_n, failing) => {
    invalidate.mockImplementationOnce(failing);
    const r = await run(A);
    expect(r.inserted).toEqual(["ASU", "MO", "MEMBER"]);
    expect(r.cache).toMatchObject({ invalidated: false, code: "CACHE_INVALIDATION_FAILED" });
    expect(await Role.countDocuments({ tenantId: A })).toBe(3);
    const again = await run(A);
    expect(again.inserted).toEqual([]);
    expect(again.cache).toEqual({ invalidated: true, failed: [] });
    expect(invalidate.mock.calls).toEqual([[A], [A]]);
  });

  describe("Role ownership + manifest-origin code immutability", () => {
    let provisioned, plain;
    beforeEach(async () => {
      await run(A);
      provisioned = await Role.findOne({ tenantId: A, code: "MO" });
      plain = await Role.create({ tenantId: A, code: "LOCAL", name: "Local role", description: "tenant custom", category: "CRM", permissions: [] });
    });

    test("tenantId can never change: $set, top-level, $unset, replacement, save", async () => {
      await expect(Role.updateOne({ _id: plain._id, tenantId: A }, { $set: { tenantId: B } })).rejects.toMatchObject({ code: "TENANT_IMMUTABLE" });
      await expect(Role.findOneAndUpdate({ _id: plain._id, tenantId: A }, { tenantId: B })).rejects.toMatchObject({ code: "TENANT_IMMUTABLE" });
      await expect(Role.updateOne({ _id: plain._id }, { $unset: { tenantId: 1 } })).rejects.toMatchObject({ code: "TENANT_IMMUTABLE" });
      await expect(Role.replaceOne({ _id: plain._id, tenantId: A }, { tenantId: B, code: "LOCAL", name: "x", description: "x", category: "CRM" })).rejects.toMatchObject({ code: "TENANT_IMMUTABLE" });
      const doc = await Role.findById(plain._id);
      doc.tenantId = B;
      await doc.save();
      expect((await Role.findById(plain._id).lean()).tenantId).toBe(A);
    });

    test("cross-tenant lookup / update fails closed (filter tenant mismatch -> no match, nothing changed)", async () => {
      const before = await hashDocs({ tenantId: A });
      expect(await Role.findOneAndUpdate({ _id: plain._id, tenantId: B }, { $set: { name: "hijack" } })).toBeNull();
      await expect(RoleHandler.updateRole(String(plain._id), { name: "hijack", tenantId: B }, B, "u", { roles: ["ASU"], tenantId: B })).rejects.toThrow(/Role not found/);
      await expect(RoleHandler.updateRolePermissions(String(plain._id), ["TENANT_READ"], B, "u", { roles: ["ASU"], tenantId: B })).rejects.toThrow(/Role not found/);
      await expect(RoleHandler.deleteRole(String(plain._id), B)).rejects.toThrow(/Role not found/);
      expect(await hashDocs({ tenantId: A })).toBe(before);
    });

    test("provisioned role: code cannot change on any Mongoose path; name / description / permissions stay customisable", async () => {
      const id = provisioned._id;
      await expect(Role.updateOne({ _id: id }, { $set: { code: "MO2" } })).rejects.toMatchObject({ code: "ROLE_CODE_IMMUTABLE" });
      await expect(Role.findOneAndUpdate({ _id: id, tenantId: A }, { code: "MO2" })).rejects.toMatchObject({ code: "ROLE_CODE_IMMUTABLE" });
      await expect(Role.updateMany({ tenantId: A }, { $set: { code: "X" } })).rejects.toMatchObject({ code: "ROLE_CODE_IMMUTABLE" });
      await expect(Role.updateOne({ _id: id }, { $unset: { code: 1 } })).rejects.toMatchObject({ code: "ROLE_CODE_IMMUTABLE" });
      await expect(Role.replaceOne({ _id: id, tenantId: A }, { tenantId: A, code: "MO", name: "x", description: "x", category: "CRM" })).rejects.toMatchObject({ code: "ROLE_ORIGIN_IMMUTABLE" }); // replacing a provisioned role is refused outright
      await expect(Role.bulkWrite([{ updateOne: { filter: { _id: id }, update: { $set: { code: "MO2" } } } }])).rejects.toMatchObject({ code: "ROLE_CODE_IMMUTABLE" });
      const doc = await Role.findById(id);
      doc.code = "MO2";
      await expect(doc.save()).rejects.toMatchObject({ code: "ROLE_CODE_IMMUTABLE" });
      await expect(RoleHandler.updateRole(String(id), { code: "MO2" }, A, "u", { roles: ["ASU"], tenantId: A })).rejects.toMatchObject({ code: "ROLE_CODE_IMMUTABLE" });
      // same-value code is not a change; labels remain tenant customisation
      await RoleHandler.updateRole(String(id), { code: "MO", name: "Membership Lead", description: "renamed by the tenant" }, A, "u", { roles: ["ASU"], tenantId: A });
      expect(await Role.findById(id).lean()).toMatchObject({ code: "MO", name: "Membership Lead", description: "renamed by the tenant" });
    });

    test("the provisioning origin marker is immutable (cannot be removed to unlock the code)", async () => {
      const id = provisioned._id;
      const before = await hashDocs({ _id: id });
      for (const update of [{ $unset: { provisioning: 1 } }, { $set: { "provisioning.component": "other" } }, { $set: { provisioning: { component: "x", manifestVersion: 9, manifestSha256: "y", insertedAt: new Date() } } }, { provisioning: null }, { $rename: { code: "provisioning.code" } }]) {
        await expect(Role.updateOne({ _id: id }, update)).rejects.toMatchObject({ code: "ROLE_ORIGIN_IMMUTABLE" });
      }
      await expect(Role.updateOne({ _id: plain._id }, { $set: { provisioning: { component: "user-service:tenant-roles", manifestVersion: 1, manifestSha256: "z", insertedAt: new Date() } } })).rejects.toMatchObject({ code: "ROLE_ORIGIN_IMMUTABLE" }); // cannot be forged onto a custom role either
      await expect(Role.bulkWrite([{ updateOne: { filter: { _id: id }, update: { $set: { provisioning: null } } } }])).rejects.toMatchObject({ code: "ROLE_ORIGIN_IMMUTABLE" });
      expect(await hashDocs({ _id: id })).toBe(before); // every refused update left the document untouched
      const marker = (await Role.findById(id).lean()).provisioning;
      const doc = await Role.findById(id);
      doc.provisioning = undefined; // immutable path: mongoose ignores the assignment (the save only bumps updatedAt)
      await doc.save();
      expect((await Role.findById(id).lean()).provisioning).toEqual(marker);
    });

    test("role CRUD writes invalidate exactly the role's tenant caches (and refused writes do not)", async () => {
      mockInvalidated.length = 0;
      await RoleHandler.updateRole(String(plain._id), { name: "Local role 2" }, A, "u", { roles: ["ASU"], tenantId: A });
      await RoleHandler.updateRolePermissions(String(plain._id), ["TENANT_READ"], A, "u", { roles: ["ASU"], tenantId: A });
      await RoleHandler.deleteRole(String(plain._id), A);
      await RoleHandler.createRole({ code: "LOCAL3", name: "Local role 3", description: "x", category: "CRM", permissions: [] }, A, "u", { roles: ["ASU"], tenantId: A });
      expect(mockInvalidated).toEqual([A, A, A, A]);
      await expect(RoleHandler.updateRole(String(provisioned._id), { code: "MO2" }, A, "u", { roles: ["ASU"], tenantId: A })).rejects.toMatchObject({ code: "ROLE_CODE_IMMUTABLE" });
      await expect(RoleHandler.updateRole(String(plain._id), { name: "x" }, B, "u", { roles: ["ASU"], tenantId: B })).rejects.toThrow(/Role not found/);
      expect(mockInvalidated).toEqual([A, A, A, A]);
    });

    test("roles without the origin marker keep today's behaviour (code still editable by the tenant)", async () => {
      await RoleHandler.updateRole(String(plain._id), { code: "LOCAL2" }, A, "u", { roles: ["ASU"], tenantId: A });
      expect((await Role.findById(plain._id).lean()).code).toBe("LOCAL2");
    });
  });
});
