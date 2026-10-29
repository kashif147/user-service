/**
 * Phase B / Z7 - User.tenantId is set once, from trusted context, and never changes.
 *
 * Runs the REAL User model with no database (bufferCommands off): a rejected write fails in middleware before
 * any connection is needed; `hydrate` gives an existing document without a read. Login / JIT behaviour is in
 * the login suites (azureAdHandler.tenantScopedLogin, azureAdHandler.applicationTenant, crmIdentityBinding,
 * b2cPortalIdentity, crmTokenContainment.persistence - their User mocks now refuse any sign-in write that
 * $sets tenantId and seed an upsert from its filter, as MongoDB does); cross-tenant events are in
 * listener.tenantScopedLookup / application.approval.listener.
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const User = require("../models/user.model");
const { TENANT_IMMUTABLE } = require("../models/plugins/tenantOwnership.plugin");

const A = "68cbf7806080b4621d469d34"; // MULTIAUTH
const B = "6acd6119b28a863c61361ae0"; // DEVTENANTB
const ENTRA_TID = "39866a06-30bc-4a89-80c6-9dd9357dd453";
const existing = () => User.hydrate({ _id: new mongoose.Types.ObjectId(), tenantId: A, userEmail: "z7@invalid.test", userType: "CRM", roles: [] });
const IMMUTABLE = { code: TENANT_IMMUTABLE, status: 409 };

let warn;
beforeAll(() => mongoose.set("bufferCommands", false));
beforeEach(() => { warn = jest.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe("existing User: tenantId cannot be reassigned (rejected, not silently restored)", () => {
  test.each([
    ["assignment", (d) => { d.tenantId = B; }],
    ["doc.set", (d) => d.set("tenantId", B)],
    ["Object.assign (login-style)", (d) => Object.assign(d, { tenantId: B, userFirstName: "x" })],
    ["null", (d) => { d.tenantId = null; }],
    ["placeholder", (d) => { d.tenantId = "default"; }],
    ["overwriteImmutable (forced internal path)", (d) => d.set("tenantId", B, { overwriteImmutable: true })],
  ])("%s -> save() rejected with 409 TENANT_IMMUTABLE", async (_n, mutate) => {
    const d = existing();
    mutate(d);
    await expect(d.save()).rejects.toMatchObject(IMMUTABLE);
    await expect(d.save({ validateBeforeSave: false })).rejects.toMatchObject(IMMUTABLE);
    expect(warn.mock.calls.some(([l]) => String(l).includes("TenantOwnershipViolation"))).toBe(true);
  });

  test("same value is not a change; other fields still save normally (only the database is missing)", async () => {
    const d = existing();
    d.tenantId = A;
    d.userFirstName = "Same";
    expect(d.isModified("tenantId")).toBe(false);
    const err = await d.save().catch((e) => e);
    expect(err && err.code).not.toBe(TENANT_IMMUTABLE);
  });
});

describe("query / bulk writes cannot move, unset or null User.tenantId", () => {
  const id = new mongoose.Types.ObjectId();
  test.each([
    ["updateOne $set other tenant", () => User.updateOne({ _id: id, tenantId: A }, { $set: { tenantId: B } })],
    ["updateOne $set without a tenant filter", () => User.updateOne({ _id: id }, { $set: { tenantId: A } })],
    ["updateOne top-level tenantId", () => User.updateOne({ _id: id, tenantId: A }, { tenantId: B })],
    ["updateMany $set", () => User.updateMany({ tenantId: A }, { $set: { tenantId: B } })],
    ["updateMany move-all (migration helper style)", () => User.updateMany({ tenantId: { $exists: false } }, { $set: { tenantId: A } })],
    ["findOneAndUpdate $set", () => User.findOneAndUpdate({ _id: id, tenantId: A }, { $set: { tenantId: B } })],
    ["findByIdAndUpdate $set", () => User.findByIdAndUpdate(id, { $set: { tenantId: B } })],
    ["$unset", () => User.updateOne({ _id: id, tenantId: A }, { $unset: { tenantId: "" } })],
    ["null", () => User.updateOne({ _id: id, tenantId: A }, { $set: { tenantId: null } })],
    ["default / unknown", () => User.updateOne({ _id: id, tenantId: A }, { $set: { tenantId: "unknown" } })],
    ["$rename", () => User.updateOne({ _id: id, tenantId: A }, { $rename: { tenantId: "oldTenant" } })],
    ["pipeline update", () => User.updateOne({ _id: id, tenantId: A }, [{ $set: { tenantId: B } }])],
    ["replaceOne dropping tenantId", () => User.replaceOne({ _id: id, tenantId: A }, { userEmail: "z7@invalid.test" })],
    ["replaceOne changing tenantId", () => User.replaceOne({ _id: id, tenantId: A }, { tenantId: B, userEmail: "z7@invalid.test" })],
    ["findOneAndReplace without a tenant filter", () => User.findOneAndReplace({ _id: id }, { tenantId: A })],
    ["upsert $setOnInsert another tenant", () => User.updateOne({ tenantId: A, userMicrosoftId: "x" }, { $setOnInsert: { tenantId: B } }, { upsert: true })],
  ])("%s -> 409 TENANT_IMMUTABLE before the database", async (_n, run) => {
    await expect(run()).rejects.toMatchObject(IMMUTABLE);
  });

  test("bulkWrite: updateOne / updateMany / replaceOne cannot move ownership", async () => {
    for (const op of [
      { updateOne: { filter: { _id: id, tenantId: A }, update: { $set: { tenantId: B } } } },
      { updateMany: { filter: { tenantId: A }, update: { $unset: { tenantId: 1 } } } },
      { replaceOne: { filter: { _id: id, tenantId: A }, replacement: { userEmail: "x" } } },
    ]) {
      await expect(User.bulkWrite([op])).rejects.toMatchObject(IMMUTABLE);
    }
  });

  test("a write filtered by the owner that does not touch tenantId passes the guard", async () => {
    const err = await User.updateOne({ _id: id, tenantId: A }, { $set: { userLastLogin: new Date() } }).catch((e) => e);
    expect(err && err.code).not.toBe(TENANT_IMMUTABLE);
  });
});

describe("creation: a real internal tenant id only (trusted context, never a placeholder)", () => {
  test.each([[undefined], [null], [""], ["default"], ["unknown"], ["system"], ["MULTIAUTH"], [ENTRA_TID], ["6ACD6119B28A863C61361AE0"], ["6acd6119b28a863c61361ae"]])(
    "tenantId %p -> validation error",
    (tenantId) => {
      const err = new User({ tenantId, userEmail: "z7@invalid.test" }).validateSync();
      expect(err && err.errors && err.errors.tenantId).toBeDefined();
    }
  );

  test("an internal tenant id validates", () => {
    expect(new User({ tenantId: A, userEmail: "z7@invalid.test" }).validateSync()).toBeUndefined();
  });

  test("insertMany with a placeholder tenant is rejected by validation", async () => {
    const err = await User.insertMany([{ tenantId: "default", userEmail: "z7@invalid.test" }]).catch((e) => e);
    expect(err && (err.name === "ValidationError" || (err.errors && err.errors.tenantId) || /tenantId/.test(String(err.message)))).toBeTruthy();
  });
});

describe("source guards: no login, JIT or API path writes or moves User ownership", () => {
  const ROOT = path.join(__dirname, "..");
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("CRM and portal sign-in: no tenantId in the update; existing users are written only inside the resolved tenant", () => {
    for (const f of ["handlers/azure.ad.handler.js", "handlers/b2c.users.handler.js"]) {
      const src = read(f);
      expect({ f, setsTenant: /updateData\.tenantId\s*=/.test(src) }).toEqual({ f, setsTenant: false });
      expect({ f, existingFilterHasTenant: /_id: existingUser\._id,\s*tenantId,/.test(src) }).toEqual({ f, existingFilterHasTenant: true });
    }
    const b2c = read("handlers/b2c.users.handler.js");
    expect(b2c).not.toMatch(/findLegacyPortalUser|migratingLegacyUser/); // legacy re-tenanting removed
  });

  test("no runtime path creates a User with a body / query / header controlled tenant", () => {
    const hits = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".js")) {
          const src = read(p);
          for (const m of src.matchAll(/(new User\(|User\.create\(|User\.insertMany\()[\s\S]{0,400}?\)/g)) {
            if (/tenantId:\s*(req\.(body|query|headers)|body\.|query\.)/.test(m[0])) hits.push(p);
          }
        }
      }
    };
    for (const d of ["controllers", "handlers", "routes", "services", "helpers", "rabbitMQ", "middlewares"]) walk(d);
    expect(hits).toEqual([]);
  });

  test("User model carries the A15 ownership plugin and the creation validator", () => {
    const src = read("models/user.model.js");
    expect(src).toMatch(/UserSchema\.plugin\(tenantOwnershipPlugin, \{ modelName: "User" \}\)/);
    expect(User.schema.path("tenantId").options.immutable).toBe(true);
  });

  test("identity uniqueness is tenant-qualified (the same external identity may own a User in several tenants)", () => {
    const unique = User.schema.indexes().filter(([, o]) => o && o.unique).map(([k]) => Object.keys(k));
    for (const keys of unique) expect({ keys, first: keys[0] }).toEqual({ keys, first: "tenantId" });
  });
});
