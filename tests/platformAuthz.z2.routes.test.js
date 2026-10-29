/**
 * Phase B / Z2 - shadow observers never change a response.
 * Phase B / Z5: 32 of the 38 observed routes were MIGRATED to enforcing platform authorization (their matrix:
 * tests/platformRoutes.z5.test.js). The 6 still observed (cross-tenant tenant read / delete - Z6) keep the
 * Z2 guarantee: identical status and body with PLATFORM_AUTH_MODE off and shadow.
 * Phase B / Z6: 4 of those 6 (list, by id, stats, delete) plus the tenant update / status / branding /
 * regional-settings / auth-connection routes (20 in all) are now SHARED: a platform registration
 * (platformTenantAdminGuard) precedes the unchanged tenant chain. Tenant actors keep the Z2 guarantee on them
 * (they dispatch to the tenant chain in both modes, no decision logged); platform principals are covered by
 * tests/platformTenantAdmin.z6.test.js. Code / domain lookups stay shadow-observed.
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
// Z5: still shadow-observed (Z6 cross-tenant tenant routes) vs migrated to enforcing platform authorization.
const OBSERVED = { "tenant.routes": 2 };
const Z6_SHARED = 20; // Z6: platform registration + unchanged tenant chain on the same method + path
const ENFORCED = {
  "tenant.routes": 1, "cache.routes": 11, "permission.routes": 4, "lookup.router": 4,
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
        const enforced = first.name === "platformAuthzGuard";
        const z6 = first.name === "platformTenantAdminGuard";
        const r = { file: f, method: m.toUpperCase(), path: `/api${l.route.path.replace(/:(\w+)/g, (_x, p) => (p === "id" ? A : `p-${p}`))}`, observed, enforced, z6 };
        const twin = routes.find((x) => x.method === r.method && x.path === r.path);
        if (twin) twin.z6 = twin.z6 || z6; // the tenant chain of a Z6 shared route: one entry per method + path
        else routes.push(r);
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

test("the surface: 2 routes still shadow-observed, 20 Z6 shared routes, 32 migrated to enforcing platform authorization (Z5)", () => {
  const count = (k) => { const c = {}; for (const r of routes.filter((x) => x[k])) c[r.file] = (c[r.file] || 0) + 1; return c; };
  expect(count("observed")).toEqual(OBSERVED);
  expect(count("enforced")).toEqual(ENFORCED);
  const tenantObserved = routes.filter((r) => r.file === "tenant.routes" && r.observed).map((r) => `${r.method} ${r.path}`).sort();
  expect(tenantObserved).toEqual(["GET /api/tenants/code/p-code", "GET /api/tenants/domain/p-domain"]);
  expect(routes.filter((r) => r.z6)).toHaveLength(Z6_SHARED);
  expect(routes.filter((r) => r.z6 && r.file !== "tenant.routes")).toEqual([]);
  expect(routes.filter((r) => r.file === "tenant.routes" && r.enforced).map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/tenants"]);
});

test.each(IDENTITIES.map((i) => [i[0], i]))("%s: every NOT-migrated route's status and body are identical with mode off and shadow", async (_n, ident) => {
  const h = headersFor(ident);
  // Z6 shared routes: a platform principal is decided by platform authority there (not mode-invariant by design).
  const platformIdentity = ident[0].startsWith("platform principal");
  for (const r of routes.filter((x) => !x.enforced && !(platformIdentity && x.z6))) {
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

test("shadow decisions on the still-observed routes: no_plat for SU '*' / ASU / MO / no roles; never allowed", async () => {
  for (const ident of IDENTITIES.slice(0, 4)) {
    logs.length = 0;
    process.env.PLATFORM_AUTH_MODE = "shadow";
    for (const r of routes.filter((x) => x.observed)) await request(r.method, r.path, headersFor(ident));
    const d = decisions();
    expect(d).toHaveLength(2);
    expect(new Set(d.map((x) => `${x.effective}:${x.reason}:${x.allowed}`))).toEqual(new Set(["shadow:no_plat:false"]));
  }
  expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
});
