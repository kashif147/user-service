/**
 * Phase A / A14 - temporary write freeze on still-global lookups and lookup types.
 *
 * REAL lookup / lookuptype routers over HTTP. Controllers and the PDP adapter are recorded, so the test
 * proves a frozen write answers 423 GLOBAL_DATA_FROZEN before the policy check, the controller, the
 * database or any cache invalidation runs - for an SU actor of every DEV tenant (every tenant has SU).
 * Reads are unchanged. Only GLOBAL_DATA_WRITES=open (exact) reopens writes; nothing on the request can.
 */
const mockHits = { controller: [], pdp: [] };
const handler = (name) => (req, res) => {
  mockHits.controller.push(name);
  res.json({ success: true, name });
};

jest.mock("../controllers/lookup.controller.js", () =>
  new Proxy({}, { get: (t, name) => (typeof name === "string" ? handler(`lookup.${name}`) : undefined) })
);
jest.mock("../controllers/lookuptype.ontroller.js", () =>
  new Proxy({}, { get: (t, name) => (typeof name === "string" ? handler(`lookuptype.${name}`) : undefined) })
);
jest.mock("../services/lookupCacheService", () => ({ cacheTenant: (t) => (/^[0-9a-f]{24}$/.test(String(t)) ? String(t) : null) }));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../helpers/policyAdapter.js", () => ({
  defaultPolicyAdapter: {
    middleware: (resource, action) => (req, res, next) => {
      mockHits.pdp.push(`${resource}:${action}`);
      next();
    },
  },
}));
jest.mock("../middlewares/auth", () => require("./helpers/a3Fixtures").authMock());
// Only the real logging-lib createLogger() methods (it has no info/warn).
jest.mock("../config/bizLogger.js", () => ({ business: jest.fn(), error: jest.fn() }));

const express = require("express");
const fx = require("./helpers/a3Fixtures");
const { A, B, D } = fx;
// One connection per request: a DELETE with a body on a kept-alive socket stalls the next request in
// the Node http client (test-harness artefact, not product behaviour).
const call = (server, method, path, opts = {}) =>
  fx.call(server, method, path, { ...opts, headers: { connection: "close", ...(opts.headers || {}) } });
const bizLogger = require("../config/bizLogger.js");
const { isGlobalDataFrozen } = require("../middlewares/globalDataFreeze");

let server;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", require("../routes/lookup.router"));
  app.use("/api", require("../routes/lookuptype.router"));
  server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  mockHits.controller.length = 0;
  mockHits.pdp.length = 0;
  bizLogger.business.mockClear();
  delete process.env.GLOBAL_DATA_WRITES;
});
afterAll(() => delete process.env.GLOBAL_DATA_WRITES);

const WRITES = [
  ["POST", "/api/lookup", "lookup"],
  ["PUT", "/api/lookup", "lookup"],
  ["DELETE", "/api/lookup", "lookup"],
  ["PATCH", "/api/lookups/officer", "lookup"],
  ["POST", "/api/lookuptype", "lookupType"],
  ["PUT", "/api/lookuptype", "lookupType"],
  ["DELETE", "/api/lookuptype", "lookupType"],
];
const FROZEN = (resource) => ({
  message: "Shared metadata is temporarily read-only during tenant migration",
  code: "GLOBAL_DATA_FROZEN",
  status: 423,
  resource,
});

test("every global lookup / lookup-type write -> 423 for SU of every tenant; no PDP, controller or DB work", async () => {
  for (const tenant of [A, B, D]) {
    for (const [method, path, resource] of WRITES) {
      const r = await call(server, method, path, { tenant, body: { id: "x", lookuptypeId: "y", ids: ["z"] } });
      expect([method, path, tenant, r.status]).toEqual([method, path, tenant, 423]);
      expect(r.body.success).toBe(false);
      expect(r.body.error).toEqual(FROZEN(resource));
    }
  }
  expect(mockHits.controller).toEqual([]);
  expect(mockHits.pdp).toEqual([]);
  expect(bizLogger.business).toHaveBeenCalledWith(
    "Global data write refused (frozen)",
    expect.objectContaining({ eventType: "global_data.write_frozen", resource: "lookup", tenantId: A })
  );
});

test("nothing on the request reopens writes: internal-call headers, body flags, platform actor ids", async () => {
  const headers = { "x-internal-request": "true", "x-global-data-writes": "open", "x-actor": "platform:migration" };
  for (const [method, path] of WRITES) {
    const r = await call(server, method, path, {
      tenant: A,
      headers,
      body: { globalDataWrites: "open", bypassFreeze: true, actor: "platform:provisioning" },
    });
    expect(r.status).toBe(423);
  }
  expect(mockHits.controller).toEqual([]);
});

test("reads are unchanged", async () => {
  for (const path of ["/api/lookup", "/api/lookuptype", "/api/lookup/by-type-code/WORKLOC/hierarchy"]) {
    const r = await call(server, "GET", path, { tenant: A });
    expect([path, r.status]).toEqual([path, 200]);
  }
  expect(mockHits.controller).toEqual([
    "lookup.getAllLookup",
    "lookuptype.getAllLookupType",
    "lookup.getLookupsByTypeCodeWithHierarchy",
  ]);
});

test("ops rollback switch: only GLOBAL_DATA_WRITES=open (exact) reopens; anything else stays frozen", async () => {
  for (const v of [undefined, "", "OPEN", "true", "1", "frozen", " open"]) {
    if (v === undefined) delete process.env.GLOBAL_DATA_WRITES;
    else process.env.GLOBAL_DATA_WRITES = v;
    expect([v, isGlobalDataFrozen()]).toEqual([v, true]);
    expect((await call(server, "POST", "/api/lookup", { tenant: A, body: {} })).status).toBe(423);
  }
  process.env.GLOBAL_DATA_WRITES = "open";
  const r = await call(server, "POST", "/api/lookup", { tenant: A, body: {} });
  expect(r.status).toBe(200);
  expect(mockHits.controller).toEqual(["lookup.createNewLookup"]);
  expect(mockHits.pdp).toEqual(["lookup:write"]);
});
