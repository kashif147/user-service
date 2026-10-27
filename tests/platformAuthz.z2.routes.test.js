/**
 * Phase B / Z2 - shadow observers on the routes Z5 will migrate never change a response.
 *
 * Mounts the REAL tenant / cache / permission / lookup / lookuptype / country / contact / contactType
 * routers with the REAL requireTenant, requireTenantPathAccess, requireSuperUser, global-data freeze and
 * observers. authenticate (identity from x-test-* headers, standing in for the gateway-verified req.ctx),
 * the policy adapter and the controllers are stubs. The PlatformPrincipal / User reads are in memory.
 *
 * Every route of those routers (observed or not) x every identity is called with PLATFORM_AUTH_MODE
 * off and then shadow: status and body must be identical. Observed routes log exactly one shadow
 * decision; unobserved routes log none. SU with "*" never gets a platform allow.
 */
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");

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
      const t = req.headers["x-test-tenant"];
      if (t) req.ctx = { tenantId: t, userId: req.headers["x-test-user"], roles: JSON.parse(req.headers["x-test-roles"] || "[]"), permissions: JSON.parse(req.headers["x-test-perms"] || "[]") };
      next();
    },
    tenantContextWarn: (req, res, next) => next(),
  };
});
jest.mock("../helpers/policyAdapter.js", () => ({
  defaultPolicyAdapter: { middleware: (resource, action) => (req, res, next) => ((req.ctx?.roles || []).length ? next() : res.status(403).json({ policy: `${resource}:${action}` })) },
}));
jest.mock("../middlewares/requireTrustedTenant", () => ({ requireTrustedTenant: (req, res, next) => (req.ctx?.tenantId ? next() : res.status(401).json({ trusted: false })) }));
jest.mock("../middlewares/upload.mw", () => ({ brandingAssetUploadMw: (req, res, next) => next(), brandingAssetUpload: {}, ALLOWED_IMAGE_TYPES: [] }));
function mockControllerProxy(label) {
  return new Proxy({}, { get: (_t, name) => (req, res) => res.status(299).json({ handler: `${label}.${String(name)}`, platform: req.platform || null }) });
}
jest.mock("../controllers/tenant.controller", () => mockControllerProxy("tenant"));
jest.mock("../controllers/tenantBranding.controller", () => mockControllerProxy("branding"));
jest.mock("../controllers/cache.controller", () => mockControllerProxy("cache"));
jest.mock("../controllers/permission.controller", () => mockControllerProxy("permission"));
jest.mock("../controllers/lookup.controller.js", () => mockControllerProxy("lookup"));
jest.mock("../controllers/lookuptype.ontroller.js", () => mockControllerProxy("lookuptype"));
jest.mock("../controllers/country.controller", () => mockControllerProxy("country"));
jest.mock("../controllers/contact.controller", () => mockControllerProxy("contact"));
jest.mock("../controllers/contactType.controller", () => mockControllerProxy("contactType"));

const PlatformPrincipal = require("../models/platformPrincipal.model");
const User = require("../models/user.model");

const SECRET = "unit-test-only-secret-z2-routes";
const DIR = "39866a06-30bc-4a89-80c6-9dd9357dd453";
const ISSUER = `https://login.microsoftonline.com/${DIR}/v2.0`;
const OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const PID = "6a0000000000000000000a03";
const A = "68cbf7806080b4621d469d34";
const USER = "6a00000000000000000000c1";
const FILES = ["tenant.routes", "cache.routes", "permission.routes", "lookup.router", "lookuptype.router", "country.routes", "contact.routes", "contactType.routes"];
const OBSERVED = {
  "tenant.routes": 7, "cache.routes": 11, "permission.routes": 4, "lookup.router": 4,
  "lookuptype.router": 3, "country.routes": 3, "contact.routes": 3, "contactType.routes": 3,
};

let server;
let base;
let routes = [];
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Routers without their own authenticate rely on an earlier /api router having run it (as in production).
  app.use("/api", require("../middlewares/auth").authenticate);
  for (const f of FILES) {
    const router = require(`../routes/${f}`);
    app.use("/api", router);
    for (const l of router.stack.filter((x) => x.route)) {
      for (const m of Object.keys(l.route.methods)) {
        // router.route(path).get().post()... shares one Route: take the first layer of THIS method.
        const first = l.route.stack.find((x) => x.method === m);
        const observed = first.name === "platformAuthzObserver";
        routes.push({ file: f, method: m.toUpperCase(), path: `/api${l.route.path.replace(/:(\w+)/g, (_x, p) => (p === "id" ? A : `p-${p}`))}`, observed });
      }
    }
  }
  app.use((req, res) => res.status(404).json({ notFound: true }));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

let logs;
beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  delete process.env.GLOBAL_DATA_WRITES; // DEV state: frozen (A14 / A-5)
  logs = [];
  jest.spyOn(PlatformPrincipal, "findById").mockImplementation(() => ({ select: () => ({ lean: async () => ({ _id: PID, issuer: ISSUER, oid: OID, status: "active", revision: 2, permissions: ["platform:tenant:create", "platform:cache:admin"] }) }) }));
  jest.spyOn(User, "findOne").mockImplementation(() => ({ select: () => ({ lean: async () => ({ _id: USER, tenantId: A, userType: "CRM", userMicrosoftId: OID, userIssuer: ISSUER, isActive: true }) }) }));
  jest.spyOn(console, "info").mockImplementation((...a) => logs.push(a.join(" ")));
  for (const m of ["log", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.PLATFORM_AUTH_MODE;
  delete process.env.JWT_SECRET;
});

function request(method, path, headers) {
  return new Promise((resolve, reject) => {
    const payload = method === "GET" ? null : "{}";
    const req = http.request(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(payload ? { "content-length": 2 } : {}), ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const sign = (claims) => jwt.sign({ id: USER, sub: USER, tenantId: A, userType: "CRM", ...claims }, SECRET, { algorithm: "HS256", expiresIn: "10m" });
const IDENTITIES = [
  ["legacy SU with '*'", ["SU"], ["*"], () => sign({ roles: [{ code: "SU" }], permissions: ["*"] })],
  ["ASU", ["ASU"], ["tenant:admin"], () => sign({ roles: [{ code: "ASU" }] })],
  ["MO", ["MO"], ["tenant:read"], () => sign({ roles: [{ code: "MO" }] })],
  ["no roles", [], [], () => sign({})],
  // A valid platform principal WITHOUT tenant SU: shadow must not let it past the legacy guards.
  ["platform principal (not SU)", ["MO"], [], () => sign({ roles: [{ code: "MO" }], plat: { v: 1, pid: PID, rev: 2 } })],
];
const headersFor = ([, roles, perms, tok]) => ({ "x-test-tenant": A, "x-test-user": USER, "x-test-roles": JSON.stringify(roles), "x-test-perms": JSON.stringify(perms), authorization: `Bearer ${tok()}` });
const decisions = () => logs.filter((l) => l.startsWith("[platform-authz]")).map((l) => JSON.parse(l.slice("[platform-authz] ".length)));

test("the observed surface: 38 routes on the 8 routers, exactly as planned", () => {
  const counts = {};
  for (const r of routes.filter((x) => x.observed)) counts[r.file] = (counts[r.file] || 0) + 1;
  expect(counts).toEqual(OBSERVED);
  const tenantObserved = routes.filter((r) => r.file === "tenant.routes" && r.observed).map((r) => `${r.method} ${r.path}`).sort();
  expect(tenantObserved).toEqual([
    `DELETE /api/tenants/${A}`, "GET /api/tenants", `GET /api/tenants/${A}`, `GET /api/tenants/${A}/stats`,
    "GET /api/tenants/code/p-code", "GET /api/tenants/domain/p-domain", "POST /api/tenants",
  ].sort());
});

test.each(IDENTITIES.map((i) => [i[0], i]))("%s: every route's status and body are identical with mode off and shadow", async (_n, ident) => {
  const h = headersFor(ident);
  for (const r of routes) {
    process.env.PLATFORM_AUTH_MODE = "off";
    const before = await request(r.method, r.path, h);
    logs.length = 0;
    process.env.PLATFORM_AUTH_MODE = "shadow";
    const after = await request(r.method, r.path, h);
    expect({ route: `${r.method} ${r.path}`, ...after }).toEqual({ route: `${r.method} ${r.path}`, ...before });
    expect(after.body).not.toMatch(/"platform":\{/); // shadow never hands req.platform to a handler
    expect(decisions().length).toBe(r.observed ? 1 : 0);
  }
});

test("shadow decisions: no_plat for SU '*' / ASU / MO / no roles on every observed route; never allowed", async () => {
  for (const ident of IDENTITIES.slice(0, 4)) {
    logs.length = 0;
    process.env.PLATFORM_AUTH_MODE = "shadow";
    for (const r of routes.filter((x) => x.observed)) await request(r.method, r.path, headersFor(ident));
    const d = decisions();
    expect(d).toHaveLength(38);
    expect(new Set(d.map((x) => `${x.effective}:${x.reason}:${x.allowed}`))).toEqual(new Set(["shadow:no_plat:false"]));
  }
  expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
});

test("frozen writes stay 423 and SU-only guards stay 403 for a non-SU platform principal (shadow grants nothing)", async () => {
  process.env.PLATFORM_AUTH_MODE = "shadow";
  const h = headersFor(IDENTITIES[4]);
  expect((await request("POST", "/api/permissions", h)).status).toBe(423);
  expect((await request("POST", "/api/lookup", h)).status).toBe(423);
  expect((await request("POST", "/api/countries", h)).status).toBe(423);
  expect((await request("POST", "/api/tenants", h)).status).toBe(403); // requireSuperUser
  expect((await request("POST", "/api/cache/clear", h)).status).toBe(403);
  const d = decisions();
  // The principal holds platform:tenant:create and platform:cache:admin: the observer records "allowed",
  // the legacy guard still decides.
  expect(d.filter((x) => x.allowed).map((x) => x.permission).sort()).toEqual(["platform:cache:admin", "platform:tenant:create"]);
  expect(d.filter((x) => !x.allowed).map((x) => x.reason)).toEqual(["permission_missing", "permission_missing", "permission_missing"]);
});
