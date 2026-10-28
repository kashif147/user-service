/**
 * Phase B / Z3 - structural write guards (models/plugins/fieldWriteGuard.js) on the REAL models, no DB.
 *
 *  - Role:              no platform-namespace permission on any Mongoose write path.
 *  - Permission:        the tenant catalogue can never hold a platform-namespace code/resource.
 *  - PlatformPrincipal: exact catalogue codes only (no "*", "platform:*", prefix, tenant code), also for
 *                       query updates without runValidators.
 *  - Z2 evaluator:      still exact match ("*" / another code in a principal never satisfies).
 *
 * bufferCommands is off: a write the guard lets through fails with a "not connected" error instead of
 * hanging - so "allowed" means "rejected by something other than the guard".
 */
const mongoose = require("mongoose");
mongoose.set("bufferCommands", false);

const Role = require("../models/role.model");
const Permission = require("../models/permission.model");
const PlatformPrincipal = require("../models/platformPrincipal.model");
const User = require("../models/user.model");
const { RolePrivilegeError } = require("../errors/RolePrivilegeError");
const { valuesWritten } = require("../models/plugins/fieldWriteGuard");
const { evaluatePlatformPermission } = require("../services/platformAuthorizationService");

const A = "68cbf7806080b4621d469d34";
const PLATFORM = ["platform:tenant:create", "platform:tenant:read:any", "platform:cache:admin", "platform:principals:manage", "platform:test:future", "PLATFORM_TEST_FUTURE", " Platform:X "];
const roleDoc = (permissions) => ({ tenantId: A, name: "N", code: "N", description: "d", category: "CRM", permissions });

const guardError = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return null;
};
const isRoleGuard = (e) => e instanceof RolePrivilegeError && e.code === "ROLE_PRIVILEGE_VIOLATION" && e.status === 403;

describe("Role write guard", () => {
  test.each(PLATFORM)("document validate/save refuses %p", async (p) => {
    expect(isRoleGuard(await guardError(new Role(roleDoc(["user:read", p])).validate()))).toBe(true);
    expect(isRoleGuard(await guardError(new Role(roleDoc(["*", p])).save()))).toBe(true);
  });
  test("a legitimate tenant role validates (incl. '*' and ObjectId entries)", async () => {
    await expect(new Role(roleDoc(["user:read", "*", "507f1f77bcf86cd799439011"])).validate()).resolves.toBeUndefined();
  });
  test("insertMany (the new-tenant role clone path) refuses a platform code", async () => {
    expect(isRoleGuard(await guardError(Role.insertMany([roleDoc(["user:read"]), roleDoc(["platform:test:future"])])))).toBe(true);
  });
  test.each([
    ["$set", { $set: { permissions: ["platform:test:future"] } }],
    ["implicit $set", { permissions: ["user:read", "platform:cache:admin"] }],
    ["$set element", { $set: { "permissions.0": "platform:tenant:create" } }],
    ["$addToSet", { $addToSet: { permissions: "platform:principals:manage" } }],
    ["$addToSet $each", { $addToSet: { permissions: { $each: ["user:read", "PLATFORM_TEST_FUTURE"] } } }],
    ["$push $each", { $push: { permissions: { $each: ["platform:tenant:read:any"] } } }],
    ["$setOnInsert", { $setOnInsert: { permissions: ["platform:x"] } }],
  ])("query updates refuse platform codes (%s) on updateOne/updateMany/findOneAndUpdate, without runValidators", async (_n, update) => {
    for (const op of ["updateOne", "updateMany", "findOneAndUpdate"]) {
      expect([op, isRoleGuard(await guardError(Role[op]({ tenantId: A }, update)))]).toEqual([op, true]);
    }
  });
  test("replaceOne / findOneAndReplace / bulkWrite / pipeline updates are covered", async () => {
    expect(isRoleGuard(await guardError(Role.replaceOne({ tenantId: A }, roleDoc(["platform:test:future"]))))).toBe(true);
    expect(isRoleGuard(await guardError(Role.findOneAndReplace({ tenantId: A }, roleDoc(["platform:test:future"]))))).toBe(true);
    expect(isRoleGuard(await guardError(Role.bulkWrite([{ updateOne: { filter: { tenantId: A }, update: { $addToSet: { permissions: "platform:cache:admin" } } } }])))).toBe(true);
    expect(isRoleGuard(await guardError(Role.bulkWrite([{ insertOne: { document: roleDoc(["platform:x"]) } }])))).toBe(true);
    const e = await guardError(Role.updateOne({ tenantId: A }, [{ $set: { permissions: ["user:read"] } }]));
    expect(e && /pipeline updates to permissions/.test(e.message)).toBe(true);
  });
  test("a legitimate tenant permission update passes the guard (fails only for lack of a DB)", async () => {
    const e = await guardError(Role.updateOne({ tenantId: A }, { $addToSet: { permissions: { $each: ["user:read", "*"] } } }));
    expect(isRoleGuard(e)).toBe(false);
    const e2 = await guardError(Role.updateOne({ tenantId: A }, { $set: { name: "x" } }));
    expect(isRoleGuard(e2)).toBe(false);
  });
  test("valuesWritten collects every form", () => {
    expect(valuesWritten({ permissions: ["a"], $set: { "permissions.1": "b" }, $addToSet: { permissions: { $each: ["c"] } }, $push: { permissions: "d" }, $setOnInsert: { permissions: ["e"] }, $inc: { permissions: 1 } }, "permissions").sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(valuesWritten({ $set: { permissionsX: ["z"] } }, "permissions")).toEqual([]);
  });
});

describe("Permission catalogue guard: the platform namespace is never a tenant catalogue entry", () => {
  const perm = (o) => ({ name: "N", code: "X_READ", description: "d", resource: "x", action: "read", category: "GENERAL", ...o });
  test.each([
    [{ code: "PLATFORM_TEST_FUTURE", resource: "x" }],
    [{ code: "X_READ", resource: "platform" }],
    [{ code: "X_READ", resource: "Platform" }],
    [{ code: "PLATFORM:CACHE:ADMIN", resource: "x" }],
  ])("document validate refuses %p", async (o) => {
    const e = await guardError(new Permission(perm(o)).validate());
    expect(e && e.code).toBe("PLATFORM_PERMISSION_RESERVED");
  });
  test("query updates / insertMany refuse it too", async () => {
    expect((await guardError(Permission.updateOne({}, { $set: { resource: "platform" } })))?.code).toBe("PLATFORM_PERMISSION_RESERVED");
    expect((await guardError(Permission.findOneAndUpdate({}, { code: "PLATFORM_X" })))?.code).toBe("PLATFORM_PERMISSION_RESERVED");
    expect((await guardError(Permission.insertMany([perm({ resource: "platform" })])))?.code).toBe("PLATFORM_PERMISSION_RESERVED");
  });
  test("ordinary catalogue entries validate", async () => {
    await expect(new Permission(perm({})).validate()).resolves.toBeUndefined();
    await expect(new Permission(perm({ code: "PLATFORMS_READ", resource: "platforms" })).validate()).resolves.toBeUndefined();
  });
});

describe("PlatformPrincipal permissions: exact catalogue codes only", () => {
  const ISS = "https://login.microsoftonline.com/39866a06-30bc-4a89-80c6-9dd9357dd453/v2.0";
  const doc = (permissions) => ({ issuer: ISS, oid: "aaaa1111-bbbb-2222-cccc-3333dddd4444", tid: "39866a06-30bc-4a89-80c6-9dd9357dd453", permissions, createdBy: "t", updatedBy: "t" });
  const BAD = ["*", "platform:*", "platform:tenant", "platform:tenant:*", "user:read", "tenant:admin", "PLATFORM_CACHE_ADMIN", "platform:test:future", " platform:cache:admin"];
  test.each(BAD)("document validate refuses %p", async (p) => {
    expect(await guardError(new PlatformPrincipal(doc([p])).validate())).toBeTruthy();
  });
  test.each(BAD)("query update refuses %p WITHOUT runValidators ($set / $addToSet / $push)", async (p) => {
    for (const u of [{ $set: { permissions: [p] } }, { $addToSet: { permissions: p } }, { $push: { permissions: { $each: [p] } } }]) {
      const e = await guardError(PlatformPrincipal.updateOne({ _id: "6a0000000000000000000a03" }, u));
      expect(e && /exact platform catalogue codes/.test(e.message)).toBe(true);
    }
  });
  test("exact catalogue codes pass the guard", async () => {
    await expect(new PlatformPrincipal(doc(["platform:cache:admin", "platform:tenant:read:any"])).validate()).resolves.toBeUndefined();
    const e = await guardError(PlatformPrincipal.updateOne({ _id: "6a0000000000000000000a03" }, { $set: { permissions: ["platform:cache:admin"] } }));
    expect(e && /exact platform catalogue codes/.test(e.message)).toBe(false);
  });
});

describe("Z2 platform evaluator stays exact-match", () => {
  const jwt = require("jsonwebtoken");
  const SECRET = "unit-test-only-secret-z3";
  const PID = "6a0000000000000000000a03";
  const OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
  const ISS = "https://login.microsoftonline.com/39866a06-30bc-4a89-80c6-9dd9357dd453/v2.0";
  const USER = "6a00000000000000000000c1";
  const verifyToken = (t) => {
    try {
      return { valid: true, payload: jwt.verify(t, SECRET) };
    } catch {
      return { valid: false };
    }
  };
  const run = async (held, permission, roles = ["SU"], perms = ["*"]) => {
    jest.spyOn(PlatformPrincipal, "findById").mockImplementation(() => ({ select: () => ({ lean: async () => ({ _id: PID, issuer: ISS, oid: OID, status: "active", revision: 1, permissions: held }) }) }));
    jest.spyOn(User, "findOne").mockImplementation(() => ({ select: () => ({ lean: async () => ({ _id: USER, userType: "CRM", userMicrosoftId: OID, userIssuer: ISS, isActive: true }) }) }));
    const tok = jwt.sign({ id: USER, sub: USER, tenantId: A, roles: roles.map((code) => ({ code })), permissions: perms, plat: { v: 1, pid: PID, rev: 1 } }, SECRET, { algorithm: "HS256" });
    return evaluatePlatformPermission({ authorization: `Bearer ${tok}`, ctx: { userId: USER, tenantId: A }, permission, verifyToken });
  };
  afterEach(() => jest.restoreAllMocks());

  test("exact held code -> allowed", async () => {
    expect((await run(["platform:cache:admin"], "platform:cache:admin")).allowed).toBe(true);
  });
  test('"*" / another code / tenant "*" in the token never satisfy', async () => {
    expect((await run(["*"], "platform:cache:admin")).reason).toBe("permission_missing");
    expect((await run(["platform:tenant:create"], "platform:cache:admin")).reason).toBe("permission_missing");
    expect((await run(["platform:tenant:read:any"], "platform:tenant:update:any")).reason).toBe("permission_missing");
  });
  test("a non-catalogue code cannot even be asked for", async () => {
    await expect(run(["platform:cache:admin"], "platform:*")).rejects.toThrow();
    await expect(run(["platform:cache:admin"], "*")).rejects.toThrow();
  });
});
