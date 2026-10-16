/**
 * Stage 5c-2: route chain of POST /api/tenants/:id/auth-connections/:connectionId/test.
 *
 * Mounts the REAL tenant router with the REAL requireTenant / requireTenantPathAccess (same harness
 * as tests/tenantRoutes.pathGuard.test.js). authenticate and the policy adapter are stubs: the
 * trusted identity comes from x-test-* headers, and the policy stub permits only when the caller's
 * x-test-perms contain the exact permission the route asks for. The controller is a recording stub.
 *
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
    tenantContextWarn: (req, res, next) => next(),
    requireTenantPathAccess: (param) => {
      const mw = actual.requireTenantPathAccess(param);
      return (req, res, next) => (mockCalls.push(`pathGuard:${param}`), mw(req, res, next));
    },
  };
});
jest.mock("../helpers/policyAdapter", () => ({
  defaultPolicyAdapter: {
    middleware: (resource, action) => (req, res, next) => {
      mockCalls.push(`policy:${resource}:${action}`);
      const perms = JSON.parse(req.headers["x-test-perms"] || "[]");
      if (!perms.includes(`${resource}:${action}`)) return res.status(403).json({ denied: `${resource}:${action}` });
      return next();
    },
  },
}));
jest.mock("../controllers/tenant.controller", () =>
  new Proxy({}, {
    get: (_t, name) => (req, res) => {
      mockCalls.push(`controller:${String(name)}`);
      res.status(299).json({ handler: name, tenantId: req.params.id, connectionId: req.params.connectionId });
    },
  })
);
jest.mock("../controllers/tenantBranding.controller", () => new Proxy({}, { get: () => (req, res) => res.status(299).end() }));
jest.mock("../middlewares/upload.mw", () => ({ brandingAssetUploadMw: (req, res, next) => next() }));

const A = "68cbf7806080b4621d469d34";
const B = "aaaaaaaaaaaaaaaaaaaaaaaa";
const URL_FOR = (t) => `/api/tenants/${t}/auth-connections/conn1/test`;

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(require("../middlewares/response.mw"));
  app.use("/api", require("../routes/tenant.routes"));
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

function post(url, { tenant = A, roles = ["ASU"], perms = ["tenant:admin"] } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", "x-test-tenant": tenant, "x-test-roles": JSON.stringify(roles), "x-test-perms": JSON.stringify(perms) };
    if (!tenant) delete headers["x-test-tenant"];
    const req = http.request(`${base}${url}`, { method: "POST", headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    req.end("{}");
  });
}
const reachedController = () => mockCalls.some((c) => c.startsWith("controller:"));

describe("POST /tenants/:id/auth-connections/:connectionId/test", () => {
  test("A tenant administrator, own organisation -> guard, tenant:admin policy, testEntraConnection", async () => {
    const res = await post(URL_FOR(A));
    expect(res.status).toBe(299);
    expect(res.body).toEqual({ handler: "testEntraConnection", tenantId: A, connectionId: "conn1" });
    const i = (s) => mockCalls.indexOf(s);
    expect(i("pathGuard:id")).toBeGreaterThan(i("authenticate"));
    expect(i("policy:tenant:admin")).toBeGreaterThan(i("pathGuard:id"));
    expect(mockCalls[mockCalls.length - 1]).toBe("controller:testEntraConnection");
  });

  test("B another organisation's path -> 403 tenant scope violation before policy and controller", async () => {
    const res = await post(URL_FOR(B));
    expect(res.status).toBe(403);
    expect(res.body.error.tenantScopeViolation).toBe(true);
    expect(mockCalls.some((c) => c.startsWith("policy:"))).toBe(false);
    expect(reachedController()).toBe(false);
  });

  test("C without tenant:admin (read-only / no permission) -> refused by the policy, controller not reached", async () => {
    for (const perms of [["tenant:read"], []]) {
      mockCalls.length = 0;
      const res = await post(URL_FOR(A), { perms });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ denied: "tenant:admin" });
      expect(reachedController()).toBe(false);
    }
  });

  test("no trusted tenant -> refused by requireTenant before policy", async () => {
    const res = await post(URL_FOR(A), { tenant: null });
    expect(res.status).toBe(400);
    expect(res.body.error.missingTenant).toBe(true);
    expect(mockCalls).toContain("authenticate");
    expect(mockCalls.some((c) => c.startsWith("policy:"))).toBe(false);
    expect(reachedController()).toBe(false);
  });

  test("SU follows the existing tenant administration rule (may address another organisation)", async () => {
    const res = await post(URL_FOR(B), { roles: ["SU"] });
    expect(res.status).toBe(299);
    expect(mockCalls).toContain("policy:tenant:admin");
  });

  test("route declares requireTenant, requireTenantPathAccess(\"id\") and tenant:admin", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "tenant.routes.js"), "utf8");
    const route = '"/tenants/:id/auth-connections/:connectionId/test"';
    expect(src).toContain(route);
    const block = src.slice(src.indexOf(route), src.indexOf(");", src.indexOf(route)));
    expect(block).toMatch(/requireTenant,/);
    expect(block).toMatch(/requireTenantPathAccess\("id"\)/);
    expect(block).toContain('defaultPolicyAdapter.middleware("tenant", "admin")');
    expect(block).toContain("TenantController.testEntraConnection");
  });
});
