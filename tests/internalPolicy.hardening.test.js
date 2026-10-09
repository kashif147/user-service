/**
 * Phase 1C-2I — internal /policy/* hardening.
 *
 *  - DELETE /policy/cache and DELETE /policy/cache/:key (documented operator actions, previously
 *    UNAUTHENTICATED) now require: authenticate -> tenantContextWarn -> requireTenant -> requireSuperUser.
 *  - The GET /policy/permissions/roles handler (global role hierarchy) was removed: it was unreachable
 *    because GET /permissions/:resource is declared first. Requests to that path keep their existing
 *    behaviour (served by /permissions/:resource with resource "roles").
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
jest.mock("../services/policyEvaluationService", () => ({
  cache: {
    clear: (...a) => mockCacheClear(...a),
    delete: (...a) => mockCacheDelete(...a),
    getStats: (...a) => mockCacheStats(...a),
  },
  getEffectivePermissions: (...a) => mockEffective(...a),
  getEffectivePermissionsWithHeaders: (...a) => mockEffectiveWithHeaders(...a),
  validateToken: async () => ({ valid: true, user: {} }),
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
  [mockCacheClear, mockCacheDelete, mockCacheStats, mockEffective, mockEffectiveWithHeaders, mockGetRoleHierarchy].forEach((m) => m.mockClear());
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
