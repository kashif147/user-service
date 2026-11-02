/**
 * P5 - services/tenantRoleCache.js: per-tenant invalidation (no global flush), best effort, and never the broken
 * cacheInvalidationService /me + policy purge. The cache modules are replaced (no Redis).
 */
const fs = require("fs");
const path = require("path");

const mockKeys = jest.fn();
const mockDel = jest.fn(async () => true);
jest.mock("../services/cacheService", () => ({ keys: (...a) => mockKeys(...a), del: (...a) => mockDel(...a), get: async () => null, set: async () => true }));
const mockClearHierarchy = jest.fn(async () => {});
jest.mock("../services/roleHierarchyService", () => ({ clearCache: (...a) => mockClearHierarchy(...a) }));
jest.mock("../services/cacheInvalidationService", () => { throw new Error("tenantRoleCache must not load cacheInvalidationService"); });

const { invalidateTenantRoleCaches } = require("../services/tenantRoleCache");
const T = "6b0000000000000000000001";

beforeEach(() => { mockKeys.mockReset(); mockDel.mockClear(); mockClearHierarchy.mockReset(); });

test("clears only the tenant's role hierarchy and role_permissions:<tenant>:* entries", async () => {
  mockKeys.mockImplementation(async (pattern) => (pattern === `role_permissions:${T}:*` ? [`role_permissions:${T}:MO`, `role_permissions:${T}:REO`] : ["role_permissions:OTHER:MO"]));
  expect(await invalidateTenantRoleCaches(T)).toEqual({ invalidated: true, failed: [] });
  expect(mockClearHierarchy.mock.calls).toEqual([[T]]);
  expect(mockKeys.mock.calls).toEqual([[`role_permissions:${T}:*`]]);
  expect(mockDel.mock.calls).toEqual([[`role_permissions:${T}:MO`, `role_permissions:${T}:REO`]]);
});

test("no tenant -> nothing touched (never a global flush)", async () => {
  for (const t of ["", null, undefined, "   "]) expect(await invalidateTenantRoleCaches(t)).toEqual({ invalidated: false, failed: [] });
  expect(mockClearHierarchy).not.toHaveBeenCalled();
  expect(mockKeys).not.toHaveBeenCalled();
});

test("a cache failure is reported, never thrown; the other cache is still cleared", async () => {
  mockClearHierarchy.mockRejectedValue(new Error("redis down"));
  mockKeys.mockResolvedValue([]);
  jest.spyOn(console, "warn").mockImplementation(() => {});
  expect(await invalidateTenantRoleCaches(T)).toEqual({ invalidated: false, failed: ["role_hierarchy"] });
  expect(mockKeys).toHaveBeenCalledWith(`role_permissions:${T}:*`);
});

test("source: no /me + policy purge (cacheInvalidationService blocks ~55 s on Redis reconnects and its /me step is broken)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "services", "tenantRoleCache.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(src).not.toMatch(/cacheInvalidationService|invalidateMeCache|policyEvaluationService|invalidateAllCache/);
});
