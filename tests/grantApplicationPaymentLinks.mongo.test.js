/**
 * scripts/grant-application-payment-links.js against a real MongoDB.
 *
 * Runs only when STAGE5B_MONGO_URI points at a DISPOSABLE MongoDB (same variable as the other
 * database suites); skipped otherwise. The test database is dropped.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const mongoose = require("mongoose");

const URI = process.env.STAGE5B_MONGO_URI;
const run = URI ? describe : describe.skip;
const { run: grant } = require("../scripts/grant-application-payment-links");

run("grant-application-payment-links against MongoDB", () => {
  let db;
  let tmp;
  const oid = () => new mongoose.Types.ObjectId();
  const TA = oid();
  const TB = oid();
  const TC = oid(); // a tenant that is never named
  const roles = () => db.collection("roles");
  const perms = () => db.collection("permissions");
  const role = (t, code, extra = {}) => ({
    _id: oid(), tenantId: String(t), code, name: `${code} role`, description: "x", category: "PORTAL",
    permissions: ["PORTAL_READ"], isActive: true, ...extra,
  });
  const backupFile = (n) => path.join(tmp, `backup-${n}-${Date.now()}.json`);
  const snapshot = async () => JSON.stringify(await roles().find({}).sort({ _id: 1 }).toArray());
  const holds = async (t, code) => (await roles().findOne({ tenantId: String(t), code })).permissions;

  beforeAll(async () => {
    await mongoose.connect(URI, { dbName: `paylinkgrant_test_${Date.now()}` });
    db = mongoose.connection.db;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paylinkgrant-"));
  });
  afterAll(async () => {
    await db.dropDatabase();
    await mongoose.disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await db.collection("tenants").deleteMany({});
    await roles().deleteMany({});
    await perms().deleteMany({});
    await db.collection("tenants").insertMany([
      { _id: TA, code: "TENA", name: "A", isActive: true },
      { _id: TB, code: "TENB", name: "B", isActive: true },
      { _id: TC, code: "TENC", name: "C", isActive: true },
    ]);
    await roles().insertMany([
      role(TA, "MO"), role(TA, "REO"), role(TA, "IRO"), role(TA, "AMO"),
      role(TB, "MO"), role(TB, "IRO"),
      role(TB, "REO", { isActive: false }), // inactive: never a target
      role(TC, "MO"), // tenant that is never named
    ]);
  });

  const R = "APPLICATION_PAYMENT_LINKS_READ";
  const W = "APPLICATION_PAYMENT_LINKS_WRITE";
  const SETS = { readRoles: ["MO", "REO"], writeRoles: ["MO"] };

  test("dry run (default): independent READ/WRITE plan, writes nothing", async () => {
    const before = await snapshot();
    const lines = [];
    const r = await grant(db, { tenants: ["TENA", "TENB"], ...SETS, log: (l) => lines.push(l) });
    expect(r).toMatchObject({ ok: true, executed: false, rolesMatched: 3, rolesNeedingChange: 3, writesRequired: 5, writes: 0 });
    expect(r.rolesMissing).toEqual(["TENB:REO"]);
    expect(await snapshot()).toBe(before);
    expect(await perms().countDocuments()).toBe(0);
    const out = lines.join("\n");
    expect(out).toMatch(/role sets: READ=MO,REO WRITE=MO/);
    expect(out).toMatch(/grant TENA MO: APPLICATION_PAYMENT_LINKS_READ, APPLICATION_PAYMENT_LINKS_WRITE/);
    expect(out).toMatch(/grant TENA REO: APPLICATION_PAYMENT_LINKS_READ$/m);
    expect(out).toMatch(/TENA IRO "IRO role"/); // inventory lists non-target roles too
    expect(out).not.toMatch(/mongodb:\/\//);
  });

  test("execute: MO gets READ+WRITE, REO gets READ only; nothing else changes; idempotent", async () => {
    const b1 = backupFile("g1");
    const r = await grant(db, { tenants: ["TENA", "TENB"], ...SETS, execute: true, backup: b1 });
    expect(r).toMatchObject({ ok: true, executed: true, permissionsCreated: 2, rolesUpdated: 3, writes: 5 });
    const catalogue = await perms().find({}).sort({ code: 1 }).toArray();
    expect(catalogue.map((p) => [p.code, p.resource, p.action])).toEqual([
      [R, "application-payment-links", "read"],
      [W, "application-payment-links", "write"],
    ]);
    expect(await holds(TA, "MO")).toEqual(["PORTAL_READ", R, W]);
    expect(await holds(TB, "MO")).toEqual(["PORTAL_READ", R, W]);
    expect(await holds(TA, "REO")).toEqual(["PORTAL_READ", R]);
    for (const [t, c] of [[TA, "IRO"], [TA, "AMO"], [TB, "IRO"], [TB, "REO"], [TC, "MO"]]) {
      expect(await holds(t, c)).toEqual(["PORTAL_READ"]);
    }
    const backup = JSON.parse(fs.readFileSync(b1, "utf8"));
    expect(backup.roles).toHaveLength(3);
    expect(backup.roles.every((x) => x.permissions.join() === "PORTAL_READ")).toBe(true); // pre-change state

    const again = await grant(db, { tenants: ["TENA", "TENB"], ...SETS, execute: true, backup: backupFile("g2") });
    expect(again).toMatchObject({ ok: true, permissionsCreated: 0, rolesNeedingChange: 0, rolesUpdated: 0, writes: 0 });
  });

  test("the sets are independent: a write-only role gets WRITE alone", async () => {
    await grant(db, { tenants: ["TENA"], writeRoles: ["IRO"], execute: true, backup: backupFile("wo") });
    expect(await holds(TA, "IRO")).toEqual(["PORTAL_READ", W]);
    expect(await holds(TA, "MO")).toEqual(["PORTAL_READ"]);
  });

  test("a role already holding a permission by ObjectId string is not given the code again", async () => {
    const id = oid();
    await perms().insertOne({ _id: id, code: R, name: "Read Application Payment Links", resource: "application-payment-links", action: "read", category: "CRM", level: 10, isSystemPermission: true, isActive: true });
    await roles().updateOne({ tenantId: String(TA), code: "MO" }, { $push: { permissions: String(id) } });
    await grant(db, { tenants: ["TENA"], ...SETS, execute: true, backup: backupFile("oid") });
    expect(await holds(TA, "MO")).toEqual(["PORTAL_READ", String(id), W]);
  });

  test("conflict: same resource/action under another code -> nothing written", async () => {
    await perms().insertOne({ code: "PAYLINK_W", name: "x", resource: "application-payment-links", action: "write", category: "CRM", level: 30 });
    const before = await snapshot();
    const r = await grant(db, { tenants: ["TENA"], ...SETS, execute: true, backup: backupFile("c") });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^CONFLICT application-payment-links:write/);
    expect(await snapshot()).toBe(before);
    expect(await perms().countDocuments()).toBe(1);
  });

  test("metadata drift is reported, never overwritten", async () => {
    await perms().insertOne({ code: R, name: "Custom", resource: "application-payment-links", action: "read", category: "CRM", level: 10, isSystemPermission: true, isActive: true });
    const r = await grant(db, { tenants: ["TENA"], ...SETS, execute: true, backup: backupFile("d") });
    expect(r.drift[R]).toEqual(["name"]);
    expect((await perms().findOne({ code: R })).name).toBe("Custom");
    expect(r.permissionsCreated).toBe(1); // only WRITE was missing
  });

  test("refusals: no tenant, unknown tenant, no role sets, refused role codes in either set, execute without backup", async () => {
    const before = await snapshot();
    expect((await grant(db, { ...SETS })).reason).toMatch(/^TENANT_REQUIRED/);
    expect((await grant(db, { tenants: ["NOPE"], ...SETS })).reason).toBe("TENANT_NOT_FOUND:NOPE");
    expect((await grant(db, { tenants: ["TENA"] })).reason).toMatch(/^ROLES_REQUIRED/);
    expect((await grant(db, { tenants: ["TENA"], readRoles: [], writeRoles: [] })).reason).toMatch(/^ROLES_REQUIRED/);
    for (const bad of ["SU", "ASU", "MEMBER", "NON-MEMBER"]) {
      expect((await grant(db, { tenants: ["TENA"], readRoles: ["MO", bad] })).reason).toBe(`ROLE_NOT_ALLOWED:${bad}`);
      expect((await grant(db, { tenants: ["TENA"], writeRoles: [bad.toLowerCase()] })).reason).toBe(`ROLE_NOT_ALLOWED:${bad}`);
    }
    expect((await grant(db, { tenants: ["TENA"], ...SETS, execute: true })).reason).toMatch(/^BACKUP_REQUIRED/);
    expect(await snapshot()).toBe(before);
    expect(await perms().countDocuments()).toBe(0);
  });

  test("revoke: pulls only the code(s) each named role is listed for (and their ids); catalogue kept", async () => {
    await grant(db, { tenants: ["TENA", "TENB"], ...SETS, execute: true, backup: backupFile("pre") });
    const id = String((await perms().findOne({ code: R }))._id);
    await roles().updateOne({ tenantId: String(TA), code: "REO" }, { $push: { permissions: id } });
    // narrower revoke first: READ from MO only -> MO keeps WRITE
    const r1 = await grant(db, { tenants: ["TENA"], readRoles: ["MO"], revoke: true, execute: true, backup: backupFile("rv1") });
    expect(r1).toMatchObject({ ok: true, mode: "revoke", rolesUpdated: 1 });
    expect(await holds(TA, "MO")).toEqual(["PORTAL_READ", W]);
    // full rollback of the decision
    const r2 = await grant(db, { tenants: ["TENA"], ...SETS, revoke: true, execute: true, backup: backupFile("rv2") });
    expect(r2).toMatchObject({ ok: true, mode: "revoke", rolesUpdated: 2 });
    expect(await holds(TA, "MO")).toEqual(["PORTAL_READ"]);
    expect(await holds(TA, "REO")).toEqual(["PORTAL_READ"]);
    expect(await holds(TB, "MO")).toEqual(["PORTAL_READ", R, W]); // other tenant untouched
    expect(await perms().countDocuments()).toBe(2);
  });

  test("after a grant, token-time resolution: MO read+write, REO read only, IRO none (what profile's requirePermission checks)", async () => {
    await grant(db, { tenants: ["TENA"], ...SETS, execute: true, backup: backupFile("jwt") });
    const ids = {};
    for (const c of ["MO", "REO", "IRO"]) ids[c] = (await roles().findOne({ tenantId: String(TA), code: c }))._id;
    const users = db.collection("users");
    const u = { MO: oid(), REO: oid(), IRO: oid() };
    await users.insertMany(Object.entries(u).map(([c, _id]) => ({ _id, tenantId: String(TA), userType: "CRM", userEmail: `${c.toLowerCase()}@x`, roles: [ids[c]], isActive: true })));
    const RoleHandler = require("../handlers/role.handler");
    const pay = async (c) => (await RoleHandler.getUserPermissions(u[c], String(TA))).filter((p) => p.startsWith("application-payment-links")).sort();
    expect(await pay("MO")).toEqual(["application-payment-links:read", "application-payment-links:write"]);
    expect(await pay("REO")).toEqual(["application-payment-links:read"]);
    expect(await pay("IRO")).toEqual([]);
    await users.deleteMany({});
  });

  test("backup file is never overwritten", async () => {
    const f = backupFile("once");
    fs.writeFileSync(f, "{}");
    await expect(grant(db, { tenants: ["TENA"], ...SETS, execute: true, backup: f })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await perms().countDocuments()).toBe(0);
  });
});
