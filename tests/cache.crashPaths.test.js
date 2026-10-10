/**
 * Phase 1C-2R — cache.controller.js no longer calls res.fail().
 *
 * middlewares/response.mw.js does not define res.fail. Every cache-controller error path called it
 * from an async Express 4 handler: the TypeError became an unhandled rejection, which ends the
 * Node 22 process. They now return a generic 500 via res.sendInternalError (the Redis/service error
 * is only logged); the unreachable "Role code is required" branch uses res.sendBadRequest.
 *
 * Mounts the REAL routes/cache.routes.js + cache.controller + response.mw with the REAL requireTenant
 * and requireSuperUser over HTTP. authenticate is a stub (x-test-* headers -> req.ctx); the policy
 * adapter is a pass-through; the four cache services are recording stubs (no Redis).
 */
const http = require("http");
const express = require("express");

const A = "68cbf7806080b4621d469d34";
const mockState = { fail: null, calls: [] };
const mockOp = (key, ret, mutates) => async () => {
  if (mockState.fail === key) throw new Error("ECONNREFUSED redis://secret-host:6379");
  mockState.calls.push(mutates ? `mut:${key}` : key);
  return ret;
};

jest.mock("../services/roleHierarchyService", () => ({
  clearCache: mockOp("rh.clearCache", undefined, true),
  refreshCache: mockOp("rh.refreshCache", { SU: 100, GS: 90 }, true),
  getRoleHierarchy: mockOp("rh.getRoleHierarchy", { SU: 100, GS: 90 }),
  isSuperUser: (r) => !!r && r.includes("SU"),
  isAssistantSuperUser: () => false,
  isSystemAdmin: () => false,
  getHighestRoleLevel: () => 1,
  hasMinimumRole: () => false,
}));
jest.mock("../services/permissionsService", () => ({
  clearCache: mockOp("perm.clearCache", undefined, true),
  refreshCache: mockOp("perm.refreshCache", [{ code: "LOOKUP_READ" }], true),
  getAllPermissions: mockOp("perm.getAllPermissions", [{ code: "LOOKUP_READ" }]),
  getPermissionsMap: mockOp("perm.getPermissionsMap", { lookup: ["read"] }),
  getRolePermissions: mockOp("perm.getRolePermissions", ["lookup:read"]),
}));
jest.mock("../services/cacheService", () => ({
  clear: mockOp("cache.clear", undefined, true),
  getStats: mockOp("cache.getStats", { keys: 1 }),
}));
jest.mock("../services/lookupCacheService", () => ({
  clearAllCaches: mockOp("lookup.clearAllCaches", undefined, true),
  getCacheStats: mockOp("lookup.getCacheStats", { lookup: 1 }),
  invalidateCountryCache: mockOp("lookup.invalidateCountryCache", undefined, true),
}));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../helpers/policyAdapter.js", () => ({
  defaultPolicyAdapter: {
    middleware: (resource, action) => {
      const fn = (req, res, next) => next();
      Object.defineProperty(fn, "name", { value: `policy:${resource}:${action}` });
      return fn;
    },
  },
}));
jest.mock("../middlewares/auth", () => {
  const actual = jest.requireActual("../middlewares/auth");
  return {
    ...actual,
    tenantContextWarn: (req, res, next) => next(),
    authenticate: (req, res, next) => {
      const t = req.headers["x-test-tenant"];
      if (t || req.headers["x-test-roles"]) {
        req.ctx = { tenantId: t, userId: "u1", roles: JSON.parse(req.headers["x-test-roles"] || "[]") };
      }
      next();
    },
  };
});

let server;
let port;
const unhandled = [];
const onUnhandled = (e) => unhandled.push(String((e && e.message) || e));
beforeAll(async () => {
  process.on("unhandledRejection", onUnhandled);
  const app = express();
  app.use(express.json());
  app.use(require("../middlewares/response.mw"));
  app.use("/api", require("../routes/cache.routes"));
  app.use((req, res) => res.status(404).json({ notFound: true }));
  await new Promise((r) => (server = app.listen(0, r)));
  port = server.address().port;
});
afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
  return new Promise((r) => server.close(r));
});
beforeEach(() => {
  mockState.fail = null;
  mockState.calls = [];
  unhandled.length = 0;
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  expect(unhandled).toEqual([]); // an unhandled rejection would end the Node 22 process
  jest.restoreAllMocks();
});

function call(method, path, { roles = ["SU"], tenant = A } = {}) {
  return new Promise((resolve) => {
    const h = { "content-type": "application/json" };
    if (roles) h["x-test-roles"] = JSON.stringify(roles);
    if (tenant) h["x-test-tenant"] = tenant;
    const rq = http.request({ port, path, method, headers: h, timeout: 3000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        let body = null;
        try { body = b ? JSON.parse(b) : null; } catch (e) { body = { raw: b }; }
        resolve({ status: res.statusCode, body, raw: b });
      });
    });
    rq.on("timeout", () => { rq.destroy(); resolve({ status: "NO_RESPONSE", raw: "" }); });
    rq.end();
  });
}
const mutations = () => mockState.calls.filter((c) => c.startsWith("mut:"));

// [label, method, path, failing service op, expected 500 message, success mutations]
const OPS = [
  ["clearAllCaches", "POST", "/api/cache/clear", "cache.clear", "Failed to clear caches", ["mut:rh.clearCache", "mut:perm.clearCache", "mut:cache.clear", "mut:lookup.clearAllCaches"]],
  ["refreshRoleHierarchyCache", "POST", "/api/cache/refresh/role-hierarchy", "rh.refreshCache", "Failed to refresh role hierarchy cache", ["mut:rh.refreshCache"]],
  ["refreshPermissionsCache", "POST", "/api/cache/refresh/permissions", "perm.refreshCache", "Failed to refresh permissions cache", ["mut:perm.refreshCache"]],
  ["getCacheStats", "GET", "/api/cache/stats", "cache.getStats", "Failed to get cache statistics", []],
  ["getRoleHierarchy", "GET", "/api/role-hierarchy", "rh.getRoleHierarchy", "Failed to get role hierarchy", []],
  ["getPermissionsMap", "GET", "/api/permissions-map", "perm.getPermissionsMap", "Failed to get permissions map", []],
  ["getRolePermissions", "GET", "/api/role-permissions/GS", "perm.getRolePermissions", "Failed to get role permissions", []],
  ["testCachePerformance", "GET", "/api/cache/performance/test", "rh.getRoleHierarchy", "Failed to test cache performance", []],
  ["clearLookupCaches", "POST", "/api/lookup/clear", "lookup.clearAllCaches", "Failed to clear lookup caches", ["mut:lookup.clearAllCaches"]],
  ["getLookupCacheStats", "GET", "/api/lookup/stats", "lookup.getCacheStats", "Failed to get lookup cache statistics", []],
  ["clearCountryCaches", "POST", "/api/country/clear", "lookup.invalidateCountryCache", "Failed to clear country caches", ["mut:lookup.invalidateCountryCache"]],
];

describe.each(OPS)("%s", (_name, method, path, failOp, failMsg, successMutations) => {
  test("SU success unchanged (200 {status:'success', data})", async () => {
    const r = await call(method, path);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("success");
    expect(typeof r.body.data.message).toBe("string");
    expect(mutations()).toEqual(successMutations);
  });

  test("service failure -> generic 500 (was a process crash), no Redis/internal text", async () => {
    mockState.fail = failOp;
    const r = await call(method, path);
    expect(r.status).toBe(500);
    expect(r.body.error.message).toBe(failMsg);
    expect(r.raw).not.toMatch(/secret-host|ECONNREFUSED|redis:\/\//);
  });

  test("non-SU (ASU, GS) -> 403 before the controller; no service call", async () => {
    for (const roles of [["ASU"], ["GS"]]) {
      const r = await call(method, path, { roles });
      expect(r.status).toBe(403);
    }
    expect(mockState.calls).toEqual([]);
  });

  test("unauthenticated / no tenant -> rejected before the controller; no service call", async () => {
    expect((await call(method, path, { roles: null, tenant: null })).status).toBe(400);
    expect((await call(method, path, { tenant: null })).status).toBe(400);
    expect(mockState.calls).toEqual([]);
  });
});

test("clearAllCaches failing midway keeps its existing sequential semantics (earlier clears already ran)", async () => {
  mockState.fail = "cache.clear";
  const r = await call("POST", "/api/cache/clear");
  expect(r.status).toBe(500);
  expect(mutations()).toEqual(["mut:rh.clearCache", "mut:perm.clearCache"]); // lookup clear never reached
});

test("route chains unchanged: every cache route is requireTenant > requireSuperUser > policy > handler", () => {
  const router = require("../routes/cache.routes");
  const ctl = require("../controllers/cache.controller");
  const name = (fn) => Object.keys(ctl).find((k) => ctl[k] === fn) || fn.name;
  const wide = router.stack.filter((l) => !l.route).map((l) => l.name);
  expect(wide).toHaveLength(2); // authenticate, tenantContextWarn
  expect(wide[0]).toBe("authenticate");
  const rows = router.stack.filter((l) => l.route).map((l) => l.route.stack.map((x) => name(x.handle)));
  expect(rows).toHaveLength(11);
  for (const r of rows) {
    expect(r.slice(0, 2)).toEqual(["requireTenant", "requireSuperUser"]);
    expect(r[2]).toMatch(/^policy:admin:(read|write)$/);
  }
  expect(rows.map((r) => r[3]).sort()).toEqual(OPS.map((o) => o[0]).sort());
});

test("cache.controller.js has no executable res.fail()", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "cache.controller.js"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  expect(code).not.toMatch(/res\.fail\(/);
});
