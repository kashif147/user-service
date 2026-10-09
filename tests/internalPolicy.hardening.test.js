/**
 * Phase 1C-2I — internal /policy/* hardening.
 *
 *  - DELETE /policy/cache and DELETE /policy/cache/:key (documented operator actions, previously
 *    UNAUTHENTICATED) now require: authenticate -> tenantContextWarn -> requireTenant -> requireSuperUser.
 *  - The GET /policy/permissions/roles handler (global role hierarchy) was removed: it was unreachable
 *    because GET /permissions/:resource is declared first. Requests to that path keep their existing
 *    behaviour (served by /permissions/:resource with resource "roles").
 *  - Phase 1C-2K: the shadowed GET /permissions/system (global permission catalogue) and
 *    GET /permissions/routes (static route map) handlers were removed the same way (not reordered).
 *
 * Mounts the REAL routes/policy.routes.js at /policy with the REAL requireTenant / requireSuperUser.
 * authenticate is a stub reading x-test-* headers; the PDP service and role hierarchy are spies.
 */
const http = require("http");
const express = require("express");

const mockCacheClear = jest.fn(async () => {});
const mockCacheDelete = jest.fn(async () => {});
const mockCacheStats = jest.fn(async () => ({ enabled: true, redisConnected: false, localCacheSize: 0, ttl: 300 }));
const mockEffective = jest.fn(async () => ({ success: true, permissions: [], roles: [], userType: "CRM", tenantId: "t" }));
const mockEffectiveWithHeaders = jest.fn(async () => ({ success: true, permissions: [], roles: [], userType: "CRM", tenantId: "t" }));
const mockGetRoleHierarchy = jest.fn(async () => ({ SU: 100 }));
const mockGetAllPermissions = jest.fn(async () => [{ code: "GLOBAL_CATALOGUE_ENTRY", resource: "x", action: "read" }]);
const mockValidateToken = jest.fn(async () => ({ valid: true, user: { id: "u1" } }));

jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../services/roleHierarchyService", () => ({
  isSuperUser: () => false,
  isAssistantSuperUser: () => false,
  isSystemAdmin: () => false,
  getHighestRoleLevel: () => 1,
  hasMinimumRole: () => false,
  getRoleHierarchy: (...a) => mockGetRoleHierarchy(...a),
}));
jest.mock("../services/permissionsService", () => ({
  getAllPermissions: (...a) => mockGetAllPermissions(...a),
}));
jest.mock("../services/policyEvaluationService", () => ({
  cache: {
    clear: (...a) => mockCacheClear(...a),
    delete: (...a) => mockCacheDelete(...a),
    getStats: (...a) => mockCacheStats(...a),
  },
  getEffectivePermissions: (...a) => mockEffective(...a),
  getEffectivePermissionsWithHeaders: (...a) => mockEffectiveWithHeaders(...a),
  validateToken: (...a) => mockValidateToken(...a),
}));
jest.mock("../middlewares/auth", () => {
  const actual = jest.requireActual("../middlewares/auth");
  return {
    ...actual,
    authenticate: (req, res, next) => {
      const t = req.headers["x-test-tenant"];
      if (!t && !req.headers["x-test-roles"]) return res.status(401).json({ error: "unauthenticated" });
      if (t) req.ctx = { tenantId: t, userId: "u1", roles: JSON.parse(req.headers["x-test-roles"] || "[]") };
      next();
    },
    tenantContextWarn: (req, res, next) => next(),
  };
});

const A = "68cbf7806080b4621d469d34";

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/policy", require("../routes/policy.routes"));
  app.use((req, res) => res.status(404).json({ notFound: true }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
let warnSpy;
beforeEach(() => {
  [mockCacheClear, mockCacheDelete, mockCacheStats, mockEffective, mockEffectiveWithHeaders, mockGetRoleHierarchy, mockGetAllPermissions, mockValidateToken].forEach((m) => m.mockClear());
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

function call(method, url, { tenant = A, roles, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const h = { "content-type": "application/json", ...headers };
    if (roles !== undefined) h["x-test-roles"] = JSON.stringify(roles);
    if (tenant && roles !== undefined) h["x-test-tenant"] = tenant;
    if (data) h["content-length"] = Buffer.byteLength(data);
    const req = http.request(`${base}${url}`, { method, headers: h }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const DELETES = [
  ["/policy/cache", () => mockCacheClear],
  ["/policy/cache/some-key", () => mockCacheDelete],
];

describe("DELETE /policy/cache* — SU-only operator actions", () => {
  test.each(DELETES)("SU: %s clears the cache", async (url, spy) => {
    const res = await call("DELETE", url, { roles: ["SU"] });
    expect(res.status).toBe(200);
    expect(spy()).toHaveBeenCalledTimes(1);
  });

  test.each(DELETES)("ASU / GS / ordinary / no roles: %s -> 403, cache untouched", async (url) => {
    for (const roles of [["ASU"], ["GS"], ["MEMBER"], [{ code: "ASU" }], []]) {
      const res = await call("DELETE", url, { roles });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: "FORBIDDEN", superUserRequired: true });
    }
    expect(mockCacheClear).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });

  test.each(DELETES)("unauthenticated (previous behaviour: allowed): %s -> rejected, cache untouched", async (url) => {
    const res = await call("DELETE", url, {});
    expect(res.status).toBe(401);
    expect(mockCacheClear).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });

  test.each(DELETES)("SU claimed in body/query/headers does not help a non-SU caller: %s", async (url) => {
    const res = await call("DELETE", `${url}?role=SU`, {
      roles: ["ASU"],
      headers: { "x-user-roles": '["SU"]', "x-role": "SU", "x-internal-request": "true" },
      body: { roles: ["SU"] },
    });
    expect(res.status).toBe(403);
    expect(mockCacheClear).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });

  test.each(DELETES)("no trusted tenant fails closed: %s", async (url) => {
    const res = await call("DELETE", url, { tenant: null, roles: ["SU"] });
    expect([400, 403]).toContain(res.status);
    expect(mockCacheClear).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });
});

describe("GET /policy/cache/stats — SU-only operator read (Phase 1C-2J)", () => {
  test("1 unauthenticated request cannot reach the handler", async () => {
    const res = await call("GET", "/policy/cache/stats", {});
    expect(res.status).toBe(401);
    expect(mockCacheStats).not.toHaveBeenCalled();
  });

  test("2 authenticated non-SU (ASU / GS / ordinary / role object / no roles) -> 403, handler not reached", async () => {
    for (const roles of [["ASU"], ["GS"], ["MEMBER"], [{ code: "ASU" }], []]) {
      const res = await call("GET", "/policy/cache/stats", { roles });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: "FORBIDDEN", superUserRequired: true });
      expect(res.body).not.toHaveProperty("stats");
    }
    expect(mockCacheStats).not.toHaveBeenCalled();
  });

  test("3 missing trusted tenant fails closed", async () => {
    const res = await call("GET", "/policy/cache/stats", { tenant: null, roles: ["SU"] });
    expect([400, 403]).toContain(res.status);
    expect(mockCacheStats).not.toHaveBeenCalled();
  });

  test("4 SU claims in query / headers / body cannot fake SU", async () => {
    const res = await call("GET", "/policy/cache/stats?role=SU&roles=SU", {
      roles: ["ASU"],
      headers: { "x-user-roles": '["SU"]', "x-role": "SU", "x-internal-request": "true" },
      body: { roles: ["SU"] },
    });
    expect(res.status).toBe(403);
    expect(mockCacheStats).not.toHaveBeenCalled();
  });

  test("5 valid SU reaches the handler", async () => {
    const res = await call("GET", "/policy/cache/stats", { roles: ["SU"] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, stats: { localCacheSize: 0 } });
    expect(mockCacheStats).toHaveBeenCalledTimes(1);
  });
});

describe("GET /policy/permissions/roles — dead handler removed, path behaviour unchanged", () => {
  test("no explicit /permissions/roles route is registered any more", () => {
    const router = require("../routes/policy.routes");
    const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
    expect(paths).not.toContain("/permissions/roles");
    expect(paths).toContain("/permissions/:resource");
  });

  test("the path is served by /permissions/:resource (resource 'roles'), exactly as before; global hierarchy never read", async () => {
    const res = await call("GET", "/policy/permissions/roles", { headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, resource: "roles" });
    expect(mockEffective).toHaveBeenCalledWith("x", "roles");
    expect(mockGetRoleHierarchy).not.toHaveBeenCalled();
  });

  test("without credentials it is 401, as before (from the :resource handler)", async () => {
    const res = await call("GET", "/policy/permissions/roles", {});
    expect(res.status).toBe(401);
    expect(mockGetRoleHierarchy).not.toHaveBeenCalled();
  });
});

describe.each(["system", "routes"])("GET /policy/permissions/%s — shadowed handler removed (Phase 1C-2K), behaviour unchanged", (name) => {
  const GENERIC_KEYS = ["permissions", "resource", "roles", "success", "tenantId", "timestamp", "userType"];

  test("1/2 no explicit route is registered any more; /permissions/:resource still is", () => {
    const router = require("../routes/policy.routes");
    const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
    expect(paths).not.toContain(`/permissions/${name}`);
    expect(paths).toContain("/permissions/:resource");
  });

  test("5 without credentials: same 401 as before (from the :resource handler)", async () => {
    const res = await call("GET", `/policy/permissions/${name}`, {});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authorization header required" });
    expect(mockEffective).not.toHaveBeenCalled();
  });

  test("3/4/6 bearer non-SU: served by /permissions/:resource with resource name; no catalogue / route map", async () => {
    const res = await call("GET", `/policy/permissions/${name}`, { headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(GENERIC_KEYS);
    expect(res.body).toMatchObject({ success: true, resource: name, permissions: [] });
    expect(res.body).not.toHaveProperty("routePermissions");
    expect(res.body).not.toHaveProperty("user");
    expect(mockEffective).toHaveBeenCalledWith("x", name);
  });

  test("3/4/6 gateway-header identity: served by /permissions/:resource (gateway branch)", async () => {
    const res = await call("GET", `/policy/permissions/${name}`, {
      headers: { "x-jwt-verified": "true", "x-auth-source": "gateway", "x-user-id": "u1", "x-tenant-id": A },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, resource: name });
    expect(res.body).not.toHaveProperty("routePermissions");
    expect(mockEffectiveWithHeaders).toHaveBeenCalledWith(expect.any(Object), name);
  });

  test("7 the global permission catalogue and the removed handlers' token check are never used", async () => {
    await call("GET", `/policy/permissions/${name}`, { headers: { authorization: "Bearer x" } });
    await call("GET", `/policy/permissions/${name}`, {});
    expect(mockGetAllPermissions).not.toHaveBeenCalled();
    expect(mockValidateToken).not.toHaveBeenCalled();
  });
});

test("8/9 /policy route table after Phase 1C-2K: exactly 10 routes, original relative order, no router-wide middleware", () => {
  const router = require("../routes/policy.routes");
  expect(router.stack.filter((x) => !x.route)).toHaveLength(0);
  const table = router.stack.filter((x) => x.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  expect(table).toEqual([
    "POST /evaluate",
    "POST /evaluate-batch",
    "GET /permissions/:resource",
    "GET /check/:resource/:action",
    "GET /health",
    "GET /info",
    "POST /ui/initialize",
    "GET /cache/stats",
    "DELETE /cache",
    "DELETE /cache/:key",
  ]);
  const generic = router.stack.find((l) => l.route && l.route.path === "/permissions/:resource");
  expect(generic.route.stack).toHaveLength(1); // still no middleware on the generic route
});

test("6/7/8 only DELETE /cache, DELETE /cache/:key and GET /cache/stats are guarded; no router-wide guard; other /policy routes unchanged", () => {
  const router = require("../routes/policy.routes");
  expect(router.stack.filter((x) => !x.route)).toHaveLength(0); // no router.use(...) middleware
  const guarded = [];
  for (const l of router.stack.filter((x) => x.route)) {
    const names = l.route.stack.map((s) => s.name);
    const isCacheOp = l.route.path.startsWith("/cache") && (l.route.methods.delete || l.route.methods.get);
    if (isCacheOp) guarded.push(`${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    if (isCacheOp) {
      expect(names.slice(0, 4)).toEqual(["authenticate", "tenantContextWarn", "requireTenant", "requireSuperUser"]);
    } else {
      expect(names).not.toContain("requireSuperUser");
      expect(names).not.toContain("authenticate");
    }
  }
  expect(guarded.sort()).toEqual(["DELETE /cache", "DELETE /cache/:key", "GET /cache/stats"]);
});
