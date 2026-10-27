/**
 * Phase A / A10 — stable-code resolution APIs.
 *
 *   GET /api/lookup/by-type-code/:typeCode/hierarchy
 *   GET /api/products/by-type-code/:typeCode[?productCode=CODE]
 *
 * REAL lookup/product routers + controllers + requireTenant over HTTP; models are in-memory fakes
 * (tests/helpers/a3Fixtures.js); authenticate is a stub that sets the trusted tenant from
 * x-test-tenant only; the policy adapter is a pass-through.
 */
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
  defaultPolicyAdapter: {
    middleware: (resource, action) => {
      const fn = (req, res, next) => next();
      Object.defineProperty(fn, "name", { value: `policy:${resource}:${action}` });
      return fn;
    },
  },
}));
jest.mock("../middlewares/auth", () => require("./helpers/a3Fixtures").authMock());
jest.mock("../config/bizLogger.js", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fx = require("./helpers/a3Fixtures");
const { A, B, D, TYPES, call } = fx;

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

const byType = (typeId, qs = "") => `/api/lookup/by-type/${typeId}/hierarchy${qs}`;
const byCode = (code, qs = "") => `/api/lookup/by-type-code/${code}/hierarchy${qs}`;

describe("A10 lookup hierarchy by lookup-type code", () => {
  test("valid type code WORKLOC returns the work locations with their hierarchy", async () => {
    const r = await call(server, "GET", byCode("WORKLOC"), { tenant: A });
    expect(r.status).toBe(200);
    expect(r.body.lookuptype.code).toBe("WORKLOC");
    expect(r.body.totalCount).toBe(2);
    expect(r.body.results.map((x) => x.lookup.lookupname).sort()).toEqual(["Beaumont Hospital", "Mater Hospital"]);
    expect(r.body.results[0].hierarchy.map((h) => h.lookupname)).toEqual(["North East", "Dublin North"]);
  });

  test.each(["001", "WORKLOC"])("response is identical to by-type/:id for %s (default, lean, simple)", async (code) => {
    for (const qs of ["", "?lean=true", "?format=simple"]) {
      const viaId = await call(server, "GET", byType(TYPES[code]._id, qs), { tenant: A });
      const viaCode = await call(server, "GET", byCode(code, qs), { tenant: A });
      expect(viaCode.status).toBe(200);
      expect(viaCode.body).toEqual(viaId.body);
    }
  });

  test("code is trimmed and upper-cased (workloc == WORKLOC)", async () => {
    const lower = await call(server, "GET", byCode("workloc"), { tenant: A });
    const upper = await call(server, "GET", byCode("WORKLOC"), { tenant: A });
    expect(lower.status).toBe(200);
    expect(lower.body).toEqual(upper.body);
  });

  test("unknown type code -> 404 LOOKUP_TYPE_NOT_FOUND (also for a deleted type)", async () => {
    for (const code of ["NOPE", "OLDTYPE"]) {
      const r = await call(server, "GET", byCode(code), { tenant: A });
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("LOOKUP_TYPE_NOT_FOUND");
    }
  });

  test("unknown type code is an expected outcome: app.js 404 envelope, logged at info, not as an error", async () => {
    const bizLogger = require("../config/bizLogger.js");
    bizLogger.info.mockClear();
    bizLogger.error.mockClear();
    const r = await call(server, "GET", byCode("ISSUEDESG"), { tenant: B, headers: { "x-correlation-id": "cid-a3r" } });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({
      success: false,
      error: { message: "Lookup type not found", code: "LOOKUP_TYPE_NOT_FOUND", status: 404 },
      correlationId: "cid-a3r",
    });
    expect(bizLogger.info).toHaveBeenCalledTimes(1);
    expect(bizLogger.info.mock.calls[0][1]).toEqual({
      eventType: "lookup.type_code_not_found",
      typeCode: "ISSUEDESG",
      tenantId: B,
      correlationId: "cid-a3r",
    });
    expect(bizLogger.error).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  test("malformed type code -> 400 INVALID_LOOKUP_TYPE_CODE, no lookup-type query", async () => {
    for (const code of ["AB", "WAYTOOLONGCODE", "WORK%20LOC", "%24where"]) {
      const r = await call(server, "GET", byCode(code), { tenant: A });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("INVALID_LOOKUP_TYPE_CODE");
    }
    expect(fx.calls.lookupTypeFindOne).toEqual([]);
  });

  test("missing tenant fails closed (400) before any lookup query", async () => {
    const r = await call(server, "GET", byCode("WORKLOC"));
    expect(r.status).toBe(400);
    expect(fx.calls.lookupTypeFindOne).toEqual([]);
  });

  test("the same code works for every tenant (lookups are global today)", async () => {
    const a = await call(server, "GET", byCode("WORKLOC"), { tenant: A });
    for (const t of [B, D]) {
      const r = await call(server, "GET", byCode("WORKLOC"), { tenant: t });
      expect(r.status).toBe(200);
      expect(r.body).toEqual(a.body);
    }
  });

  test("caller-supplied tenant (query, body, header) is ignored - no tenant parameter exists", async () => {
    await call(server, "GET", byCode("WORKLOC", `?tenantId=${A}`), {
      tenant: B,
      headers: { "x-tenant-id": A },
    });
    const keys = fx.cacheOps.map(([, k]) => k);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.includes(`:${B}:`))).toBe(true);
    expect(keys.some((k) => k.includes(A))).toBe(false);
  });

  test("portal callers do not see honorary membership categories; CRM callers do", async () => {
    const crm = await call(server, "GET", byCode("MCAT"), { tenant: A });
    const portal = await call(server, "GET", byCode("MCAT"), { tenant: A, userType: "PORTAL" });
    expect(crm.body.results.map((x) => x.lookup.lookupname).sort()).toEqual(["General", "Honorary Member"]);
    expect(portal.body.results.map((x) => x.lookup.lookupname)).toEqual(["General"]);
    expect(portal.body.totalCount).toBe(1);
    // the cached payload stays unfiltered: a CRM call after the portal call still sees both
    const crmAgain = await call(server, "GET", byCode("MCAT"), { tenant: A });
    expect(crmAgain.body.totalCount).toBe(2);
  });

  test("route chain: requireTenant > policy lookup:read > handler; old by-type route unchanged", () => {
    const router = require("../routes/lookup.router");
    const ctl = require("../controllers/lookup.controller");
    const layer = router.stack.find((l) => l.route && l.route.path === "/lookup/by-type-code/:typeCode/hierarchy");
    const names = layer.route.stack.map((x) => Object.keys(ctl).find((k) => ctl[k] === x.handle) || x.handle.name);
    expect(names).toEqual(["requireTenant", "policy:lookup:read", "getLookupsByTypeCodeWithHierarchy"]);
    const old = router.stack.find((l) => l.route && l.route.path === "/lookup/by-type/:lookuptypeId/hierarchy");
    expect(old.route.stack.map((x) => x.handle.name)).toEqual(["policy:lookup:read", "getLookupsByTypeWithHierarchy"]);
  });

  test("the confirmed type codes 001 (Title) resolve; unmapped legacy ids are not invented", async () => {
    const r = await call(server, "GET", byCode("001"), { tenant: A });
    expect(r.status).toBe(200);
    expect(r.body.lookuptype.lookuptype).toBe("Title");
  });
});

describe("A10 products by product-type code", () => {
  const url = (code, qs = "") => `/api/products/by-type-code/${code}${qs}`;

  test("product type MEM returns the tenant's products in the by-type envelope", async () => {
    const r = await call(server, "GET", url("MEM"), { tenant: A });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.productType).toEqual({ _id: fx.PRODUCT_TYPES[0]._id, name: "Membership", code: "MEM", description: "Membership categories" });
    expect(r.body.data.products.map((p) => p.code).sort()).toEqual(["4000", "4080", "4090", "4099"]);
    expect(r.body.data.count).toBe(4);
  });

  test("response is identical to /products/by-type/:id for the same type", async () => {
    const viaId = await call(server, "GET", `/api/products/by-type/${fx.PRODUCT_TYPES[0]._id}`, { tenant: A });
    const viaCode = await call(server, "GET", url("MEM"), { tenant: A });
    expect(viaCode.body).toEqual(viaId.body);
  });

  test("product code 4080 -> Retired Associate; 4090 -> Undergraduate Student", async () => {
    const r1 = await call(server, "GET", url("MEM", "?productCode=4080"), { tenant: A });
    const r2 = await call(server, "GET", url("MEM", "?productCode=4090"), { tenant: A });
    expect(r1.body.data.products.map((p) => [p.code, p.name])).toEqual([["4080", "Retired Associate"]]);
    expect(r2.body.data.products.map((p) => [p.code, p.name])).toEqual([["4090", "Undergraduate Student"]]);
  });

  test("same type code in two tenants: each tenant gets only its own products", async () => {
    const b = await call(server, "GET", url("MEM", "?productCode=4080"), { tenant: B });
    expect(b.status).toBe(200);
    expect(b.body.data.products.map((p) => p.name)).toEqual(["Tenant B Retired"]);
    expect(b.body.data.productType.name).toBe("Membership B");
    expect(b.body.data.products.every((p) => !["Retired Associate"].includes(p.name))).toBe(true);
  });

  test("a tenant without the type gets 404 PRODUCT_TYPE_NOT_FOUND - no fallback to another tenant", async () => {
    const r = await call(server, "GET", url("MEM"), { tenant: D });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("PRODUCT_TYPE_NOT_FOUND");
    expect(fx.calls.productTypeFindOne).toEqual([{ code: "MEM", tenantId: D, isDeleted: false }]);
  });

  test("unknown type code -> 404 PRODUCT_TYPE_NOT_FOUND; unknown product code -> 404 PRODUCT_NOT_FOUND", async () => {
    const t = await call(server, "GET", url("NOPE"), { tenant: A });
    expect([t.status, t.body.error.code]).toEqual([404, "PRODUCT_TYPE_NOT_FOUND"]);
    const p = await call(server, "GET", url("MEM", "?productCode=9999"), { tenant: A });
    expect([p.status, p.body.error.code]).toEqual([404, "PRODUCT_NOT_FOUND"]);
  });

  test("codes are normalised; spaces allowed; malformed codes -> 400", async () => {
    expect((await call(server, "GET", url("mem"), { tenant: A })).status).toBe(200);
    expect((await call(server, "GET", url("CODE%20005"), { tenant: A })).status).toBe(200);
    const bad = await call(server, "GET", url("MEM%7B%7D"), { tenant: A });
    expect([bad.status, bad.body.error.code]).toEqual([400, "INVALID_PRODUCT_TYPE_CODE"]);
    const badP = await call(server, "GET", url("MEM", "?productCode=%24gt"), { tenant: A });
    expect([badP.status, badP.body.error.code]).toEqual([400, "INVALID_PRODUCT_CODE"]);
  });

  test("missing tenant fails closed (400) before any query", async () => {
    const r = await call(server, "GET", url("MEM"));
    expect(r.status).toBe(400);
    expect(fx.calls.productTypeFindOne).toEqual([]);
  });

  test("forged tenant (query/header/body) cannot select another tenant's products", async () => {
    const r = await call(server, "GET", url("MEM", `?tenantId=${A}`), {
      tenant: D,
      headers: { "x-tenant-id": A },
    });
    expect(r.status).toBe(404);
    expect(fx.calls.productTypeFindOne.every((f) => f.tenantId === D)).toBe(true);
  });

  test("portal callers keep the honorary filter", async () => {
    const r = await call(server, "GET", url("MEM"), { tenant: A, userType: "PORTAL" });
    expect(r.body.data.products.map((p) => p.name)).not.toContain("Honorary Member");
    expect(r.body.data.count).toBe(3);
  });

  test("B-11: old /products/by-type/:id answers 400 (not 500) for a malformed id; valid unknown id unchanged", async () => {
    const bad = await call(server, "GET", "/api/products/by-type/not-an-id", { tenant: A });
    expect(bad.status).toBe(400);
    const unknown = await call(server, "GET", `/api/products/by-type/${fx.id(99)}`, { tenant: A });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ data: null, message: "Not found" });
  });

  test("route chain: router-level authenticate > tenantContextWarn > requireTenant; policy product:read", () => {
    const router = require("../routes/product.routes");
    const layer = router.stack.find((l) => l.route && l.route.path === "/products/by-type-code/:typeCode");
    expect(layer.route.stack.map((x) => x.handle.name)).toEqual(["policy:product:read", "getProductsByTypeCode"]);
    const wide = router.stack.filter((l) => !l.route).map((l) => l.name);
    expect(wide).toEqual(["authenticate", "tenantContextWarn", "requireTenant"]);
  });
});
