/**
 * Phase 1C-2H — platform-wide role/permission/cache READS were SU-only.
 * Phase B / Z5: they are PLATFORM operations now - platform:cache:admin (route-enforce); legacy SU with "*",
 * ASU and ordinary users get 403 PLATFORM_AUTHORITY_REQUIRED and no global data; admin:* tenant grants no
 * longer count (left in data for Z9 cleanup).
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
process.env.PLATFORM_AUTH_MODE = "shadow"; // global mode; cache routes enforce regardless (route-enforce)
const http = require("http");
const express = require("express");
const { useTestSecret, bearer, platClaim, installPrincipal } = require("./helpers/platformActor");

const mockCalls = [];

jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../services/roleHierarchyService", () => ({
  isTenantAdmin: () => false,
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
      if (t) req.ctx = { tenantId: t, userId: "6a00000000000000000000c1", roles: JSON.parse(req.headers["x-test-roles"] || "[]") };
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
beforeEach(() => {
  mockCalls.length = 0;
  useTestSecret();
  for (const m of ["warn", "info"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function get(url, { tenant = A, roles = ["SU"], headers = {}, plat, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const h = { "x-test-roles": JSON.stringify(roles), ...headers };
    if (auth) h.authorization = bearer({ userId: "6a00000000000000000000c1", tenantId: tenant || A, roles, plat });
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

describe("platform reads require platform:cache:admin (Z5)", () => {
  test.each(READS)("A %s — legacy SU with '*': 403, no admin:read policy, no controller", async (url) => {
    const res = await get(url, { roles: ["SU"] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "PLATFORM_AUTHORITY_REQUIRED" });
    expect(reached("policy:")).toBe(false);
    expect(reached("controller:")).toBe(false);
  });

  test.each(READS)("B %s — ASU / GS / ordinary: 403 before policy and controller (no global data)", async (url) => {
    for (const roles of [["ASU"], ["GS"], ["MEMBER"], [{ code: "ASU" }], []]) {
      mockCalls.length = 0;
      const res = await get(url, { roles });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: "PLATFORM_AUTHORITY_REQUIRED" });
      expect(res.body).not.toHaveProperty("hierarchy");
      expect(reached("policy:")).toBe(false);
      expect(reached("controller:")).toBe(false);
    }
  });

  test.each(READS)("D %s — query/header SU or tenant hints cannot widen a caller's scope", async (url) => {
    const sep = url.includes("?") ? "&" : "?";
    const res = await get(`${url}${sep}role=SU&tenantId=${B}`, {
      roles: ["ASU"],
      headers: { "x-user-roles": '["SU"]', "x-tenant-id": B, "x-role": "SU" },
    });
    expect(res.status).toBe(403);
    expect(reached("controller:")).toBe(false);
  });

  test.each(READS)("%s — no bearer token fails closed (401)", async (url) => {
    const res = await get(url, { auth: false, roles: ["SU"] });
    expect(res.status).toBe(401);
    expect(reached("controller:")).toBe(false);
  });

  test.each(READS)("P %s — a live principal holding platform:cache:admin reaches the controller directly", async (url, ctl) => {
    installPrincipal({ permissions: ["platform:cache:admin"], userId: "6a00000000000000000000c1", tenantId: A });
    const res = await get(url, { roles: [], plat: platClaim() });
    expect(res.status).toBe(299);
    expect(mockCalls).toEqual(["authenticate", "tenantContextWarn", ctl]);
  });

  test.each(READS)("Q %s — a principal without platform:cache:admin (other platform codes only) is denied", async (url) => {
    installPrincipal({ permissions: ["platform:tenant:create", "platform:permission-catalogue:manage", "platform:reference-data:manage"], userId: "6a00000000000000000000c1", tenantId: A });
    const res = await get(url, { roles: ["SU"], plat: platClaim() });
    expect(res.status).toBe(403);
    expect(reached("controller:")).toBe(false);
  });
});

test("E every route in cache.routes.js (reads and writes) is guarded by enforcing platform:cache:admin only", () => {
  const router = require("../routes/cache.routes");
  const routes = router.stack.filter((x) => x.route);
  expect(routes.length).toBe(11);
  for (const l of routes) {
    const names = l.route.stack.map((s) => s.name);
    expect(names).toEqual(["platformAuthzGuard", expect.any(String)]);
  }
});

test("F the internal /policy router stays mounted at /policy (not under /api); only its operator /cache routes (2 DELETEs + GET /cache/stats) are platform-guarded (Phase 1C-2I/2J; Z9: platform:cache:admin, no SU)", () => {
  const fs = require("fs");
  const path = require("path");
  const index = fs.readFileSync(path.join(__dirname, "..", "routes", "index.js"), "utf8");
  expect(index).toMatch(/router\.use\("\/policy", require\("\.\/policy\.routes"\)\)/);
  const policy = fs.readFileSync(path.join(__dirname, "..", "routes", "policy.routes.js"), "utf8");
  expect(policy).not.toMatch(/requireSuperUser/);
  expect((policy.match(/^  requirePlatformPermission\("platform:cache:admin", \{ mode: "route-enforce" \}\),$/gm) || []).length).toBe(3); // DELETE /cache, DELETE /cache/:key, GET /cache/stats
});
