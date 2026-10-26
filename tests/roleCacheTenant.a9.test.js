/**
 * Phase A / A9 — role/permission caches are tenant-scoped.
 *   role hierarchy:     role_hierarchy            -> role_hierarchy:<tenantId>        (query { tenantId, isActive })
 *   role permissions:   role_permissions:<code>   -> role_permissions:<tenantId>:<code> (query { tenantId, code, isActive })
 *   PDP decision cache: <tenantId||"default">:... -> <tenantId>:... ; no tenant -> not cached
 * Same role code in MULTIAUTH / DEVTENANTB / DEVDIRB must never leak across tenants; no tenant fails closed.
 */
const mockStore = new Map();
jest.mock("../services/cacheService", () => ({
  get: jest.fn(async (k) => (mockStore.has(k) ? mockStore.get(k) : null)),
  set: jest.fn(async (k, v) => { mockStore.set(k, v); }),
  del: jest.fn(async (...ks) => { ks.forEach((k) => mockStore.delete(k)); }),
  keys: jest.fn(async (pat) => [...mockStore.keys()].filter((k) => k.startsWith(pat.replace("*", "")))),
}));
const mockM = "68cbf7806080b4621d469d34", mockB = "6acd6119b28a863c61361ae0", mockD = "6ad4e0c941376f7df605fd57";
const mockRoles = [
  { tenantId: mockM, code: "ASU", level: 95, permissions: ["TENANT_ADMIN", "P_M"], isActive: true },
  { tenantId: mockB, code: "ASU", level: 10, permissions: ["P_B"], isActive: true },
  { tenantId: mockD, code: "ASU", level: 20, permissions: ["P_D"], isActive: true },
  { tenantId: mockB, code: "ONLYB", level: 7, permissions: ["X"], isActive: true },
];
const mockQ = (f) => mockRoles.filter((r) => Object.entries(f).every(([k, v]) => r[k] === v));
const mockLean = (v) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
jest.mock("../models/role.model", () => ({ find: jest.fn((f) => mockLean(mockQ(f))), findOne: jest.fn((f) => mockLean(mockQ(f)[0] || null)) }));
const Role = require("../models/role.model");
const cache = require("../services/cacheService");
const hierarchy = require("../services/roleHierarchyService");
const perms = require("../services/permissionsService");
const PolicyCache = require("../services/policyCache"); // exports the class
const genKey = (...a) => PolicyCache.prototype.generateKey.call({ hashString: PolicyCache.prototype.hashString }, ...a);

beforeEach(() => { mockStore.clear(); jest.clearAllMocks(); });

test("hierarchy is loaded and cached per tenant (same code, different levels)", async () => {
  expect((await hierarchy.getRoleHierarchy(mockM)).ASU).toBe(95);
  expect((await hierarchy.getRoleHierarchy(mockB)).ASU).toBe(10);
  expect((await hierarchy.getRoleHierarchy(mockD)).ASU).toBe(20);
  expect(Role.find.mock.calls.map((c) => c[0])).toEqual([
    { tenantId: mockM, isActive: true }, { tenantId: mockB, isActive: true }, { tenantId: mockD, isActive: true },
  ]);
  expect([...mockStore.keys()].sort()).toEqual([`role_hierarchy:${mockB}`, `role_hierarchy:${mockD}`, `role_hierarchy:${mockM}`].sort());
  // a role that exists only in mockB is never visible from mockM
  expect((await hierarchy.getRoleHierarchy(mockM)).ONLYB).toBeUndefined();
  expect((await hierarchy.getRoleHierarchy(mockB)).ONLYB).toBe(7);
});

test("a warm cache for tenant A is never returned for tenant mockB", async () => {
  await hierarchy.getRoleHierarchy(mockM);
  const b = await hierarchy.getRoleHierarchy(mockB);
  expect(b.ASU).toBe(10);
  expect(cache.get).toHaveBeenLastCalledWith(`role_hierarchy:${mockB}`);
});

test("no / placeholder tenant fails closed (no global fallback)", async () => {
  for (const t of [undefined, "", "default"]) {
    await expect(hierarchy.getRoleHierarchy(t)).rejects.toMatchObject({ code: "TENANT_REQUIRED" });
    await expect(perms.getRolePermissions("ASU", t)).rejects.toMatchObject({ code: "TENANT_REQUIRED" });
  }
  expect(Role.find).not.toHaveBeenCalled();
  expect(Role.findOne).not.toHaveBeenCalled();
});

test("role permissions are keyed and queried by tenant", async () => {
  expect(await perms.getRolePermissions("ASU", mockM)).toEqual(["TENANT_ADMIN", "P_M"]);
  expect(await perms.getRolePermissions("ASU", mockB)).toEqual(["P_B"]);
  expect(await perms.getRolePermissions("ASU", mockD)).toEqual(["P_D"]);
  expect(Role.findOne.mock.calls.map((c) => c[0])).toEqual([
    { tenantId: mockM, code: "ASU", isActive: true }, { tenantId: mockB, code: "ASU", isActive: true }, { tenantId: mockD, code: "ASU", isActive: true },
  ]);
  expect(mockStore.has(`role_permissions:${mockM}:ASU`) && mockStore.has(`role_permissions:${mockB}:ASU`)).toBe(true);
  expect(await perms.getEffectivePermissions(["ASU"], mockB)).toEqual(["P_B"]);
  expect(await perms.getEffectivePermissions(["ASU"], undefined)).toEqual([]); // fails closed (empty)
});

test("clearCache purges the legacy global key", async () => {
  mockStore.set("role_hierarchy", { SU: 100 });
  mockStore.set(`role_hierarchy:${mockB}`, { ASU: 10 });
  await hierarchy.clearCache(mockB);
  expect(mockStore.has("role_hierarchy")).toBe(false);
  expect(mockStore.has(`role_hierarchy:${mockB}`)).toBe(false);
});

test("PDP cache key includes the tenant; no tenant -> no key (never a shared 'default' bucket)", () => {
  expect(genKey("h", "r", "a", { tenantId: mockB })).toMatch(new RegExp(`^${mockB}:h:r:a:`));
  for (const t of [undefined, "", "default"]) expect(genKey("h", "r", "a", { tenantId: t })).toBeNull();
});
