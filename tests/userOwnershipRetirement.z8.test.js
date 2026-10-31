/**
 * Phase B / Z8 - every legacy User re-tenanting / ownership-repair mechanism is retired.
 *
 * Z7 made User.tenantId immutable (set once at creation from trusted context). Z8 removes what was left
 * of the old model and guards against its reintroduction:
 *  - an existing User can no longer have a missing / null / empty tenantId "filled" (the old repair
 *    shape `if (!user.tenantId) user.tenantId = X`): 409 TENANT_IMMUTABLE, like any other change;
 *  - the retired migration shapes (bulk backfill, rollback, upsert re-seed) are rejected by the guard;
 *  - scripts/assign-tenant-to-users.js, scripts/migrate-tenant-isolation.js and the dead
 *    helpers/microsoftAuthHelper.js (tenant taken from the Entra tid / B2C extension_tenantId) are gone;
 *  - a source guard fails if an ownership-mutation pattern comes back. It targets WRITES of User
 *    ownership, not the word tenantId: tenant-scoped filters (`{ _id, tenantId }`) stay legal.
 * Login / JIT, same-identity-in-another-tenant, email and DirectoryClaim behaviour are covered by the Z7
 * suites (userTenantOwnership.z7, the login suites, stage5b/5c) - unchanged here.
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const User = require("../models/user.model");
const { TENANT_IMMUTABLE } = require("../models/plugins/tenantOwnership.plugin");
const { PLATFORM_PERMISSIONS } = require("../constants/platformPermissions");

const A = "68cbf7806080b4621d469d34"; // MULTIAUTH
const B = "6acd6119b28a863c61361ae0"; // DEVTENANTB
const IMMUTABLE = { code: TENANT_IMMUTABLE, status: 409 };
const ROOT = path.join(__dirname, "..");

let warn;
beforeAll(() => mongoose.set("bufferCommands", false));
beforeEach(() => { warn = jest.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe("an existing User's tenant can never be filled, repaired or moved", () => {
  test.each([
    ["missing", {}],
    ["null", { tenantId: null }],
    ["empty", { tenantId: "" }],
  ])("existing User with a %s tenantId, then assigned -> 409 TENANT_IMMUTABLE (never saved)", async (_n, t) => {
    const d = User.hydrate({ _id: new mongoose.Types.ObjectId(), userEmail: "z8@invalid.test", userType: "PORTAL", ...t });
    d.tenantId = A; // the retired legacy-repair shape
    await expect(d.save()).rejects.toMatchObject(IMMUTABLE);
    await expect(d.save({ validateBeforeSave: false })).rejects.toMatchObject(IMMUTABLE);
    expect(warn.mock.calls.some(([l]) => String(l).includes("TenantOwnershipViolation"))).toBe(true);
  });

  test("a real tenant moved to another (the retired migration target) -> 409", async () => {
    const d = User.hydrate({ _id: new mongoose.Types.ObjectId(), tenantId: A, userEmail: "z8@invalid.test" });
    d.set("tenantId", B);
    await expect(d.save()).rejects.toMatchObject(IMMUTABLE);
  });

  test("a new User still takes its tenant at creation (the only time it is set)", () => {
    expect(new User({ tenantId: A, userEmail: "z8@invalid.test" }).validateSync()).toBeUndefined();
  });
});

describe("the retired migration / backfill shapes are rejected before the database", () => {
  const id = new mongoose.Types.ObjectId();
  test.each([
    // scripts/migrate-tenant-isolation.js (migrate): backfill every untenanted user with a default tenant
    ["backfill untenanted users", () => User.updateMany({ tenantId: { $exists: false } }, { $set: { tenantId: A } })],
    // scripts/migrate-tenant-isolation.js (rollback): strip ownership from a tenant's users
    ["rollback (unset ownership)", () => User.updateMany({ tenantId: A }, { $unset: { tenantId: "" } })],
    // scripts/assign-tenant-to-users.js: null / empty -> fixed tenant
    ["null / empty -> fixed tenant", () => User.updateMany({ $or: [{ tenantId: null }, { tenantId: "" }] }, { $set: { tenantId: A } })],
    ["move one user", () => User.findOneAndUpdate({ _id: id, tenantId: A }, { $set: { tenantId: B } })],
    ["upsert re-seeding another tenant", () => User.updateOne({ tenantId: A, userMicrosoftId: "x" }, { $setOnInsert: { tenantId: B } }, { upsert: true })],
    ["bulk move", () => User.bulkWrite([{ updateMany: { filter: { tenantId: A }, update: { $set: { tenantId: B } } } }])],
  ])("%s -> 409 TENANT_IMMUTABLE", async (_n, run) => {
    await expect(run()).rejects.toMatchObject(IMMUTABLE);
  });

  test.each([["default"], ["unknown"], ["legacy"], ["global"], ["system"], ["MAIN"], [null], [""]])(
    "placeholder / default tenant %p cannot create a User",
    (tenantId) => {
      const err = new User({ tenantId, userEmail: "z8@invalid.test" }).validateSync();
      expect(err && err.errors && err.errors.tenantId).toBeDefined();
    }
  );
});

describe("source guard: User ownership-mutation patterns cannot come back", () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!["node_modules", "tests", ".git", "coverage", "logs"].includes(e.name)) walk(rel);
      } else if (e.name.endsWith(".js")) files.push(rel);
    }
  })("");
  const src = Object.fromEntries(files.map((f) => [f, strip(fs.readFileSync(path.join(ROOT, f), "utf8"))]));
  const hits = (re, allow = []) =>
    Object.entries(src).flatMap(([f, s]) => (allow.includes(f) ? [] : [...s.matchAll(re)].map((m) => `${f}: ${m[0].trim().slice(0, 80)}`)));

  test("the walk covers runtime code and scripts", () => {
    expect(files).toEqual(expect.arrayContaining(["handlers/azure.ad.handler.js", "handlers/b2c.users.handler.js", "models/user.model.js"]));
    expect(files.some((f) => f.startsWith("scripts/"))).toBe(true);
    expect(files.some((f) => f.startsWith("rabbitMQ/listeners/"))).toBe(true);
  });

  test("no `<x>.tenantId = ...` except request context and local query / option objects", () => {
    const ALLOWED_RECEIVERS = new Set(["req", "options", "entry", "filter"]);
    const found = Object.entries(src).flatMap(([f, s]) =>
      [...s.matchAll(/\b([A-Za-z_$][\w$]*)\.tenantId\s*=(?!=)/g)].filter((m) => !ALLOWED_RECEIVERS.has(m[1])).map((m) => `${f}: ${m[0]}`)
    );
    expect(found).toEqual([]);
  });

  test("no $set / $setOnInsert carries tenantId (sign-in / JIT take the owner from the filter only)", () => {
    expect(hits(/\$set(OnInsert)?\s*:\s*\{[^}]*\btenantId\b/g)).toEqual([]);
  });

  test("no update object is given a tenantId (updateData.tenantId = ... and friends)", () => {
    expect(hits(/\b(updateData|update|updates|patch|changes|data)\s*(\.tenantId|\[\s*["'`]tenantId["'`]\s*\])\s*=(?!=)/g)).toEqual([]);
  });

  test("no placeholder / default tenant is written for a User", () => {
    expect(hits(/tenantId\s*[:=]\s*["'`](default|unknown|legacy|global|system|main|placeholder)["'`]/gi)).toEqual([]);
  });

  test("the User model is defined once, in models/ (one allow-listed legacy script, roles only - owner review)", () => {
    expect(hits(/\.model\(\s*["'`]User["'`]/g, ["models/user.model.js", "scripts/assign-roles-by-subscription.js"])).toEqual([]);
    // the allow-listed script must never touch ownership itself
    expect(src["scripts/assign-roles-by-subscription.js"]).not.toMatch(/\.tenantId\s*=(?!=)|\$set\s*:\s*\{[^}]*\btenantId\b/);
  });

  test("raw `users` collection access only in the index migration, and only index / read operations", () => {
    expect(hits(/collection\(\s*["'`]users["'`]\s*\)/g, ["scripts/migrate-user-identity-partial-indexes.js"])).toEqual([]);
    expect(src["scripts/migrate-user-identity-partial-indexes.js"]).not.toMatch(
      /\bc\.(insert\w*|update\w*|replace\w*|delete\w*|bulkWrite|findOneAnd\w+)\(/
    );
  });

  test("the retired re-tenanting scripts and the tid-as-tenant helper are gone and not required anywhere", () => {
    for (const f of ["scripts/assign-tenant-to-users.js", "scripts/migrate-tenant-isolation.js", "helpers/microsoftAuthHelper.js"]) {
      expect({ f, exists: fs.existsSync(path.join(ROOT, f)) }).toEqual({ f, exists: false });
    }
    expect(hits(/require\([^)]*(microsoftAuthHelper|assign-tenant-to-users|migrate-tenant-isolation)[^)]*\)/g)).toEqual([]);
  });

  test("the constants migrations skip a tenantless user instead of assigning one", () => {
    for (const f of ["scripts/migrate-constants-to-db.js", "scripts/migrate-constants-to-staging.js"]) {
      expect(src[f]).toMatch(/if \(!user\.tenantId\) \{\s*console\.warn\([^;]*\);\s*continue;\s*\}/);
      expect(src[f]).not.toMatch(/user\.tenantId\s*=(?!=)/);
    }
  });

  test("no platform permission can move a User (platform authority never changes User ownership)", () => {
    const codes = Object.values(PLATFORM_PERMISSIONS || {}).flatMap((v) => (typeof v === "string" ? [v] : Object.values(v || {})));
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.filter((c) => /user/i.test(String(c)))).toEqual([]);
  });

  test("event listeners never write a User's tenant (an event tenant scopes the lookup only)", () => {
    const listeners = files.filter((f) => f.startsWith("rabbitMQ/listeners/"));
    expect(listeners.length).toBeGreaterThan(0);
    for (const f of listeners) expect({ f, writesTenant: /\buser\.tenantId\s*=(?!=)|\$set\s*:\s*\{[^}]*\btenantId\b/.test(src[f]) }).toEqual({ f, writesTenant: false });
  });
});
