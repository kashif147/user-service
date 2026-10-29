/**
 * Phase B / Z5 - the 32 migrated platform routes enforce explicit platform authorization.
 * (Harness shared with tests/platformAuthz.z2.routes.test.js.)
 *
 *   tenant creation              POST /tenants                          platform:tenant:create
 *   cache administration         11 cache.routes (reads + writes)       platform:cache:admin
 *   permission catalogue         4 permission writes (frozen)           platform:permission-catalogue:manage
 *   shared reference data        16 lookup / lookup-type / country /    platform:reference-data:manage
 *                                contact-type / contact writes (frozen)
 * Global PLATFORM_AUTH_MODE stays shadow; these routes enforce regardless (route-enforce); mode off = deny.
 * Legacy SU with "*", ASU, MO and users without roles are denied (403, or the unchanged 423 on a frozen
 * surface while frozen); only a live principal holding the EXACT permission passes; one permission never
 * implies another. Frozen surfaces: authorization first, then the freeze (valid principal -> 423).
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

jest.mock("../rabbitMQ", () => ({ publishDomainEvent: (...a) => (mockPublished.push(a), Promise.resolve(true)) }));
const mockPublished = [];
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
const FROZEN_FILES = ["permission.routes", "lookup.router", "lookuptype.router", "country.routes", "contact.routes", "contactType.routes"];
const codeFor = (f) => (f === "tenant.routes" ? "platform:tenant:create" : f === "cache.routes" ? "platform:cache:admin"
  : f === "permission.routes" ? "platform:permission-catalogue:manage" : "platform:reference-data:manage");
const ALL_CODES = ["platform:tenant:create", "platform:cache:admin", "platform:permission-catalogue:manage", "platform:reference-data:manage"];
let principalState = { status: "active", revision: 2, permissions: [] };

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
        if (first.name !== "platformAuthzGuard") continue; // only the migrated (enforcing) routes here
        routes.push({ file: f, method: m.toUpperCase(), path: `/api${l.route.path.replace(/:(\w+)/g, (_x, p) => (p === "id" ? A : `p-${p}`))}`, code: codeFor(f), frozen: FROZEN_FILES.includes(f) });
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
  principalState = { status: "active", revision: 2, permissions: [] };
  jest.spyOn(PlatformPrincipal, "findById").mockImplementation(() => ({ select: () => ({ lean: async () => ({ _id: PID, issuer: ISSUER, oid: OID, ...principalState }) }) }));
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

const tenantActors = IDENTITIES.slice(0, 4);
const principal = IDENTITIES[4];
const authzEvents = () => mockPublished.filter((p) => p[0] === "platform.authz.decision.v1");

test("the migrated surface: 32 routes, each with its exact platform permission", () => {
  const c = {};
  for (const r of routes) c[r.code] = (c[r.code] || 0) + 1;
  expect(c).toEqual({ "platform:tenant:create": 1, "platform:cache:admin": 11, "platform:permission-catalogue:manage": 4, "platform:reference-data:manage": 16 });
});

test.each(tenantActors.map((i) => [i[0], i]))("%s is denied every migrated platform route; no controller; frozen surfaces keep 423", async (_n, ident) => {
  process.env.PLATFORM_AUTH_MODE = "shadow";
  for (const r of routes) {
    const res = await request(r.method, r.path, headersFor(ident));
    expect({ route: `${r.method} ${r.path}`, status: res.status }).toEqual({ route: `${r.method} ${r.path}`, status: r.frozen ? 423 : 403 });
    expect(res.body).toMatch(r.frozen ? /GLOBAL_DATA_FROZEN/ : /PLATFORM_AUTHORITY_REQUIRED/);
    expect(res.body).not.toMatch(/"handler"/);
  }
  const d = decisions();
  expect(d).toHaveLength(32);
  expect(new Set(d.map((x) => `${x.effective}:${x.reason}:${x.allowed}`))).toEqual(new Set(["enforce:no_plat:false"]));
  expect(PlatformPrincipal.findById).not.toHaveBeenCalled();
});

test("GLOBAL_DATA_WRITES=open never lets a tenant actor through: legacy SU '*' gets 403 on every frozen surface", async () => {
  process.env.PLATFORM_AUTH_MODE = "shadow";
  process.env.GLOBAL_DATA_WRITES = "open";
  for (const r of routes.filter((x) => x.frozen)) {
    const res = await request(r.method, r.path, headersFor(IDENTITIES[0]));
    expect([`${r.method} ${r.path}`, res.status]).toEqual([`${r.method} ${r.path}`, 403]);
  }
});

test.each(ALL_CODES.map((c) => [c]))("least privilege: a principal holding ONLY %s passes exactly its routes", async (held) => {
  process.env.PLATFORM_AUTH_MODE = "shadow";
  principalState.permissions = [held];
  for (const r of routes) {
    const res = await request(r.method, r.path, headersFor(principal));
    let expected;
    if (r.code !== held) expected = 403;          // one platform permission never implies another
    else expected = r.frozen ? 423 : 299;         // frozen: authorized, then the A14 freeze
    expect({ route: `${r.method} ${r.path}`, status: res.status }).toEqual({ route: `${r.method} ${r.path}`, status: expected });
    if (expected === 299) expect(JSON.parse(res.body).platform).toEqual({ pid: PID, permission: held });
  }
});

test("GLOBAL_DATA_WRITES=open only lifts the freeze AFTER authorization: the holder reaches the controller, others do not", async () => {
  process.env.PLATFORM_AUTH_MODE = "shadow";
  process.env.GLOBAL_DATA_WRITES = "open";
  principalState.permissions = ["platform:reference-data:manage"];
  expect((await request("POST", "/api/countries", headersFor(principal))).status).toBe(299);
  expect((await request("POST", "/api/permissions", headersFor(principal))).status).toBe(403);
});

test("stale revision, disabled principal or lost identity binding -> denied; mode off -> every migrated route denied", async () => {
  principalState.permissions = [...ALL_CODES];
  process.env.PLATFORM_AUTH_MODE = "shadow";
  principalState.revision = 3; // token carries rev 2
  expect((await request("POST", "/api/tenants", headersFor(principal))).status).toBe(403);
  principalState.revision = 2;
  principalState.status = "disabled";
  expect((await request("POST", "/api/cache/clear", headersFor(principal))).status).toBe(403);
  principalState.status = "active";
  User.findOne.mockImplementation(() => ({ select: () => ({ lean: async () => ({ _id: USER, tenantId: A, userType: "CRM", userMicrosoftId: "someone-else", userIssuer: ISSUER, isActive: true }) }) }));
  expect((await request("POST", "/api/cache/clear", headersFor(principal))).status).toBe(403);
  expect(decisions().map((x) => x.reason)).toEqual(["stale_rev", "disabled", "binding_lost"]);
  process.env.PLATFORM_AUTH_MODE = "off";
  for (const r of routes) expect((await request(r.method, r.path, headersFor(principal))).status).toBe(403);
});

test("audit: one platform.authz.decision.v1 per enforced decision; platform actor = pid, tenant actor truthfully tenant; no owner tenant", async () => {
  process.env.PLATFORM_AUTH_MODE = "shadow";
  mockPublished.length = 0;
  principalState.permissions = ["platform:cache:admin"];
  await request("POST", "/api/cache/clear", headersFor(principal));        // allowed
  await request("POST", "/api/tenants", headersFor(principal));            // permission_missing
  await request("POST", "/api/lookup", headersFor(IDENTITIES[0]));         // legacy SU, frozen -> 423
  const ev = authzEvents();
  expect(ev.map(([, d]) => [d.allowed, d.reason, d.permission, d.status])).toEqual([
    [true, "allowed", "platform:cache:admin", 200],
    [false, "permission_missing", "platform:tenant:create", 403],
    [false, "no_plat", "platform:reference-data:manage", 423],
  ]);
  expect(ev.map(([, , m]) => m.auditContext)).toEqual([
    { actorScope: "platform", actorTenantId: null, targetTenantId: null, loginTenantId: A },
    { actorScope: "platform", actorTenantId: null, targetTenantId: null, loginTenantId: A },
    { actorScope: "tenant", actorTenantId: A, targetTenantId: null },
  ]);
  for (const [, , m] of ev) expect(m.tenantId).toBeUndefined(); // no envelope tenant: never owned by the sign-in tenant
  expect(JSON.stringify(ev)).not.toMatch(new RegExp(`${OID}|${ISSUER.replace(/[/.]/g, ".")}|eyJ`));
});
