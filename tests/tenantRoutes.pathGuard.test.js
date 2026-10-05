/**
 * Phase 1C-2B — B1/B2: routes addressing a tenant by URL are bound to the trusted tenant.
 *
 * Mounts the REAL routers (tenantOffice, tenantPublicHoliday, tenantDepartment, tenantContact,
 * tenant) with the REAL requireTenant / requireTenantPathAccess / hasRole. authenticate,
 * tenantContextWarn, the policy adapter, B1 controllers and the tenant handler are order-recording
 * stubs. The trusted identity is injected per request via x-test-* headers read ONLY by the
 * stub authenticate (standing in for the gateway-verified context).
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
    tenantContextWarn: (req, res, next) => (mockCalls.push("tenantContextWarn"), next()),
    requireTenantPathAccess: (param) => {
      const mw = actual.requireTenantPathAccess(param);
      return (req, res, next) => (mockCalls.push(`pathGuard:${param}`), mw(req, res, next));
    },
  };
});
jest.mock("../helpers/policyAdapter", () => ({
  defaultPolicyAdapter: {
    middleware: (resource, action) => (req, res, next) => (mockCalls.push(`policy:${resource}:${action}`), next()),
  },
}));
function mockControllerProxy(label) {
  return new Proxy({}, {
    get: (_t, name) => (req, res) => {
      mockCalls.push(`controller:${label}.${String(name)}`);
      res.status(299).json({ handler: name, tenantId: req.params.tenantId || req.params.id || null });
    },
  });
}
jest.mock("../controllers/tenantOffice.controller", () => mockControllerProxy("office"));
jest.mock("../controllers/tenantPublicHoliday.controller", () => mockControllerProxy("holiday"));
jest.mock("../controllers/tenantDepartment.controller", () => mockControllerProxy("department"));
jest.mock("../controllers/tenantContact.controller", () => mockControllerProxy("contact"));
jest.mock("../controllers/tenantBranding.controller", () => mockControllerProxy("branding"));
jest.mock("../middlewares/upload.mw", () => ({ brandingAssetUploadMw: (req, res, next) => next() }));
// Real tenant.controller; its handler is stubbed and records every call.
const mockTenantHandlerCalls = [];
const mockTenantRows = [
  { _id: "68cbf7806080b4621d469d34", code: "INMO", domain: "inmo.example" },
  { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", code: "OTHER", domain: "other.example" },
];
jest.mock("../handlers/tenant.handler", () =>
  new Proxy({}, {
    get: (_t, name) => async (...args) => {
      mockTenantHandlerCalls.push({ name: String(name), args });
      if (name === "getAllTenants") return [{ _id: "t" }];
      if (name === "getTenantByCode" || name === "getTenantByDomain") {
        // simulate the DB selector: { code|domain, isActive } (+ ownership when ownTenantId given)
        const field = name === "getTenantByCode" ? "code" : "domain";
        const own = args[1] && args[1].ownTenantId;
        return mockTenantRows.find((t) => t[field] === args[0] && (!own || t._id === own)) || null;
      }
      return { _id: args[0] };
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
  app.use(require("../middlewares/response.mw")); // same as app.js: res.success / res.notFoundRecord …
  for (const r of ["tenant", "tenantOffice", "tenantPublicHoliday", "tenantDepartment", "tenantContact"]) {
    app.use("/api", require(`../routes/${r}.routes`));
  }
  app.use((req, res) => res.status(404).json({ notFound: true }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // as app.js
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
let warnSpy;
beforeEach(() => {
  mockCalls.length = 0;
  mockTenantHandlerCalls.length = 0;
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

function call(method, url, { tenant = A, roles = ["ASU"], body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const headers = { "content-type": "application/json", "x-test-tenant": tenant, "x-test-roles": JSON.stringify(roles) };
    if (!tenant) delete headers["x-test-tenant"];
    if (data) headers["content-length"] = Buffer.byteLength(data);
    const req = http.request(`${base}${url}`, { method, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const hasController = () => mockCalls.some((c) => c.startsWith("controller:"));
const hasPolicy = () => mockCalls.some((c) => c.startsWith("policy:"));

// ---------------------------------------------------------------------------
// B1 — one representative read + write per domain
// ---------------------------------------------------------------------------
const B1 = [
  ["office", "GET", "/offices", "policy:tenant:read"],
  ["office", "PUT", "/offices/x1", "policy:tenant:update"],
  ["holiday", "GET", "/public-holidays", "policy:tenant:read"],
  ["holiday", "POST", "/public-holidays", "policy:tenant:update"],
  ["department", "GET", "/departments/x1", "policy:tenant:read"],
  ["department", "DELETE", "/departments/x1", "policy:tenant:delete"],
  ["contact", "GET", "/departments/d1/contacts", "policy:tenant:read"],
  ["contact", "PATCH", "/departments/d1/contacts/x1/primary", "policy:tenant:update"],
];

describe("B1 /tenants/:tenantId/* (offices, public holidays, departments, contacts)", () => {
  test.each(B1)("%s %s %s — same tenant: authenticate -> tenantContextWarn -> guard -> policy -> controller", async (_d, m, suffix, policy) => {
    const res = await call(m, `/api/tenants/${A}${suffix}`, { body: m === "GET" ? undefined : { tenantId: B } });
    expect(res.status).toBe(299);
    const i = (s) => mockCalls.indexOf(s);
    expect(i("authenticate")).toBe(0);
    expect(i("tenantContextWarn")).toBe(1);
    expect(i("pathGuard:tenantId")).toBeGreaterThan(1);
    expect(i(policy)).toBeGreaterThan(i("pathGuard:tenantId"));
    expect(mockCalls[mockCalls.length - 1]).toMatch(/^controller:/);
  });

  test.each(B1)("%s %s %s — cross tenant (ASU): 403 before policy/controller", async (_d, m, suffix) => {
    const res = await call(m, `/api/tenants/${B}${suffix}`, { body: m === "GET" ? undefined : { tenantId: B } });
    expect(res.status).toBe(403);
    expect(res.body.error.tenantScopeViolation).toBe(true);
    expect(mockCalls).toContain("pathGuard:tenantId");
    expect(hasPolicy()).toBe(false);
    expect(hasController()).toBe(false);
  });

  test.each(B1)("%s %s %s — SU may manage another tenant", async (_d, m, suffix, policy) => {
    const res = await call(m, `/api/tenants/${B}${suffix}`, { roles: ["SU"] });
    expect(res.status).toBe(299);
    expect(mockCalls).toContain(policy);
    expect(hasController()).toBe(true);
  });

  test("own-tenant /tenant/* routes (no tenant in path) are unchanged — no path guard", async () => {
    const res = await call("GET", "/api/tenant/offices");
    expect(res.status).toBe(299);
    expect(mockCalls.some((c) => c.startsWith("pathGuard:"))).toBe(false);
  });

  test("every /tenants/:tenantId route in the four B1 routers mounts the guard", () => {
    for (const r of ["tenantOffice", "tenantPublicHoliday", "tenantDepartment", "tenantContact"]) {
      const router = require(`../routes/${r}.routes`);
      const routes = router.stack.filter((l) => l.route && l.route.path.startsWith("/tenants/:tenantId"));
      expect(routes.length).toBeGreaterThan(0);
      for (const l of routes) {
        const names = l.route.stack.map((s) => s.name);
        expect(names.slice(0, 2)).toEqual(["requireTenant", expect.any(String)]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// B2 — tenant routes
// ---------------------------------------------------------------------------
const B2 = [
  ["GET", "", "policy:tenant:read", "getTenantById"],
  ["PUT", "", "policy:tenant:update", "updateTenant"],
  ["DELETE", "", "policy:tenant:delete", "deleteTenant"],
  ["GET", "/stats", "policy:tenant:read", "getTenantStats"],
  ["PUT", "/status", "policy:tenant:update", "updateTenantStatus"],
  ["PATCH", "/organisation-profile", "policy:tenant:update", null],
  ["PATCH", "/branding", "policy:tenant:update", null],
  ["PATCH", "/regional-settings", "policy:tenant:update", null],
  ["POST", "/branding/assets", "policy:tenant:update", null],
  ["POST", "/auth-connections", "policy:tenant:admin", "addAuthenticationConnection"],
  ["GET", "/auth-connections", "policy:tenant:read", "getAuthenticationConnections"],
  ["PUT", "/auth-connections/c1", "policy:tenant:admin", "updateAuthenticationConnection"],
  ["DELETE", "/auth-connections/c1", "policy:tenant:admin", "removeAuthenticationConnection"],
];

describe("B2 /tenants/:id*", () => {
  test.each(B2)("%s /tenants/:id%s — cross tenant (ASU): 403 before policy/controller/handler", async (m, suffix) => {
    const res = await call(m, `/api/tenants/${B}${suffix}`, { body: m === "GET" ? undefined : { status: "active" } });
    expect(res.status).toBe(403);
    expect(mockCalls).toContain("pathGuard:id");
    expect(hasPolicy()).toBe(false);
    expect(hasController()).toBe(false);
    expect(mockTenantHandlerCalls).toHaveLength(0);
  });

  test.each(B2.filter((r) => r[3]))("%s /tenants/:id%s — same tenant reaches policy then handler with the path id", async (m, suffix, policy, handler) => {
    const res = await call(m, `/api/tenants/${A}${suffix}`, { body: m === "GET" ? undefined : { status: "active", connectionType: "x" } });
    expect(mockCalls).toEqual(["authenticate", "tenantContextWarn", "pathGuard:id", policy]);
    const h = mockTenantHandlerCalls.find((c) => c.name === handler);
    expect(h).toBeDefined();
    expect(h.args[0]).toBe(A);
    expect(res.status).not.toBe(403);
  });

  test.each(B2)("%s /tenants/:id%s — SU passes the guard for another tenant", async (m, suffix, policy) => {
    await call(m, `/api/tenants/${B}${suffix}`, { roles: ["SU"], body: m === "GET" ? undefined : { status: "active" } });
    expect(mockCalls).toContain("pathGuard:id");
    expect(mockCalls).toContain(policy);
  });

  test("unauthenticated (no trusted tenant) /tenants/:id fails closed", async () => {
    const res = await call("GET", `/api/tenants/${A}`, { tenant: null });
    expect([400, 403]).toContain(res.status); // requireTenant (400) runs before the guard (403)
    expect(hasPolicy()).toBe(false);
    expect(mockTenantHandlerCalls).toHaveLength(0);
  });
});

describe("B2 GET /tenants listing", () => {
  test("non-SU: handler query restricted to the trusted tenant (query/body hints ignored)", async () => {
    const res = await call("GET", `/api/tenants?status=active&tenantId=${B}&ownTenantId=${B}`, { roles: ["ASU"] });
    expect(res.status).toBe(200);
    const c = mockTenantHandlerCalls.find((x) => x.name === "getAllTenants");
    expect(c.args[0]).toEqual({ status: "active", plan: undefined, ownTenantId: A });
  });

  test("SU: platform-wide listing (no ownTenantId restriction)", async () => {
    const res = await call("GET", "/api/tenants", { roles: ["SU"] });
    expect(res.status).toBe(200);
    const c = mockTenantHandlerCalls.find((x) => x.name === "getAllTenants");
    expect(c.args[0]).toEqual({ status: undefined, plan: undefined });
  });

  test("/tenants/code/:code and /tenants/domain/:domain are not path-guarded (param is not a tenant id)", async () => {
    await call("GET", "/api/tenants/code/INMO");
    expect(mockCalls.some((c) => c.startsWith("pathGuard:"))).toBe(false);
  });
});

describe("B2 GET /tenants/code/:code and /tenants/domain/:domain — ownership from trusted tenant", () => {
  const lookups = [
    ["code", "INMO", "OTHER", "getTenantByCode"],
    ["domain", "inmo.example", "other.example", "getTenantByDomain"],
  ];

  test.each(lookups)("%s: same-tenant non-SU receives its own tenant", async (seg, own, _other, fn) => {
    const res = await call("GET", `/api/tenants/${seg}/${own}`, { roles: ["ASU"] });
    expect(res.status).toBe(200);
    expect(res.body.data._id).toBe(A);
    const c = mockTenantHandlerCalls.find((x) => x.name === fn);
    expect(c.args[1]).toEqual({ ownTenantId: A }); // ownership comes from req.ctx, not the lookup value
  });

  test.each(lookups)("%s: different tenant non-SU gets 404 and no record", async (seg, _own, other) => {
    const res = await call("GET", `/api/tenants/${seg}/${other}?tenantId=${B}`, { roles: ["ASU"], body: undefined });
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("data");
  });

  test.each(lookups)("%s: SU retrieves another tenant (unscoped selector)", async (seg, _own, other, fn) => {
    const res = await call("GET", `/api/tenants/${seg}/${other}`, { roles: ["SU"] });
    expect(res.status).toBe(200);
    expect(res.body.data._id).toBe(B);
    expect(mockTenantHandlerCalls.find((x) => x.name === fn).args[1]).toEqual({});
  });

  test.each(lookups)("%s: trusted tenant drives ownership (Tenant B caller sees only B)", async (seg, own, other) => {
    expect((await call("GET", `/api/tenants/${seg}/${other}`, { tenant: B, roles: ["ASU"] })).status).toBe(200);
    expect((await call("GET", `/api/tenants/${seg}/${own}`, { tenant: B, roles: ["ASU"] })).status).toBe(404);
  });
});

describe("POST /tenants is SU-only (trusted roles)", () => {
  test("SU can create: guard -> policy -> handler", async () => {
    const res = await call("POST", "/api/tenants", { roles: ["SU"], body: { name: "New", code: "NEW" } });
    expect(res.status).toBe(201);
    expect(mockCalls).toEqual(["authenticate", "tenantContextWarn", "policy:tenant:create"]);
    expect(mockTenantHandlerCalls.map((c) => c.name)).toEqual(["createTenant"]);
  });

  test.each([[["ASU"]], [["GS"]], [[]]])("non-SU %p gets 403; policy/controller/handler not called", async (roles) => {
    const res = await call("POST", "/api/tenants", { roles, body: { name: "New", code: "NEW", roles: ["SU"] } });
    expect(res.status).toBe(403);
    expect(res.body.error.superUserRequired).toBe(true);
    expect(hasPolicy()).toBe(false);
    expect(mockTenantHandlerCalls).toHaveLength(0);
  });
});
