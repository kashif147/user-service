/**
 * Phase 1C-2H — platform-wide role/permission/cache READS are SU-only.
 *
 * routes/cache.routes.js GETs expose global, tenant-derived or platform-operational data:
 *   /role-hierarchy            code -> level map built from EVERY tenant's roles (order-dependent)
 *   /role-permissions/:code    a role's permissions looked up by CODE across tenants
 *   /permissions-map           the global permission catalogue grouped by resource
 *   /cache/stats, /cache/performance/test, /lookup/stats   platform cache administration
 * None has a frontend/service caller; tenant admins use tenant-scoped GET /roles, /roles/:id,
 * /tenant/roles and /tenant/permissions instead.
 *
 * Mounts the REAL cache.routes.js with the REAL requireTenant / requireSuperUser; authenticate,
 * the policy adapter and the controller are recording stubs. No DB / Redis / network.
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
jest.mock("../controllers/cache.controller", () =>
  new Proxy({}, {
    get: (_t, name) => (req, res) => {
      mockCalls.push(`controller:${String(name)}`);
      res.status(299).json({ handler: name, roleCode: req.params.roleCode || null });
    },
  })
);

const A = "68cbf7806080b4621d469d34";
const B = "aaaaaaaaaaaaaaaaaaaaaaaa";

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
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

function get(url, { tenant = A, roles = ["SU"], headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { "x-test-roles": JSON.stringify(roles), ...headers };
    if (tenant) h["x-test-tenant"] = tenant;
    http
      .get(`${base}${url}`, { headers: h }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      })
      .on("error", reject);
  });
}
const reached = (prefix) => mockCalls.some((c) => c.startsWith(prefix));

const READS = [
  ["/api/role-hierarchy", "controller:getRoleHierarchy"],
  ["/api/permissions-map", "controller:getPermissionsMap"],
  ["/api/role-permissions/GS", "controller:getRolePermissions"],
  ["/api/cache/stats", "controller:getCacheStats"],
  ["/api/cache/performance/test", "controller:testCachePerformance"],
  ["/api/lookup/stats", "controller:getLookupCacheStats"],
];

describe("platform reads are SU-only", () => {
  test.each(READS)("A %s — SU: requireSuperUser -> existing admin:read policy -> controller", async (url, ctl) => {
    const res = await get(url, { roles: ["SU"] });
    expect(res.status).toBe(299);
    expect(mockCalls).toEqual(["authenticate", "tenantContextWarn", "requireSuperUser", "policy:admin:read", ctl]);
  });

  test.each(READS)("B %s — ASU / GS / ordinary: 403 before policy and controller (no global data)", async (url) => {
    for (const roles of [["ASU"], ["GS"], ["MEMBER"], [{ code: "ASU" }], []]) {
      mockCalls.length = 0;
      const res = await get(url, { roles });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: "FORBIDDEN", superUserRequired: true });
      expect(res.body).not.toHaveProperty("hierarchy");
      expect(reached("policy:")).toBe(false);
      expect(reached("controller:")).toBe(false);
    }
  });

  test.each(READS)("D %s — query/header SU or tenant hints cannot widen a non-SU caller's scope", async (url) => {
    const sep = url.includes("?") ? "&" : "?";
    const res = await get(`${url}${sep}role=SU&tenantId=${B}`, {
      roles: ["ASU"],
      headers: { "x-user-roles": '["SU"]', "x-tenant-id": B, "x-role": "SU" },
    });
    expect(res.status).toBe(403);
    expect(reached("controller:")).toBe(false);
  });

  test.each(READS)("%s — no trusted tenant context fails closed", async (url) => {
    const res = await get(url, { tenant: null, roles: ["SU"] });
    expect([400, 403]).toContain(res.status); // requireTenant (400) runs first
    expect(reached("controller:")).toBe(false);
  });
});

test("E every route in cache.routes.js (reads and writes) is now SU-guarded", () => {
  const router = require("../routes/cache.routes");
  const routes = router.stack.filter((x) => x.route);
  expect(routes.length).toBe(11);
  for (const l of routes) {
    const names = l.route.stack.map((s) => s.name);
    expect(names.slice(0, 2)).toEqual(["requireTenant", "requireSuperUser"]);
  }
});

test("F the internal /policy router is untouched by this phase (not mounted under /api, no SU guard added)", () => {
  const fs = require("fs");
  const path = require("path");
  const index = fs.readFileSync(path.join(__dirname, "..", "routes", "index.js"), "utf8");
  expect(index).toMatch(/router\.use\("\/policy", require\("\.\/policy\.routes"\)\)/);
  const policy = fs.readFileSync(path.join(__dirname, "..", "routes", "policy.routes.js"), "utf8");
  expect(policy).not.toMatch(/requireSuperUser/);
});
