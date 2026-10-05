/**
 * Phase 1C-2D (M3) — global permission-catalogue and cache administration writes are SU-only.
 *
 * Mounts the REAL routes/permission.routes.js and routes/cache.routes.js with the REAL
 * requireTenant / requireSuperUser. authenticate, tenantContextWarn, the policy adapter and the
 * controllers are order-recording stubs; the trusted identity is injected per request via x-test-*
 * headers read ONLY by the stub authenticate (standing in for the gateway-verified req.ctx).
 * No DB / Redis / network.
 */
const http = require("http");
const express = require("express");

const mockCalls = [];

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
}));
jest.mock("../middlewares/auth", () => {
  const actual = jest.requireActual("../middlewares/auth");
  return {
    ...actual,
    authenticate: (req, res, next) => {
      mockCalls.push("authenticate");
      const t = req.headers["x-test-tenant"];
      if (t) req.ctx = { tenantId: t, userId: "u1", roles: JSON.parse(req.headers["x-test-roles"] || "[]") };
      next();
    },
    tenantContextWarn: (req, res, next) => (mockCalls.push("tenantContextWarn"), next()),
    requireSuperUser: (req, res, next) => (mockCalls.push("requireSuperUser"), actual.requireSuperUser(req, res, next)),
  };
});
jest.mock("../helpers/policyAdapter.js", () => ({
  defaultPolicyAdapter: {
    middleware: (resource, action) => (req, res, next) => (mockCalls.push(`policy:${resource}:${action}`), next()),
  },
}));
function mockControllerProxy(label) {
  return new Proxy({}, {
    get: (_t, name) => (req, res) => {
      mockCalls.push(`controller:${label}.${String(name)}`);
      res.status(299).json({ handler: name });
    },
  });
}
jest.mock("../controllers/permission.controller", () => mockControllerProxy("permission"));
jest.mock("../controllers/cache.controller", () => mockControllerProxy("cache"));

const A = "68cbf7806080b4621d469d34";
const B = "aaaaaaaaaaaaaaaaaaaaaaaa";

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", require("../routes/permission.routes"));
  app.use("/api", require("../routes/cache.routes"));
  app.use((req, res) => res.status(404).json({ notFound: true }));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
let warnSpy;
beforeEach(() => {
  mockCalls.length = 0;
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

function call(method, url, { tenant = A, roles = ["SU"], body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const h = { "content-type": "application/json", "x-test-roles": JSON.stringify(roles), ...headers };
    if (tenant) h["x-test-tenant"] = tenant;
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
const reached = (prefix) => mockCalls.some((c) => c.startsWith(prefix));

// [method, path, expected policy, controller fn]
const WRITES = [
  ["POST", "/api/permissions", "policy:permission:admin", "controller:permission.createPermission"],
  ["PUT", "/api/permissions/p1", "policy:permission:admin", "controller:permission.updatePermission"],
  ["DELETE", "/api/permissions/p1", "policy:permission:admin", "controller:permission.deletePermission"],
  ["POST", "/api/permissions/initialize", "policy:permission:admin", "controller:permission.initializeDefaultPermissions"],
  ["POST", "/api/cache/clear", "policy:admin:write", "controller:cache.clearAllCaches"],
  ["POST", "/api/cache/refresh/role-hierarchy", "policy:admin:write", "controller:cache.refreshRoleHierarchyCache"],
  ["POST", "/api/cache/refresh/permissions", "policy:admin:write", "controller:cache.refreshPermissionsCache"],
  ["POST", "/api/lookup/clear", "policy:admin:write", "controller:cache.clearLookupCaches"],
  ["POST", "/api/country/clear", "policy:admin:write", "controller:cache.clearCountryCaches"],
];

describe("M3 writes are SU-only", () => {
  test.each(WRITES)("A/G %s %s — SU: requireSuperUser -> existing policy -> controller", async (m, url, policy, ctl) => {
    const res = await call(m, url, { roles: ["SU"], body: m === "DELETE" ? undefined : { code: "X" } });
    expect(res.status).toBe(299);
    // (both routers mount path-less authenticate/tenantContextWarn at /api, so for cache routes the
    // permission router's pair also runs first — as in production; assert the order after the last one)
    expect(mockCalls[0]).toBe("authenticate");
    const tail = mockCalls.slice(mockCalls.lastIndexOf("tenantContextWarn") + 1);
    expect(tail).toEqual(["requireSuperUser", policy, ctl]);
  });

  test.each(WRITES)("B/C/H %s %s — ASU / GS / ordinary: 403 before policy and controller", async (m, url) => {
    for (const roles of [["ASU"], ["GS"], ["MEMBER"], [{ code: "ASU" }]]) {
      mockCalls.length = 0;
      const res = await call(m, url, { roles, body: m === "DELETE" ? undefined : { code: "X" } });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: "FORBIDDEN", superUserRequired: true });
      expect(reached("policy:")).toBe(false);
      expect(reached("controller:")).toBe(false);
    }
  });

  test.each(WRITES)("D %s %s — no roles / no trusted tenant fails closed", async (m, url) => {
    expect((await call(m, url, { roles: [] })).status).toBe(403);
    mockCalls.length = 0;
    const noTenant = await call(m, url, { tenant: null, roles: ["SU"] });
    expect([400, 403]).toContain(noTenant.status); // requireTenant (400) runs first
    expect(reached("controller:")).toBe(false);
  });

  test.each(WRITES)("E/F %s %s — SU claimed in body/query/headers, or tenant hints, do not help a non-SU caller", async (m, url) => {
    const res = await call(m, `${url}?role=SU&roles=SU&tenantId=${B}`, {
      roles: ["ASU"],
      body: m === "DELETE" ? undefined : { roles: ["SU"], role: "SU", tenantId: B, isSuperUser: true },
      headers: { "x-user-roles": '["SU"]', "x-tenant-id": B, "x-role": "SU" },
    });
    expect(res.status).toBe(403);
    expect(reached("controller:")).toBe(false);
  });

  test("F tenant values do not change the decision for SU either (SU allowed regardless of hints)", async () => {
    const res = await call("POST", `/api/cache/clear?tenantId=${B}`, { roles: ["SU"], headers: { "x-tenant-id": B } });
    expect(res.status).toBe(299);
  });
});

describe("I read-only routes keep their existing behaviour (no SU guard added)", () => {
  const READS = [
    ["/api/permissions", "policy:permission:admin"],
    ["/api/permissions/stats", "policy:permission:admin"],
    ["/api/permissions/p1", "policy:permission:admin"],
    ["/api/permissions/code/X", "policy:permission:admin"],
    ["/api/permissions/resource/role", "policy:permission:admin"],
    ["/api/permissions/category/CRM", "policy:permission:admin"],
    ["/api/cache/stats", "policy:admin:read"],
    ["/api/cache/performance/test", "policy:admin:read"],
    ["/api/role-hierarchy", "policy:admin:read"],
    ["/api/permissions-map", "policy:admin:read"],
    ["/api/role-permissions/GS", "policy:admin:read"],
    ["/api/lookup/stats", "policy:admin:read"],
  ];
  test.each(READS)("GET %s — non-SU reaches the existing policy check (unchanged)", async (url, policy) => {
    const res = await call("GET", url, { roles: ["ASU"] });
    expect(res.status).toBe(299);
    expect(mockCalls).not.toContain("requireSuperUser");
    expect(mockCalls).toContain(policy);
  });
});

test("route tables: every non-GET route in both routers is SU-guarded", () => {
  for (const file of ["permission.routes", "cache.routes"]) {
    const router = require(`../routes/${file}`);
    for (const l of router.stack.filter((x) => x.route)) {
      const methods = Object.keys(l.route.methods);
      const names = l.route.stack.map((s) => s.name);
      if (methods.includes("get")) continue;
      expect(names.slice(0, 2)).toEqual(["requireTenant", expect.any(String)]);
      expect(names.length).toBeGreaterThanOrEqual(4); // requireTenant, requireSuperUser, policy, controller
    }
  }
});
