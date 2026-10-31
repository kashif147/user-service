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
      role(TA, "IRO"), role(TA, "BO"), role(TA, "RO"), role(TA, "MO"),
      role(TB, "IRO"), role(TB, "BO"), // TENB has no RO
      role(TB, "RO", { isActive: false }),
      role(TC, "IRO"),
    ]);
  });

  test("dry run (default): reports the plan, writes nothing", async () => {
    const before = await snapshot();
    const lines = [];
    const r = await grant(db, { tenants: ["TENA", "TENB"], log: (l) => lines.push(l) });
    expect(r).toMatchObject({ ok: true, executed: false, rolesMatched: 5, rolesNeedingChange: 5, writesRequired: 7, writes: 0 });
    expect(r.rolesMissing).toEqual(["TENB:RO"]); // inactive RO is not a target
    expect(await snapshot()).toBe(before);
    expect(await perms().countDocuments()).toBe(0);
    expect(lines.join("\n")).toMatch(/TENA MO "MO role"/); // inventory lists non-target roles too
    expect(lines.join("\n")).not.toMatch(/mongodb:\/\//);
  });

  test("execute: creates both permissions, grants named roles in named tenants only; idempotent", async () => {
    const b1 = backupFile("g1");
    const r = await grant(db, { tenants: ["TENA", "TENB"], execute: true, backup: b1 });
    expect(r).toMatchObject({ ok: true, executed: true, permissionsCreated: 2, rolesUpdated: 5, writes: 7 });
    const catalogue = await perms().find({}).sort({ code: 1 }).toArray();
    expect(catalogue.map((p) => [p.code, p.resource, p.action])).toEqual([
      ["APPLICATION_PAYMENT_LINKS_READ", "application-payment-links", "read"],
      ["APPLICATION_PAYMENT_LINKS_WRITE", "application-payment-links", "write"],
    ]);
    for (const [t, c] of [[TA, "IRO"], [TA, "BO"], [TA, "RO"], [TB, "IRO"], [TB, "BO"]]) {
      expect(await holds(t, c)).toEqual(["PORTAL_READ", "APPLICATION_PAYMENT_LINKS_READ", "APPLICATION_PAYMENT_LINKS_WRITE"]);
    }
    expect(await holds(TA, "MO")).toEqual(["PORTAL_READ"]); // not a target code
    expect(await holds(TC, "IRO")).toEqual(["PORTAL_READ"]); // tenant not named
    const backup = JSON.parse(fs.readFileSync(b1, "utf8"));
    expect(backup.roles).toHaveLength(5);
    expect(backup.roles.every((x) => x.permissions.join() === "PORTAL_READ")).toBe(true); // pre-change state

    const again = await grant(db, { tenants: ["TENA", "TENB"], execute: true, backup: backupFile("g2") });
    expect(again).toMatchObject({ ok: true, permissionsCreated: 0, rolesNeedingChange: 0, rolesUpdated: 0, writes: 0 });
  });

  test("a role already holding the permission by ObjectId string is not given the code again", async () => {
    const id = oid();
    await perms().insertOne({ _id: id, code: "APPLICATION_PAYMENT_LINKS_READ", name: "Read Application Payment Links", resource: "application-payment-links", action: "read", category: "CRM", level: 10, isSystemPermission: true, isActive: true });
    await roles().updateOne({ tenantId: String(TA), code: "IRO" }, { $push: { permissions: String(id) } });
    await grant(db, { tenants: ["TENA"], roles: ["IRO"], execute: true, backup: backupFile("oid") });
    expect(await holds(TA, "IRO")).toEqual(["PORTAL_READ", String(id), "APPLICATION_PAYMENT_LINKS_WRITE"]);
  });

  test("conflict: same resource/action under another code -> nothing written", async () => {
    await perms().insertOne({ code: "PAYLINK_W", name: "x", resource: "application-payment-links", action: "write", category: "CRM", level: 30 });
    const before = await snapshot();
    const r = await grant(db, { tenants: ["TENA"], execute: true, backup: backupFile("c") });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^CONFLICT application-payment-links:write/);
    expect(await snapshot()).toBe(before);
    expect(await perms().countDocuments()).toBe(1);
  });

  test("metadata drift is reported, never overwritten", async () => {
    await perms().insertOne({ code: "APPLICATION_PAYMENT_LINKS_READ", name: "Custom", resource: "application-payment-links", action: "read", category: "CRM", level: 10, isSystemPermission: true, isActive: true });
    const r = await grant(db, { tenants: ["TENA"], execute: true, backup: backupFile("d") });
    expect(r.drift.APPLICATION_PAYMENT_LINKS_READ).toEqual(["name"]);
    expect((await perms().findOne({ code: "APPLICATION_PAYMENT_LINKS_READ" })).name).toBe("Custom");
    expect(r.permissionsCreated).toBe(1); // only WRITE was missing
  });

  test("refusals: no tenant, unknown tenant, refused role codes, execute without backup", async () => {
    const before = await snapshot();
    expect((await grant(db, {})).reason).toMatch(/^TENANT_REQUIRED/);
    expect((await grant(db, { tenants: ["NOPE"] })).reason).toBe("TENANT_NOT_FOUND:NOPE");
    expect((await grant(db, { tenants: ["TENA"], roles: ["IRO", "SU"] })).reason).toBe("ROLE_NOT_ALLOWED:SU");
    expect((await grant(db, { tenants: ["TENA"], roles: ["MEMBER"] })).reason).toBe("ROLE_NOT_ALLOWED:MEMBER");
    expect((await grant(db, { tenants: ["TENA"], execute: true })).reason).toMatch(/^BACKUP_REQUIRED/);
    expect(await snapshot()).toBe(before);
    expect(await perms().countDocuments()).toBe(0);
  });

  test("revoke: pulls exactly the two codes (and their ids) from named roles; catalogue kept", async () => {
    await grant(db, { tenants: ["TENA", "TENB"], execute: true, backup: backupFile("pre") });
    const id = String((await perms().findOne({ code: "APPLICATION_PAYMENT_LINKS_READ" }))._id);
    await roles().updateOne({ tenantId: String(TA), code: "BO" }, { $push: { permissions: id } });
    const r = await grant(db, { tenants: ["TENA"], revoke: true, execute: true, backup: backupFile("rv") });
    expect(r).toMatchObject({ ok: true, mode: "revoke", rolesUpdated: 3 });
    for (const c of ["IRO", "BO", "RO"]) expect(await holds(TA, c)).toEqual(["PORTAL_READ"]);
    expect(await holds(TB, "IRO")).toContain("APPLICATION_PAYMENT_LINKS_WRITE"); // other tenant untouched
    expect(await perms().countDocuments()).toBe(2);
  });

  test("after a grant, token-time resolution yields application-payment-links:read/write (what profile's requirePermission checks)", async () => {
    await grant(db, { tenants: ["TENA"], roles: ["IRO"], execute: true, backup: backupFile("jwt") });
    const iro = await roles().findOne({ tenantId: String(TA), code: "IRO" });
    const mo = await roles().findOne({ tenantId: String(TA), code: "MO" });
    const users = db.collection("users");
    const u1 = oid();
    const u2 = oid();
    await users.insertMany([
      { _id: u1, tenantId: String(TA), userType: "CRM", userEmail: "iro@x", roles: [iro._id], isActive: true },
      { _id: u2, tenantId: String(TA), userType: "CRM", userEmail: "mo@x", roles: [mo._id], isActive: true },
    ]);
    const RoleHandler = require("../handlers/role.handler");
    const p1 = await RoleHandler.getUserPermissions(u1, String(TA));
    expect(p1).toEqual(expect.arrayContaining(["application-payment-links:read", "application-payment-links:write"]));
    expect(p1).not.toContain("application:payment:links:write");
    const p2 = await RoleHandler.getUserPermissions(u2, String(TA));
    expect(p2.some((p) => p.startsWith("application-payment-links"))).toBe(false);
    await users.deleteMany({});
  });

  test("backup file is never overwritten", async () => {
    const f = backupFile("once");
    fs.writeFileSync(f, "{}");
    await expect(grant(db, { tenants: ["TENA"], execute: true, backup: f })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await perms().countDocuments()).toBe(0);
  });
});
