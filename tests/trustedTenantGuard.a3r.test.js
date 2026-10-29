/**
 * Phase A / A-3 review — lookup / lookup-type / country reads require a TRUSTED tenant.
 *
 * requireTenant only checks truthiness, so a signed token with a placeholder tenant ("default",
 * "unknown", ...) used to reach these reads and get the shared rows. requireTrustedTenant (same rule as
 * the lookup cache keys) now answers requireTenant's 400 shape first; a valid tenant is unaffected.
 * REAL lookup router/controllers over HTTP (tests/helpers/a3Fixtures.js); route stacks for the
 * lookuptype and country routers.
 */
// Phase B / Z5: shared-data writes are platform-authorized first (real guard + evaluator), then frozen.
// DEV runs PLATFORM_AUTH_MODE=shadow globally; the migrated routes enforce regardless (route-enforce).
process.env.PLATFORM_AUTH_MODE = "shadow";
jest.mock("../rabbitMQ", () => ({ publishDomainEvent: async () => true }));
jest.mock("../models/lookup.model", () => require("./helpers/a3Fixtures").Lookup);
jest.mock("../models/lookupType.model", () => require("./helpers/a3Fixtures").LookupType);
jest.mock("../models/productType.model", () => require("./helpers/a3Fixtures").ProductType);
jest.mock("../models/product.model", () => require("./helpers/a3Fixtures").Product);
jest.mock("../models/pricing.model", () => ({}));
jest.mock("../services/policyCache", () => require("./helpers/a3Fixtures").FakePolicyCache);
jest.mock("../controllers/me.controller", () => ({ invalidateMeCache: async () => {} }));
jest.mock("../rabbitMQ/publishers/product.publisher", () => ({
  publishProductCreated: async () => {},
  publishProductUpdated: async () => {},
  publishProductDeleted: async () => {},
}));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../helpers/policyAdapter.js", () => ({
  defaultPolicyAdapter: { middleware: () => (req, res, next) => next() },
}));
jest.mock("../middlewares/auth", () => require("./helpers/a3Fixtures").authMock());
// Only the real logging-lib createLogger() methods used here (it has no info/warn).
jest.mock("../config/bizLogger.js", () => ({ business: jest.fn(), error: jest.fn() }));
jest.mock("../controllers/country.controller", () => ({
  getAllCountries: (req, res) => res.json({ ok: true }),
  searchCountries: (req, res) => res.json({ ok: true }),
  getCountryByCode: (req, res) => res.json({ ok: true }),
  getCountryById: (req, res) => res.json({ ok: true }),
  createCountry: (req, res) => res.json({ ok: true }),
  updateCountry: (req, res) => res.json({ ok: true }),
  deleteCountry: (req, res) => res.json({ ok: true }),
}));

const fx = require("./helpers/a3Fixtures");
const { A, B, D, TYPES, call, cacheOps } = fx;
const { requireTrustedTenant } = require("../middlewares/requireTrustedTenant");

let server;
beforeAll(async () => {
  server = await fx.startApp();
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  fx.resetState();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const WL = TYPES.WORKLOC._id;
const LOOKUP_READS = ["/api/lookup", `/api/lookup/${fx.id(22)}`, `/api/lookup/${fx.id(22)}/hierarchy`, `/api/lookup/by-type/${WL}/hierarchy`, "/api/lookup/by-type-code/WORKLOC/hierarchy"];
const PLACEHOLDERS = ["default", "unknown", "system", "null", "undefined", "DEFAULT", "a:b"];

test("placeholder / malformed tenant -> 400 TENANT_REQUIRED on every lookup read and product by-code; nothing read", async () => {
  for (const t of PLACEHOLDERS) {
    for (const path of [...LOOKUP_READS, "/api/products/by-type-code/MEM", "/api/products/by-type-code/MEM?productCode=4080"]) {
      const r = await call(server, "GET", path, { tenant: t });
      expect([path, t, r.status]).toEqual([path, t, 400]);
      expect(r.body.error).toEqual({ message: "Tenant context required", code: "TENANT_REQUIRED", status: 400, authError: true, missingTenant: true });
    }
  }
  expect(cacheOps).toEqual([]);
  expect(fx.calls.lookupTypeFindOne).toEqual([]);
  expect(fx.calls.productTypeFindOne).toEqual([]);
});

test("valid tenants still pass the guard on every lookup read", async () => {
  for (const t of [A, B, D]) {
    for (const path of LOOKUP_READS) {
      const r = await call(server, "GET", path, { tenant: t });
      expect([path, t, r.status]).toEqual([path, t, 200]);
    }
  }
});

test("product by-code with a valid tenant is unchanged: own MEM products; no fallback for a tenant without MEM", async () => {
  const a = await call(server, "GET", "/api/products/by-type-code/MEM?productCode=4080", { tenant: A });
  expect(a.status).toBe(200);
  expect(a.body.data.products.map((p) => p.name)).toEqual(["Retired Associate"]);
  const d = await call(server, "GET", "/api/products/by-type-code/MEM", { tenant: D });
  expect(d.status).toBe(404);
  expect(d.body.error.code).toBe("PRODUCT_TYPE_NOT_FOUND");
});

test("the read guard is per read route, not router-level: a write is not answered TENANT_REQUIRED", async () => {
  // Phase A / A14: lookup writes are frozen (423 GLOBAL_DATA_FROZEN) before any tenant check.
  const r = await call(server, "PATCH", "/api/lookups/officer", { tenant: "default", body: { ids: [fx.id(22)], officer: null } });
  expect(r.status).toBe(423);
  expect(r.body.error.code).toBe("GLOBAL_DATA_FROZEN");
});

const guardedGets = (router) =>
  router.stack
    .filter((l) => l.route && l.route.methods.get)
    .map((l) => ({ path: l.route.path, guarded: l.route.stack.some((s) => s.handle === requireTrustedTenant) }));

test("lookuptype and country read routes carry the guard", () => {
  expect(guardedGets(require("../routes/lookuptype.router"))).toEqual([
    { path: "/lookuptype", guarded: true },
    { path: "/lookuptype/:id", guarded: true },
  ]);
  expect(guardedGets(require("../routes/country.routes"))).toEqual([
    { path: "/countries", guarded: true },
    { path: "/countries/search", guarded: true },
    { path: "/countries/code/:code", guarded: true },
    { path: "/countries/:id", guarded: true },
  ]);
});

test("middleware unit: next() only for a trusted tenant", () => {
  const run = (ctx) => {
    let nexted = false, status = null;
    const res = { status: (s) => ((status = s), res), json: () => res };
    requireTrustedTenant({ ctx }, res, () => (nexted = true));
    return { nexted, status };
  };
  expect(run({ tenantId: A })).toEqual({ nexted: true, status: null });
  for (const ctx of [undefined, {}, { tenantId: "" }, { tenantId: " default " }, { tenantId: "x y" }]) {
    expect(run(ctx)).toEqual({ nexted: false, status: 400 });
  }
});
