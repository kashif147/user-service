/**
 * TENANT_ADMIN source bootstrap parity (unit). One canonical definition
 * (constants/tenantAdminPermission.js) used by the empty-catalogue seed, the runtime fallback
 * catalogue, new-tenant provisioning and scripts/ensure-tenant-admin.js. Recipient: ASU only.
 * Real-database behaviour: tenantAdminParity.mongo.test.js.
 */
const fs = require("fs");
const path = require("path");

const mockInserted = [];
jest.mock("../models/permission.model", () => ({
  countDocuments: async () => 0,
  insertMany: async (docs) => {
    mockInserted.push(...docs);
    return docs;
  },
}));
jest.mock("../models/role.model", () => ({}));
jest.mock("../services/cacheService", () => ({ get: async () => null, set: async () => {}, del: async () => {}, keys: async () => [] }));

const C = require("../constants/tenantAdminPermission");
const PermissionHandler = require("../handlers/permission.handler");
const permissionsService = require("../services/permissionsService");

const ROOT = path.join(__dirname, "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const FALLBACK_FIELDS = ["code", "name", "resource", "action", "level", "category"];

beforeEach(() => {
  mockInserted.length = 0;
  for (const m of ["log", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test("1 canonical TENANT_ADMIN metadata is exactly the approved definition (no environment ids)", () => {
  expect(C.TENANT_ADMIN_PERMISSION).toEqual({
    name: "Administer Tenants",
    code: "TENANT_ADMIN",
    description: "Manage tenant authentication connections",
    resource: "tenant",
    action: "admin",
    category: "TENANT",
    level: 80,
    isActive: true,
    isSystemPermission: true,
  });
  expect(Object.isFrozen(C.TENANT_ADMIN_PERMISSION)).toBe(true);
  expect(JSON.stringify(C)).not.toMatch(/[0-9a-f]{24}/i);
  expect(src("constants/tenantAdminPermission.js")).not.toMatch(/68c6ad231ae58311ab995077|6acd612d13262c26be33e2ae|6ad32910ed846c5080f49663/);
});

test("2 the empty-catalogue seed (initializeDefaultPermissions) creates TENANT_ADMIN with the canonical metadata", async () => {
  await PermissionHandler.initializeDefaultPermissions();
  const seeded = mockInserted.filter((p) => p.code === "TENANT_ADMIN");
  expect(seeded).toHaveLength(1);
  for (const k of C.SEMANTIC_FIELDS) expect(seeded[0][k]).toEqual(C.TENANT_ADMIN_PERMISSION[k]);
  expect(seeded[0]).toMatchObject({ isSystemPermission: true, createdBy: "system" });
  expect(mockInserted.filter((p) => p.resource === "tenant" && p.action === "admin")).toHaveLength(1);
  expect(new Set(mockInserted.map((p) => p.code)).size).toBe(mockInserted.length); // no duplicate codes
});

test("3/4 the fallback catalogue contains TENANT_ADMIN with the same semantic fields as the seed", async () => {
  const fallback = permissionsService.getFallbackPermissions().filter((p) => p.code === "TENANT_ADMIN");
  expect(fallback).toHaveLength(1);
  await PermissionHandler.initializeDefaultPermissions();
  const seeded = mockInserted.find((p) => p.code === "TENANT_ADMIN");
  for (const k of FALLBACK_FIELDS) {
    expect(fallback[0][k]).toEqual(seeded[k]);
    expect(fallback[0][k]).toEqual(C.TENANT_ADMIN_PERMISSION[k]);
  }
  // both import the canonical definition rather than hand-copying it
  expect(src("handlers/permission.handler.js")).toMatch(/\.\.\.TENANT_ADMIN_PERMISSION/);
  expect(src("services/permissionsService.js")).toMatch(/TENANT_ADMIN_PERMISSION\.code/);
});

test("fallback is used only when the database read throws (runtime data, never written)", async () => {
  const Permission = require("../models/permission.model");
  Permission.find = () => ({ select: () => ({ lean: async () => { throw new Error("db down"); } }) });
  const perms = await permissionsService.getAllPermissions();
  expect(perms.find((p) => p.code === "TENANT_ADMIN")).toMatchObject({ resource: "tenant", action: "admin" });
});

test("5 the recipient rule is ASU only, with TENANT_READ + TENANT_ADMIN", () => {
  expect(C.TENANT_ADMIN_ROLE_CODE).toBe("ASU");
  expect(C.TENANT_ADMIN_ROLE_PERMISSIONS).toEqual(["TENANT_READ", "TENANT_ADMIN"]);
});

test("reference forms: a code or the permission's ObjectId string counts as held; only missing codes are returned", () => {
  const ids = { TENANT_READ: "a".repeat(24), TENANT_ADMIN: "b".repeat(24) };
  expect(C.missingRolePermissions([], ids)).toEqual(["TENANT_READ", "TENANT_ADMIN"]);
  expect(C.missingRolePermissions(["TENANT_READ"], ids)).toEqual(["TENANT_ADMIN"]);
  expect(C.missingRolePermissions(["a".repeat(24), "TENANT_ADMIN"], ids)).toEqual([]);
  expect(C.missingRolePermissions(["b".repeat(24)], ids)).toEqual(["TENANT_READ"]);
  expect(C.missingRolePermissions(["b".repeat(24)], {})).toEqual(["TENANT_READ", "TENANT_ADMIN"]); // unknown id is not assumed
});

test("drift detection compares every semantic field", () => {
  expect(C.permissionDrift({ ...C.TENANT_ADMIN_PERMISSION, _id: "x", createdBy: "anyone" })).toEqual([]);
  expect(C.permissionDrift({ ...C.TENANT_ADMIN_PERMISSION, level: 50, description: "x" })).toEqual(["description", "level"]);
  expect(C.permissionDrift(null)).toEqual(C.SEMANTIC_FIELDS);
});

test("6/7/9 ensure logic writes only permissions and ASU roles - never users; JIT default-role guard still excludes ASU / SU", () => {
  const script = src("scripts/ensure-tenant-admin.js");
  expect(script).not.toMatch(/collection\(["']users["']\)|models\/user\.model/);
  expect(script).toMatch(/code: TENANT_ADMIN_ROLE_CODE, isActive: true/);
  const handler = src("handlers/tenant.handler.js");
  const hook = handler.slice(handler.indexOf("const ensureTenantAdminOnNewTenant"), handler.indexOf("module.exports.ensureTenantAdminOnNewTenant"));
  expect(hook).not.toMatch(/\bUser\./);
  expect(hook).toMatch(/code: TENANT_ADMIN_ROLE_CODE/);
  expect(hook).not.toMatch(/Role\.(create|insertMany)|new Role/); // never invents a role
  // JIT / default-role rule unchanged (helpers/connectionDefaultRole.js is not modified): SU / ASU
  // can never be a connection's default role - proven by phase2.connectionDefaultRole.test.js 9.
});

test("every seed entry uses a category accepted by the current Permission model enum (fresh bootstrap cannot fail validation)", async () => {
  const RealPermission = jest.requireActual("../models/permission.model");
  const allowed = RealPermission.schema.path("category").enumValues;
  expect(allowed.length).toBeGreaterThan(0);
  await PermissionHandler.initializeDefaultPermissions();
  expect(mockInserted.length).toBeGreaterThan(0);
  const invalid = mockInserted.filter((p) => !allowed.includes(p.category)).map((p) => `${p.code}:${p.category}`);
  expect(invalid).toEqual([]);
  expect(mockInserted.filter((p) => ["NOTIFICATION_READ", "NOTIFICATION_WRITE"].includes(p.code)).map((p) => p.category)).toEqual(["COMMUNICATION", "COMMUNICATION"]);
});
