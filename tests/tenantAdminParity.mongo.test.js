/**
 * TENANT_ADMIN source bootstrap parity against a real MongoDB: the empty-catalogue seed,
 * scripts/ensure-tenant-admin.js (existing environments) and new-tenant provisioning.
 *
 * Runs only when STAGE5B_MONGO_URI points at a DISPOSABLE MongoDB (same variable as the other
 * database suites); skipped otherwise. Each test uses its own database, dropped afterwards.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");

const URI = process.env.STAGE5B_MONGO_URI;
const run = URI ? describe : describe.skip;
const { run: ensure } = require("../scripts/ensure-tenant-admin");
const { TENANT_ADMIN_PERMISSION, SEMANTIC_FIELDS } = require("../constants/tenantAdminPermission");

run("TENANT_ADMIN bootstrap parity against MongoDB", () => {
  let db;
  let n = 0;
  const oid = () => new mongoose.Types.ObjectId();
  const hash = async (name, filter = {}) =>
    crypto.createHash("sha256").update(JSON.stringify(await db.collection(name).find(filter).sort({ _id: 1 }).toArray())).digest("hex");
  const snapshot = async () => ({ permissions: await hash("permissions"), roles: await hash("roles"), users: await hash("users"), tenants: await hash("tenants") });
  const perm = (code, resource, action, extra = {}) => ({ _id: oid(), code, name: code, description: code, resource, action, category: "TENANT", level: 1, isActive: true, isSystemPermission: true, ...extra });
  const role = (tenantId, code, permissions, extra = {}) => ({ _id: oid(), tenantId: String(tenantId), code, name: `${code}-${tenantId}`, description: code, category: code === "ASU" || code === "SU" ? "SYSTEM" : "CRM", permissions, isActive: true, isSystemRole: code === "ASU" || code === "SU", ...extra });
  const roleOf = async (tenantId, code) => db.collection("roles").findOne({ tenantId: String(tenantId), code });
  const silence = () => { for (const m of ["log", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {}); };

  beforeEach(async () => {
    silence();
    await mongoose.connect(URI, { dbName: `tenantadmin_test_${Date.now()}_${n++}` });
    db = mongoose.connection.db;
  });
  afterEach(async () => {
    await db.dropDatabase();
    await mongoose.disconnect();
    jest.restoreAllMocks();
  });

  test("A fresh catalogue: the real seed creates exactly one canonical TENANT_ADMIN; a second run changes nothing", async () => {
    const PermissionHandler = require("../handlers/permission.handler");
    await PermissionHandler.initializeDefaultPermissions();
    const docs = await db.collection("permissions").find({ code: "TENANT_ADMIN" }).toArray();
    expect(docs).toHaveLength(1);
    for (const k of SEMANTIC_FIELDS) expect(docs[0][k]).toEqual(TENANT_ADMIN_PERMISSION[k]);
    expect(await db.collection("permissions").countDocuments({ resource: "tenant", action: "admin" })).toBe(1);
    const before = await hash("permissions");
    await PermissionHandler.initializeDefaultPermissions();
    expect(await hash("permissions")).toBe(before);
    expect(await db.collection("permissions").countDocuments({ code: "TENANT_ADMIN" })).toBe(1);
    const notif = await db.collection("permissions").find({ code: { $in: ["NOTIFICATION_READ", "NOTIFICATION_WRITE"] } }).project({ _id: 0, category: 1 }).toArray();
    expect(notif.map((p) => p.category)).toEqual(["COMMUNICATION", "COMMUNICATION"]);
    // and the ensure script agrees the fresh catalogue is canonical
    expect((await ensure(db)).drift).toEqual([]);
  });

  async function existingEnvironment({ withTenantAdmin = false } = {}) {
    const T1 = oid(), T2 = oid();
    await db.collection("tenants").insertMany([{ _id: T1, code: "ORGA", name: "A" }, { _id: T2, code: "ORGB", name: "B" }]);
    const read = perm("TENANT_READ", "tenant", "read");
    const admin = perm("TENANT_ADMIN", "tenant", "admin", { ...TENANT_ADMIN_PERMISSION });
    await db.collection("permissions").insertMany([read, perm("TENANT_WRITE", "tenant", "write"), perm("USER_READ", "user", "read"), ...(withTenantAdmin ? [admin] : [])]);
    await db.collection("roles").insertMany([
      role(T1, "ASU", ["USER_READ"]), // missing both
      role(T2, "ASU", withTenantAdmin ? ["TENANT_READ", String(admin._id)] : [String(read._id)]), // TENANT_READ by ObjectId form
      role(T1, "SU", ["TENANT_READ", "TENANT_WRITE"]),
      role(T1, "REO", ["TENANT_WRITE"]),
      role(T2, "MO", ["TENANT_READ"]),
      role(T2, "ASUX", ["USER_READ"]), // not ASU
      role(T1, "ASU-OLD", []),
    ]);
    const asuIds = [(await roleOf(T1, "ASU"))._id, (await roleOf(T2, "ASU"))._id];
    await db.collection("users").insertMany([
      { _id: oid(), tenantId: String(T1), userType: "CRM", userEmail: "a@x", roles: [(await roleOf(T1, "REO"))._id] },
      { _id: oid(), tenantId: String(T2), userType: "CRM", userEmail: "b@x", roles: [(await roleOf(T2, "MO"))._id] },
    ]);
    return { T1, T2, asuIds, read, admin };
  }

  test("B existing environment missing TENANT_ADMIN: dry run writes nothing; execute adds only the permission + ASU grants; rerun = 0 writes", async () => {
    const { T1, T2, read } = await existingEnvironment();
    const before = await snapshot();
    const otherRolesBefore = await hash("roles", { code: { $ne: "ASU" } });

    const dry = await ensure(db);
    expect(dry).toMatchObject({ ok: true, executed: false, permission: "MISSING", asuRoles: 2, asuNeedingChange: 2, writes: 0, writesRequired: 3 });
    expect(await snapshot()).toEqual(before);

    const ex = await ensure(db, { execute: true });
    expect(ex).toMatchObject({ ok: true, permissionCreated: true, rolesUpdated: 2, writes: 3 });
    const created = await db.collection("permissions").find({ code: "TENANT_ADMIN" }).toArray();
    expect(created).toHaveLength(1);
    for (const k of SEMANTIC_FIELDS) expect(created[0][k]).toEqual(TENANT_ADMIN_PERMISSION[k]);
    expect((await roleOf(T1, "ASU")).permissions).toEqual(["USER_READ", "TENANT_READ", "TENANT_ADMIN"]);
    // TENANT_READ held by ObjectId form -> not duplicated as a code
    expect((await roleOf(T2, "ASU")).permissions).toEqual([String(read._id), "TENANT_ADMIN"]);
    expect(await hash("roles", { code: { $ne: "ASU" } })).toBe(otherRolesBefore); // SU, REO, MO, ASUX, ASU-OLD untouched
    expect(await hash("users")).toBe(before.users);
    expect(await hash("tenants")).toBe(before.tenants);

    const after = await snapshot();
    const again = await ensure(db, { execute: true });
    expect(again).toMatchObject({ ok: true, permission: "PRESENT", drift: [], asuNeedingChange: 0, writes: 0 });
    expect(await snapshot()).toEqual(after);
  });

  test("C already-correct (DEV-like) state: dry run 0 required, execute 0 writes, byte-identical", async () => {
    await existingEnvironment({ withTenantAdmin: true });
    await db.collection("roles").updateOne({ code: "ASU", permissions: "USER_READ" }, { $set: { permissions: ["TENANT_READ", "TENANT_ADMIN"] } });
    const before = await snapshot();
    expect(await ensure(db)).toMatchObject({ ok: true, permission: "PRESENT", drift: [], asuRoles: 2, asuNeedingChange: 0, writesRequired: 0 });
    expect(await ensure(db, { execute: true })).toMatchObject({ ok: true, writes: 0 });
    expect(await ensure(db, { execute: true })).toMatchObject({ ok: true, writes: 0 });
    expect(await snapshot()).toEqual(before);
    expect(await db.collection("permissions").countDocuments({ code: "TENANT_ADMIN" })).toBe(1);
  });

  test("D conflict: tenant/admin under another code -> refused, nothing written (dry run and execute)", async () => {
    await existingEnvironment();
    await db.collection("permissions").insertOne(perm("TENANT_MANAGE", "tenant", "admin"));
    const before = await snapshot();
    for (const execute of [false, true]) {
      const r = await ensure(db, { execute });
      expect(r).toMatchObject({ ok: false, permission: "CONFLICT", writes: 0 });
      expect(r.reason).toMatch(/TENANT_MANAGE/);
    }
    expect(await snapshot()).toEqual(before);
  });

  test("E metadata drift: reported, never overwritten (ASU grants still converge)", async () => {
    await existingEnvironment({ withTenantAdmin: true });
    await db.collection("permissions").updateOne({ code: "TENANT_ADMIN" }, { $set: { level: 50, description: "custom" } });
    const permBefore = await hash("permissions");
    const r = await ensure(db, { execute: true });
    expect(r).toMatchObject({ ok: true, permission: "PRESENT", permissionCreated: false });
    expect(r.drift).toEqual(["description", "level"]);
    expect(await hash("permissions")).toBe(permBefore);
  });

  test("--tenant limits the change to that tenant's ASU (by code or id); unknown tenant refused", async () => {
    const { T1, T2 } = await existingEnvironment();
    const t2Before = JSON.stringify(await roleOf(T2, "ASU"));
    const r = await ensure(db, { execute: true, tenant: "orga" });
    expect(r).toMatchObject({ ok: true, asuRoles: 1, rolesUpdated: 1 });
    expect((await roleOf(T1, "ASU")).permissions).toContain("TENANT_ADMIN");
    expect(JSON.stringify(await roleOf(T2, "ASU"))).toBe(t2Before);
    expect(await ensure(db, { execute: true, tenant: String(T2) })).toMatchObject({ ok: true, asuRoles: 1, rolesUpdated: 1 });
    expect(await ensure(db, { tenant: "NOPE" })).toMatchObject({ ok: false, reason: "TENANT_NOT_FOUND" });
  });

  describe("new-tenant provisioning (real createTenant)", () => {
    const newTenant = (code) => ({ name: `Org ${code}`, code, description: "test", domain: `${code.toLowerCase()}.example.org`, contactEmail: `admin@${code.toLowerCase()}.example.org` });

    test("copied ASU gets TENANT_READ + TENANT_ADMIN; REO / MO / SU do not; users unchanged", async () => {
      const TenantHandler = require("../handlers/tenant.handler");
      const MAIN = oid();
      await db.collection("tenants").insertOne({ _id: MAIN, code: "MAIN", name: "Main", description: "m", domain: "main.example.org", contactEmail: "a@main.example.org" });
      await db.collection("permissions").insertMany([perm("TENANT_READ", "tenant", "read"), { ...perm("TENANT_ADMIN", "tenant", "admin"), ...TENANT_ADMIN_PERMISSION }]);
      await db.collection("roles").insertMany([role(MAIN, "ASU", ["ROLE_READ"]), role(MAIN, "SU", ["TENANT_READ"]), role(MAIN, "REO", ["TENANT_WRITE"]), role(MAIN, "MO", ["TENANT_READ"])]);
      await db.collection("users").insertOne({ _id: oid(), tenantId: String(MAIN), userEmail: "u@x", roles: [] });
      const usersBefore = await hash("users");
      const mainRolesBefore = await hash("roles", { tenantId: String(MAIN) });

      const t = await TenantHandler.createTenant(newTenant("NEWORG"), "test");
      const id = String(t._id);
      expect((await roleOf(id, "ASU")).permissions).toEqual(["ROLE_READ", "TENANT_READ", "TENANT_ADMIN"]);
      for (const code of ["SU", "REO", "MO"]) expect((await roleOf(id, code)).permissions).not.toContain("TENANT_ADMIN");
      expect((await roleOf(id, "REO")).permissions).toEqual(["TENANT_WRITE"]);
      expect(await hash("roles", { tenantId: String(MAIN) })).toBe(mainRolesBefore); // template untouched
      expect(await hash("users")).toBe(usersBefore);
      expect(await db.collection("users").countDocuments({ tenantId: id })).toBe(0);
    });

    test("no template (no MAIN) -> no roles: the hook invents nothing, tenant creation succeeds, gap logged safely", async () => {
      const TenantHandler = require("../handlers/tenant.handler");
      const usersBefore = await hash("users");
      const t = await TenantHandler.createTenant(newTenant("BARE"), "test");
      expect(t.code).toBe("BARE");
      expect(await db.collection("roles").countDocuments({ tenantId: String(t._id) })).toBe(0);
      expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/no ASU role/), { tenantId: String(t._id) });
      expect(await hash("users")).toBe(usersBefore);
    });

    test("the hook is idempotent and only touches that tenant's ASU", async () => {
      const { ensureTenantAdminOnNewTenant } = require("../handlers/tenant.handler");
      const T = oid(), OTHER = oid();
      await db.collection("roles").insertMany([role(T, "ASU", ["TENANT_ADMIN"]), role(OTHER, "ASU", [])]);
      expect(await ensureTenantAdminOnNewTenant(String(T))).toEqual({ status: "ADDED", added: ["TENANT_READ"] });
      expect(await ensureTenantAdminOnNewTenant(String(T))).toEqual({ status: "ALREADY_PRESENT" });
      expect((await roleOf(OTHER, "ASU")).permissions).toEqual([]);
    });
  });
});
