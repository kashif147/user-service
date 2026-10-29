/**
 * Phase 1C-2D (M3) — global permission-catalogue and cache administration writes were SU-only.
 * Phase B / Z5: they are PLATFORM operations now - requirePlatformPermission(route-enforce) with the exact
 * platform permission; legacy SU (any tenant, with "*"), ASU and ordinary users are denied (403
 * PLATFORM_AUTHORITY_REQUIRED) before any policy or controller; only a live principal holding the exact code
 * passes. (The full Z5 matrix: tests/platformRoutes.z5.test.js.)
 *
 * Mounts the REAL routes/permission.routes.js and routes/cache.routes.js with the REAL
 * requireTenant / requireSuperUser. authenticate, tenantContextWarn, the policy adapter and the
 * controllers are order-recording stubs; the trusted identity is injected per request via x-test-*
 * headers read ONLY by the stub authenticate (standing in for the gateway-verified req.ctx).
 * No DB / Redis / network.
 */
// Phase A / A-5 review: permission-catalogue writes are frozen (423) by default (globalDataFreeze.a5r.test.js);
// the SU-only chain below still applies behind the freeze, so it runs in the ops rollback mode.
process.env.GLOBAL_DATA_WRITES = "open";
process.env.PLATFORM_AUTH_MODE = "shadow"; // global mode; the migrated routes enforce regardless (route-enforce)
const http = require("http");
const { useTestSecret, bearer, platClaim, installPrincipal } = require("./helpers/platformActor");
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
beforeEach(() => {
  mockCalls.length = 0;
  useTestSecret();
  for (const m of ["warn", "info"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// Every call carries a real ProjectShell bearer for the same identity the stub authenticate puts in req.ctx
// (user u1 in `tenant`), with the tenant "*" wildcard - as a legacy SU token has.
function call(method, url, { tenant = A, roles = ["SU"], body, headers = {}, plat, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const h = { "content-type": "application/json", "x-test-roles": JSON.stringify(roles), ...headers };
    if (auth) h.authorization = bearer({ userId: "6a00000000000000000000c1", tenantId: tenant || A, roles, plat });
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

// [method, path, required platform permission, controller fn]
const CODE = (url) => (url.startsWith("/api/permissions") ? "platform:permission-catalogue:manage" : "platform:cache:admin");

describe("M3 writes are platform operations (Z5): SU / ASU / ordinary denied, exact platform permission allowed", () => {
  test.each(WRITES)("A/G %s %s — legacy SU with '*': 403 PLATFORM_AUTHORITY_REQUIRED; no policy, no controller", async (m, url) => {
    const res = await call(m, url, { roles: ["SU"], body: m === "DELETE" ? undefined : { code: "X" } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "PLATFORM_AUTHORITY_REQUIRED" });
    expect(reached("policy:")).toBe(false);
    expect(reached("controller:")).toBe(false);
    expect(mockCalls).not.toContain("requireSuperUser");
  });

  test.each(WRITES)("B/C/H %s %s — ASU / GS / ordinary: 403 before policy and controller", async (m, url) => {
    for (const roles of [["ASU"], ["GS"], ["MEMBER"], [{ code: "ASU" }]]) {
      mockCalls.length = 0;
      const res = await call(m, url, { roles, body: m === "DELETE" ? undefined : { code: "X" } });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: "PLATFORM_AUTHORITY_REQUIRED" });
      expect(reached("policy:")).toBe(false);
      expect(reached("controller:")).toBe(false);
    }
  });

  test.each(WRITES)("D %s %s — no roles / no bearer fails closed", async (m, url) => {
    expect((await call(m, url, { roles: [] })).status).toBe(403);
    mockCalls.length = 0;
    const noToken = await call(m, url, { auth: false });
    expect(noToken.status).toBe(401);
    expect(reached("controller:")).toBe(false);
  });

  test.each(WRITES)("E/F %s %s — SU claimed in body/query/headers, or tenant hints, do not help", async (m, url) => {
    const res = await call(m, `${url}?role=SU&roles=SU&tenantId=${B}`, {
      roles: ["ASU"],
      body: m === "DELETE" ? undefined : { roles: ["SU"], role: "SU", tenantId: B, isSuperUser: true, plat: platClaim() },
      headers: { "x-user-roles": '["SU"]', "x-tenant-id": B, "x-role": "SU", "x-platform-pid": "6a0000000000000000000a05" },
    });
    expect(res.status).toBe(403);
    expect(reached("controller:")).toBe(false);
  });

  test.each(WRITES)("P %s %s — a live principal with the EXACT platform permission reaches the controller (no SU, no policy)", async (m, url, _policy, ctl) => {
    installPrincipal({ permissions: [CODE(url)], userId: "6a00000000000000000000c1", tenantId: A });
    const res = await call(m, url, { roles: [], plat: platClaim(), body: m === "DELETE" ? undefined : { code: "X" } });
    expect(res.status).toBe(299);
    const tail = mockCalls.slice(mockCalls.lastIndexOf("tenantContextWarn") + 1);
    expect(tail).toEqual([ctl]);
  });

  test.each(WRITES)("Q %s %s — a principal holding a DIFFERENT platform permission is denied", async (m, url) => {
    const other = CODE(url) === "platform:cache:admin" ? "platform:permission-catalogue:manage" : "platform:cache:admin";
    installPrincipal({ permissions: [other, "platform:tenant:create", "platform:reference-data:manage"], userId: "6a00000000000000000000c1", tenantId: A });
    const res = await call(m, url, { roles: ["SU"], plat: platClaim(), body: m === "DELETE" ? undefined : { code: "X" } });
    expect(res.status).toBe(403);
    expect(reached("controller:")).toBe(false);
  });
});

describe("I permission-catalogue read routes keep their existing behaviour (no SU guard added)", () => {
  // (Phase 1C-2H made the cache.routes.js admin:read GETs SU-only — see platformReads.suGuard.test.js)
  const READS = [
    ["/api/permissions", "policy:permission:admin"],
    ["/api/permissions/stats", "policy:permission:admin"],
    ["/api/permissions/p1", "policy:permission:admin"],
    ["/api/permissions/code/X", "policy:permission:admin"],
    ["/api/permissions/resource/role", "policy:permission:admin"],
    ["/api/permissions/category/CRM", "policy:permission:admin"],
  ];
  test.each(READS)("GET %s — non-SU reaches the existing policy check (unchanged)", async (url, policy) => {
    const res = await call("GET", url, { roles: ["ASU"] });
    expect(res.status).toBe(299);
    expect(mockCalls).not.toContain("requireSuperUser");
    expect(mockCalls).toContain(policy);
  });
});

test("route tables: every non-GET route in both routers is guarded by enforcing platform authorization only", () => {
  for (const file of ["permission.routes", "cache.routes"]) {
    const router = require(`../routes/${file}`);
    for (const l of router.stack.filter((x) => x.route)) {
      const methods = Object.keys(l.route.methods);
      if (methods.includes("get") && file === "permission.routes") continue;
      // Phase B / Z5: [platformAuthzGuard, controller] - no requireTenant / requireSuperUser / tenant PDP.
      const names = l.route.stack.map((s) => s.name);
      expect(names[0]).toBe("platformAuthzGuard");
      expect(names).toHaveLength(2);
      expect(names).not.toContain("requireSuperUser");
    }
  }
});
