/**
 * Phase A / A-5 review - the remaining shared (no tenantId) data is write-frozen like A14:
 *  - countries and contact types (tenant-owned in the target design, still global until Phase E),
 *  - contacts (business data with no tenantId yet),
 *  - the platform permission catalogue (requireSuperUser accepts the SU of ANY tenant).
 * REAL routers over HTTP; controllers and the PDP adapter are recorded, so the test proves every write
 * answers 423 GLOBAL_DATA_FROZEN before requireSuperUser, the policy check, the controller or the database,
 * for an SU of every DEV tenant. Reads are unchanged.
 */
// Phase B / Z5: shared-data writes are platform-authorized first (real guard + evaluator), then frozen.
// DEV runs PLATFORM_AUTH_MODE=shadow globally; the migrated routes enforce regardless (route-enforce).
process.env.PLATFORM_AUTH_MODE = "shadow";
jest.mock("../rabbitMQ", () => ({ publishDomainEvent: async () => true }));
const mockHits = { controller: [], pdp: [] };
const recorder = (prefix) =>
  new Proxy({}, {
    get: (t, name) =>
      typeof name === "string"
        ? (req, res) => {
            mockHits.controller.push(`${prefix}.${name}`);
            res.json({ success: true });
          }
        : undefined,
  });

jest.mock("../controllers/country.controller", () => recorder("country"));
jest.mock("../controllers/contact.controller", () => recorder("contact"));
jest.mock("../controllers/contactType.controller", () => recorder("contactType"));
jest.mock("../controllers/permission.controller", () => recorder("permission"));
jest.mock("../controllers/lookup.controller.js", () => recorder("lookup"));
jest.mock("../services/lookupCacheService", () => ({ cacheTenant: (t) => (/^[0-9a-f]{24}$/.test(String(t)) ? String(t) : null) }));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../helpers/policyAdapter", () => ({
  defaultPolicyAdapter: {
    middleware: (resource, action) => (req, res, next) => {
      mockHits.pdp.push(`${resource}:${action}`);
      next();
    },
  },
}));
// (one mock covers both the "policyAdapter" and "policyAdapter.js" specifiers - same module path)
jest.mock("../middlewares/auth", () => require("./helpers/a3Fixtures").authMock());
// Only the real logging-lib createLogger() methods (it has no info/warn).
jest.mock("../config/bizLogger.js", () => ({ business: jest.fn(), error: jest.fn() }));

const express = require("express");
const fx = require("./helpers/a3Fixtures");
const { A, B, D } = fx;
// One connection per request (a DELETE with a body on a kept-alive socket stalls the next request in
// the Node http client - test-harness artefact).
const call = (server, method, path, opts = {}) =>
  fx.call(server, method, path, { ...opts, headers: { connection: "close", ...(opts.headers || {}) } });

let server;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // lookup.router first: it carries router-level authenticate for /api (same mount order as routes/index.js)
  app.use("/api", require("../routes/lookup.router"));
  app.use("/api", require("../routes/permission.routes"));
  app.use("/api", require("../routes/country.routes"));
  app.use("/api", require("../routes/contact.routes"));
  app.use("/api", require("../routes/contactType.routes"));
  server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  mockHits.controller.length = 0;
  mockHits.pdp.length = 0;
  delete process.env.GLOBAL_DATA_WRITES;
});

const ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const WRITES = [
  ["POST", "/api/countries", "country"],
  ["PUT", `/api/countries/${ID}`, "country"],
  ["DELETE", `/api/countries/${ID}`, "country"],
  ["POST", "/api/contact-types", "contactType"],
  ["PUT", `/api/contact-types/${ID}`, "contactType"],
  ["DELETE", `/api/contact-types/${ID}`, "contactType"],
  ["POST", "/api/contacts", "contact"],
  ["PUT", `/api/contacts/${ID}`, "contact"],
  ["DELETE", `/api/contacts/${ID}`, "contact"],
  ["POST", "/api/permissions", "permission"],
  ["PUT", `/api/permissions/${ID}`, "permission"],
  ["DELETE", `/api/permissions/${ID}`, "permission"],
  ["POST", "/api/permissions/initialize", "permission"],
];

test("every country / contact-type / contact / permission-catalogue write -> 423 for SU of every tenant; nothing reached", async () => {
  for (const tenant of [A, B, D]) {
    for (const [method, path, resource] of WRITES) {
      const r = await call(server, method, path, { tenant, body: { name: "x", code: "X" } });
      expect([method, path, tenant, r.status]).toEqual([method, path, tenant, 423]);
      expect(r.body.error).toEqual({
        message: "Shared metadata is temporarily read-only during tenant migration",
        code: "GLOBAL_DATA_FROZEN",
        status: 423,
        resource,
      });
    }
  }
  expect(mockHits.controller).toEqual([]);
  expect(mockHits.pdp).toEqual([]);
});

test("reads are unchanged", async () => {
  for (const path of ["/api/countries", `/api/countries/${ID}`, "/api/contact-types", `/api/contact-types/${ID}`, "/api/contacts", `/api/contacts/${ID}`, "/api/permissions"]) {
    const r = await call(server, "GET", path, { tenant: A });
    expect([path, r.status]).toEqual([path, 200]);
  }
  expect(mockHits.controller.length).toBe(7);
});

test("only GLOBAL_DATA_WRITES=open (exact) reopens - and only AFTER platform authorization (Z5)", async () => {
  const actor = require("./helpers/platformActor");
  process.env.GLOBAL_DATA_WRITES = "OPEN";
  expect((await call(server, "POST", "/api/permissions", { tenant: A, body: {} })).status).toBe(423);
  process.env.GLOBAL_DATA_WRITES = "open";
  // a tenant actor (legacy SU "*") is not let through by the switch
  const su = await call(server, "POST", "/api/countries", { tenant: A, body: {} });
  expect([su.status, su.body.error.code]).toEqual([403, "PLATFORM_AUTHORITY_REQUIRED"]);
  // a platform principal with the exact permission reaches the controller (no tenant PDP)
  actor.installPrincipal({ permissions: ["platform:reference-data:manage"], userId: fx.FIXTURE_USER, tenantId: A });
  expect((await call(server, "POST", "/api/countries", { tenant: A, plat: actor.platClaim(), body: {} })).status).toBe(200);
  // ...but not the catalogue, which needs a different platform permission
  expect((await call(server, "POST", "/api/permissions", { tenant: A, plat: actor.platClaim(), body: {} })).status).toBe(403);
  expect(mockHits.controller).toEqual(["country.createCountry"]);
  expect(mockHits.pdp).toEqual([]);
  jest.restoreAllMocks();
});
