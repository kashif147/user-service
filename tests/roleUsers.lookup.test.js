/**
 * POST /api/users/lookup - id -> display name for users referenced by issue records.
 *
 * Mounts the REAL routes/role.routes.js + requireVerifiedUserToken + the REAL PDP token path
 * (policyEvaluationService.evaluatePolicy: HS256 verification with JWT_SECRET, real
 * applyPolicyRules) + RoleController + RoleHandler. Only models, the permission catalogue,
 * the role-hierarchy helper and the caches are stubbed. Proves:
 *  A  forged gateway headers (x-jwt-verified / x-user-id / x-tenant-id / x-user-permissions)
 *     without a verified user token get nothing (401), no DB query
 *  B  a forwarded x-tenant-id that differs from the verified token tenant -> 403, no query
 *  C  a verified token with issues:read (what issue-service forwards) succeeds: own tenant only
 *  D  that verified caller cannot resolve another tenant's user (mixed list -> own tenant only)
 *  E  missing / forged / unsigned / expired token -> 401, no query
 *  plus: no issues:read -> 403 (headers claiming it are ignored); ASU stays own-tenant;
 *  response is { _id, fullName } only (no email); caps / invalid ids / DB failure unchanged.
 */
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.REDIS_ENABLED = "false";
process.env.JWT_SECRET = "test-hs256-secret-users-lookup";
process.env.NODE_ENV = "test";
delete process.env.AUTH_BYPASS_ENABLED;

const A = "68cbf7806080b4621d469d34";
const B = "6acd6119b28a863c61361ae0";
const U1 = "111111111111111111111111";
const U2 = "222222222222222222222222";
const U3 = "333333333333333333333333";
const mockState = { queries: [], selects: [], fail: false };
const mockUsers = [
  { _id: U1, tenantId: A, userEmail: "jane@x", userFirstName: "Jane", userLastName: "Doe", userFullName: "Jane Doe", userMicrosoftId: "ms-1", roles: ["r1"], password: "HASH" },
  { _id: U2, tenantId: A, userEmail: "bob@x", userFirstName: "Bob", userLastName: "Ray", userFullName: null, roles: [] },
  { _id: U3, tenantId: B, userEmail: "other@x", userFullName: "Other Tenant", roles: [] },
];

jest.mock("../models/user.model", () => ({
  find: (q) => {
    mockState.queries.push(q);
    const c = {
      select: (f) => (mockState.selects.push(f), c),
      lean: () => Promise.resolve().then(() => {
        if (mockState.fail) throw new Error("DB_INTERNAL_MARKER");
        const ids = (q._id && q._id.$in) || [];
        return mockUsers.filter((u) => u.tenantId === q.tenantId && ids.includes(u._id));
      }),
    };
    return c;
  },
  findOne: async () => null,
}));
jest.mock("../models/tenant.model", () => ({}));
jest.mock("../models/role.model", () => ({ find: async () => [], findOne: async () => null }));
jest.mock("../models/permission.model", () => ({ findById: async () => null, findOne: async () => null, find: () => ({ select: async () => [] }) }));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../services/roleHierarchyService", () => ({
  isTenantAdmin: (roles) => Array.isArray(roles) && roles.some((r) => (typeof r === "string" ? r : r?.code) === "ASU"),
  isAssistantSuperUser: () => false, isSystemAdmin: () => false,
  getHighestRoleLevel: async () => 1, hasMinimumRole: () => false,
}));
jest.mock("../services/cacheService", () => ({ get: async () => null, set: async () => {}, del: async () => {}, delete: async () => {} }));
jest.mock("../services/policyCache", () =>
  function () {
    return { initialize: async () => {}, get: async () => null, set: async () => {}, getStats: async () => ({}), generateKey: () => null };
  }
);
const mockCatalogue = [
  { code: "ISSUES_READ", resource: "issues", action: "read", category: "CRM" },
  { code: "ROLE_READ", resource: "role", action: "read", category: "CRM" },
];
jest.mock("../services/permissionsService", () => {
  const actual = jest.requireActual("../services/permissionsService");
  actual.getAllPermissions = async () => mockCatalogue;
  actual.getPermissionsByResource = async (r) => mockCatalogue.filter((p) => p.resource.toLowerCase() === String(r).toLowerCase());
  return actual;
});
jest.mock("../helpers/policyAdapter.js", () => ({
  defaultPolicyAdapter: { middleware: () => (req, res, next) => next() },
}));
// The router-level authenticate is the existing header-trusting one: model it as "headers win"
// (what a forged internal call gets past) - the lookup route must not rely on it.
jest.mock("../middlewares/auth", () => {
  const actual = jest.requireActual("../middlewares/auth");
  return {
    ...actual,
    tenantContextWarn: (req, res, next) => next(),
    authenticate: function authenticate(req, res, next) {
      req.ctx = {
        tenantId: req.headers["x-tenant-id"] || "from-bearer",
        userId: req.headers["x-user-id"] || "from-bearer",
        permissions: JSON.parse(req.headers["x-user-permissions"] || "[]"),
      };
      next();
    },
  };
});

const responseMiddleware = require("../middlewares/response.mw");
const sign = (claims, { secret = process.env.JWT_SECRET, expiresIn = 300 } = {}) =>
  jwt.sign({ userType: "CRM", roles: [{ code: "IRO" }], ...claims }, secret, { algorithm: "HS256", expiresIn });
const tokenA = (perms = ["issues:read"], extra = {}) => sign({ id: "aaaaaaaaaaaaaaaaaaaaaaa1", sub: "aaaaaaaaaaaaaaaaaaaaaaa1", tenantId: A, permissions: perms, ...extra });

let server;
let port;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.use("/api", require("../routes/role.routes"));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || err.statusCode || 500).json({ message: err.message }));
  await new Promise((r) => (server = app.listen(0, r)));
  port = server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  mockState.queries = []; mockState.selects = []; mockState.fail = false;
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const GATEWAY = (tenant = A, perms = ["issues:read"]) => ({
  "x-jwt-verified": "true", "x-auth-source": "gateway", "x-user-id": "aaaaaaaaaaaaaaaaaaaaaaa1",
  "x-tenant-id": tenant, "x-user-type": "CRM", "x-user-roles": "[]", "x-user-permissions": JSON.stringify(perms),
});
const post = (body, headers = {}) => new Promise((resolve) => {
  const payload = JSON.stringify(body);
  const rq = http.request({ port, method: "POST", path: "/api/users/lookup", timeout: 4000,
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers } }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => resolve({ status: res.statusCode, raw: b, body: b ? JSON.parse(b) : null }));
  });
  rq.on("timeout", () => { rq.destroy(); resolve({ status: "NO_RESPONSE", raw: "" }); });
  rq.end(payload);
});
const code = (r) => r.body?.error?.code;

test("A: forged gateway headers (incl. x-user-permissions issues:read and '*') without a verified token -> 401, no query", async () => {
  for (const perms of [["issues:read"], ["*"], ["issues:read", "user:read"]]) {
    const r = await post({ ids: [U1] }, GATEWAY(A, perms));
    expect([r.status, code(r)]).toEqual([401, "VERIFIED_TOKEN_REQUIRED"]);
  }
  expect(mockState.queries).toHaveLength(0);
});

test("E: missing, malformed, forged (wrong secret), unsigned (alg none) and expired tokens -> 401, no query", async () => {
  const forged = sign({ id: "x", tenantId: A, permissions: ["issues:read"] }, { secret: "not-the-secret" });
  const [h, p] = tokenA().split(".");
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${p}.`;
  // beyond the PDP's 30 s clock-skew tolerance (validateToken clockTolerance: 30)
  const expired = sign({ id: "x", tenantId: A, permissions: ["issues:read"] }, { expiresIn: -120 });
  for (const auth of [undefined, "Basic abc", "Bearer", `Bearer ${forged}`, `Bearer ${unsigned}`, `Bearer ${expired}`, `Bearer ${h}.${p}.tampered`]) {
    const r = await post({ ids: [U1] }, { ...GATEWAY(A), ...(auth ? { authorization: auth } : {}) });
    expect(r.status).toBe(401);
  }
  expect(mockState.queries).toHaveLength(0);
});

test("C: verified token with issues:read (what issue-service forwards) -> 200, own tenant, { _id, fullName } only", async () => {
  const r = await post({ ids: [U1, U2] }, { ...GATEWAY(A), authorization: `Bearer ${tokenA()}` });
  expect(r.status).toBe(200);
  expect(r.body.data).toEqual([
    { _id: U1, fullName: "Jane Doe" },
    { _id: U2, fullName: "Bob Ray" },
  ]);
  expect(mockState.queries).toEqual([{ _id: { $in: [U1, U2] }, tenantId: A }]);
  expect(mockState.selects).toEqual(["_id userFirstName userLastName userFullName"]);
  expect(r.raw).not.toMatch(/@x|userEmail|email|password|HASH|roles|ms-1|tenantId/);
});

test("C': a verified token alone (no gateway headers) is enough; the tenant comes from the token", async () => {
  const r = await post({ ids: [U1] }, { authorization: `Bearer ${tokenA()}` });
  expect(r.status).toBe(200);
  expect(mockState.queries[0].tenantId).toBe(A);
});

test("B: spoofed x-tenant-id (B) with a tenant-A token -> 403 TENANT_CONTEXT_MISMATCH, no query", async () => {
  const r = await post({ ids: [U3] }, { ...GATEWAY(B), authorization: `Bearer ${tokenA()}` });
  expect([r.status, code(r)]).toEqual([403, "TENANT_CONTEXT_MISMATCH"]);
  expect(mockState.queries).toHaveLength(0);
});

test("D: mixed-tenant id list -> only the verified tenant's users; another tenant's user never resolves", async () => {
  const r = await post({ ids: [U1, U3] }, { ...GATEWAY(A), authorization: `Bearer ${tokenA()}` });
  expect(r.status).toBe(200);
  expect(r.body.data.map((u) => u._id)).toEqual([U1]);
  expect(mockState.queries[0].tenantId).toBe(A);
});

test("no issues:read in the verified token -> 403 even when the forwarded headers claim it; no query", async () => {
  const r = await post({ ids: [U1] }, { ...GATEWAY(A, ["issues:read", "*"]), authorization: `Bearer ${tokenA(["role:read"])}` });
  expect(r.status).toBe(403);
  expect(mockState.queries).toHaveLength(0);
});

test("ASU: own-tenant admin may look up own tenant; cannot reach another tenant (token tenant only; spoofed header refused)", async () => {
  const asu = tokenA([], { roles: [{ code: "ASU" }] });
  const own = await post({ ids: [U1, U3] }, { authorization: `Bearer ${asu}` });
  expect(own.status).toBe(200);
  expect(own.body.data.map((u) => u._id)).toEqual([U1]);
  const cross = await post({ ids: [U3] }, { ...GATEWAY(B), authorization: `Bearer ${asu}` });
  expect([cross.status, code(cross)]).toEqual([403, "TENANT_CONTEXT_MISMATCH"]);
});

test("invalid / non-ObjectId ids dropped; none valid -> empty without querying; caps and validation unchanged", async () => {
  const auth = { authorization: `Bearer ${tokenA()}` };
  const r = await post({ ids: ["nope", { $ne: null }, "", null, U1] }, auth);
  expect(r.body.data.map((u) => u._id)).toEqual([U1]);
  mockState.queries = [];
  const none = await post({ ids: ["nope", { $gt: "" }] }, auth);
  expect([none.status, none.body.data, mockState.queries.length]).toEqual([200, [], 0]);
  expect((await post({ ids: "x" }, auth)).status).toBe(400);
  expect((await post({ ids: Array.from({ length: 501 }, () => U1) }, auth)).status).toBe(400);
});

test("DB failure -> generic 500, no internal text", async () => {
  mockState.fail = true;
  const r = await post({ ids: [U1] }, { authorization: `Bearer ${tokenA()}` });
  expect(r.status).toBe(500);
  expect(r.raw).not.toMatch(/DB_INTERNAL_MARKER/);
});

test("route wiring: POST /users/lookup uses the verified-token guard (not the header-trusting policy adapter)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "../routes/role.routes.js"), "utf8");
  expect(src).toMatch(/"\/users\/lookup",\s*requireVerifiedUserToken\("issues", "read"\),\s*RoleController\.lookupUserDisplayNames/);
});
