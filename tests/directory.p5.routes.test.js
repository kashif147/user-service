/**
 * P5 CRM user directory - POST /api/directory/users/lookup and GET /api/directory/users.
 *
 * Mounts the REAL routes/directory.routes.js + requireVerifiedUserToken + the REAL PDP token path
 * (policyEvaluationService.evaluatePolicy: HS256 verification, real applyPolicyRules) +
 * DirectoryController + DirectoryHandler. Only models, the permission catalogue, the role-hierarchy
 * helper and the caches are stubbed. The catalogue stub carries the (separately reviewed)
 * DIRECTORY_READ entry; one test removes it to show what happens before that change lands.
 * Never prints response values - assertions are on key sets, statuses and sentinel absence.
 */
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.REDIS_ENABLED = "false";
process.env.JWT_SECRET = "test-hs256-secret-directory-p5";
process.env.NODE_ENV = "test";
delete process.env.AUTH_BYPASS_ENABLED;

const A = "68cbf7806080b4621d469d34";
const B = "6acd6119b28a863c61361ae0";
const U1 = "111111111111111111111111";
const U2 = "222222222222222222222222";
const U3 = "333333333333333333333333"; // tenant B
const U4 = "444444444444444444444444"; // tenant A, PORTAL
const U5 = "555555555555555555555555"; // tenant A, inactive
const PP = "999999999999999999999999"; // a PlatformPrincipal id (separate collection)
const ROLE_IRO = "aaaaaaaaaaaaaaaaaaaaaaa0";
const PERM_ID = "bbbbbbbbbbbbbbbbbbbbbbb0";

// Every excluded field class carries a unique sentinel so its absence can be asserted without
// printing anything.
const SENSITIVE = {
  userEmail: "SENT_EMAIL@x",
  userMobilePhone: "SENT_MOBILE",
  userMemberNumber: "SENT_MEMBERNO",
  userMicrosoftId: "SENT_MSOID",
  userAuthProvider: "SENT_AUTHPROVIDER",
  userSubject: "SENT_SUBJECT",
  userAudience: "SENT_AUDIENCE",
  userIssuer: "SENT_ISSUER",
  userIssuedAt: 1700000001,
  userAuthTime: 1700000002,
  userTokenVersion: "SENT_TOKENVER",
  userPolicy: "SENT_POLICY",
  userLastLogin: "SENT_LASTLOGIN",
  userLastLogout: "SENT_LASTLOGOUT",
  password: "SENT_PASSWORD",
  tokens: { id_token: "SENT_IDTOKEN", refresh_token: "SENT_REFRESH" },
  permissions: ["SENT_PERMISSION"],
  createdBy: "SENT_CREATEDBY",
  updatedBy: "SENT_UPDATEDBY",
};
const EXCLUDED_KEYS = [
  ...Object.keys(SENSITIVE),
  "_id", "tenantId", "roles", "isActive", "userType", "userFirstName", "userLastName", "userFullName",
  "membershipNumber", "email", "createdAt", "updatedAt",
];
const SENTINEL_RE = /SENT_|1700000001|1700000002|ROLESENT|aaaaaaaaaaaaaaaaaaaaaaa0/;

const mockState = { queries: [], selects: [], sorts: [], limits: [], roleQueries: [], permQueries: [], ppCalls: 0, fail: false };
const mockUsers = [
  { _id: U1, tenantId: A, userType: "CRM", isActive: true, userFirstName: "Jane", userLastName: "Doe", userFullName: "Jane Doe", roles: [ROLE_IRO], ...SENSITIVE },
  { _id: U2, tenantId: A, userType: "CRM", isActive: true, userFirstName: " Bob ", userLastName: "Ray", userFullName: "  ", roles: [], ...SENSITIVE },
  { _id: U3, tenantId: B, userType: "CRM", isActive: true, userFullName: "Other Tenant", roles: [ROLE_IRO], ...SENSITIVE },
  { _id: U4, tenantId: A, userType: "PORTAL", isActive: true, userFullName: "Portal Member", roles: [ROLE_IRO], ...SENSITIVE },
  { _id: U5, tenantId: A, userType: "CRM", isActive: false, userFirstName: null, userLastName: null, userFullName: null, roles: [], ...SENSITIVE },
];

// Minimal in-memory evaluation of the query shapes the directory handler issues.
function mockMatches(u, q) {
  if (q.tenantId !== undefined && u.tenantId !== q.tenantId) return false;
  if (q.isActive !== undefined && u.isActive !== q.isActive) return false;
  if (q.userType !== undefined && u.userType !== q.userType) return false;
  if (q._id && q._id.$in && !q._id.$in.includes(u._id)) return false;
  if (q.roles && q.roles.$in && !(u.roles || []).some((r) => q.roles.$in.map(String).includes(String(r)))) return false;
  if (q.$or) {
    const hit = q.$or.some((clause) => {
      const [field, cond] = Object.entries(clause)[0];
      return typeof u[field] === "string" && new RegExp(cond.$regex, cond.$options).test(u[field]);
    });
    if (!hit) return false;
  }
  return true;
}

jest.mock("../models/user.model", () => ({
  find: (q) => {
    mockState.queries.push(q);
    let lim = Infinity;
    const c = {
      select: (f) => (mockState.selects.push(f), c),
      sort: (s) => (mockState.sorts.push(s), c),
      limit: (n) => (mockState.limits.push(n), (lim = n), c),
      lean: () => Promise.resolve().then(() => {
        if (mockState.fail) throw new Error("DB_INTERNAL_MARKER");
        return mockUsers.filter((u) => mockMatches(u, q)).slice(0, lim).map((u) => ({ ...u }));
      }),
    };
    return c;
  },
  findOne: async () => null,
}));
jest.mock("../models/role.model", () => ({
  find: (q) => {
    mockState.roleQueries.push(q);
    const c = {
      select: () => c,
      lean: async () => {
        const grants = (q.$or || []).some((o) => o.permissions === PERM_ID || o.permissions === "ISSUES_IRO_WRITE");
        return q.tenantId === A && grants ? [{ _id: ROLE_IRO }] : [];
      },
    };
    return c;
  },
  findOne: async () => null,
}));
jest.mock("../models/permission.model", () => ({
  findOne: (q) => {
    mockState.permQueries.push(q);
    return {
      lean: async () =>
        q.resource === "issues-iro" && q.action === "write" ? { _id: PERM_ID, code: "ISSUES_IRO_WRITE", resource: "issues-iro", action: "write" } : null,
    };
  },
  findById: async () => null,
  find: () => ({ select: async () => [] }),
}));
jest.mock("../models/platformPrincipal.model", () => {
  const hit = () => {
    mockState.ppCalls += 1;
    throw new Error("PlatformPrincipal must never be queried by the directory");
  };
  return { find: hit, findOne: hit, findById: hit, countDocuments: hit, aggregate: hit };
});
jest.mock("../models/tenant.model", () => ({}));
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
const DIRECTORY_ENTRY = { code: "DIRECTORY_READ", resource: "directory", action: "read", category: "CRM" };
const mockCatalogue = [
  DIRECTORY_ENTRY,
  { code: "ISSUES_READ", resource: "issues", action: "read", category: "CRM" },
  { code: "USER_READ", resource: "user", action: "read", category: "USER" },
];
jest.mock("../services/permissionsService", () => {
  const actual = jest.requireActual("../services/permissionsService");
  actual.getAllPermissions = async () => mockCatalogue;
  actual.getPermissionsByResource = async (r) => mockCatalogue.filter((p) => p.resource.toLowerCase() === String(r).toLowerCase());
  return actual;
});
// Router-level authenticate modelled as "headers win" (what a forged internal call gets past);
// the directory routes must not rely on it.
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
  jwt.sign({ roles: [{ code: "IRO" }], ...claims }, secret, { algorithm: "HS256", expiresIn });
const CALLER = "aaaaaaaaaaaaaaaaaaaaaaa1";
// tok({ userType: undefined }) omits the claim entirely (a destructuring default would not).
const tok = (opts = {}) => {
  const { tenantId = A, perms = ["directory:read"], userType, ...extra } = opts;
  const type = Object.prototype.hasOwnProperty.call(opts, "userType") ? userType : "CRM";
  return sign({ id: CALLER, sub: CALLER, tenantId, permissions: perms, ...(type === undefined ? {} : { userType: type }), ...extra });
};
const bearer = (t) => ({ authorization: `Bearer ${t}` });

let server;
let port;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.use("/api", require("../routes/directory.routes"));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || err.statusCode || 500).json({ message: err.message }));
  await new Promise((r) => (server = app.listen(0, r)));
  port = server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  Object.assign(mockState, { queries: [], selects: [], sorts: [], limits: [], roleQueries: [], permQueries: [], ppCalls: 0, fail: false });
  if (!mockCatalogue.includes(DIRECTORY_ENTRY)) mockCatalogue.unshift(DIRECTORY_ENTRY);
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const request = (method, path, body, headers = {}) => new Promise((resolve) => {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const rq = http.request({ port, method, path, timeout: 4000,
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers } }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => {
      let parsed = null;
      try { parsed = b ? JSON.parse(b) : null; } catch { parsed = null; }
      resolve({ status: res.statusCode, raw: b, body: parsed });
    });
  });
  rq.on("timeout", () => { rq.destroy(); resolve({ status: "NO_RESPONSE", raw: "" }); });
  rq.end(payload);
});
const lookup = (body, headers) => request("POST", "/api/directory/users/lookup", body, headers);
const list = (qs, headers) => request("GET", `/api/directory/users${qs ? `?${qs}` : ""}`, undefined, headers);
const code = (r) => r.body?.error?.code;

function expectDirectorySchema(r) {
  expect(Array.isArray(r.body?.data)).toBe(true);
  for (const item of r.body.data) {
    expect(Object.keys(item).sort()).toEqual(["displayName", "id"]);
    expect(typeof item.id).toBe("string");
    expect(item.displayName === null || typeof item.displayName === "string").toBe(true);
    for (const k of EXCLUDED_KEYS) expect(Object.prototype.hasOwnProperty.call(item, k)).toBe(false);
  }
  // No excluded value anywhere in the raw body (sentinels; never printed).
  expect(SENTINEL_RE.test(r.raw)).toBe(false);
  expect(/userEmail|Microsoft|userSubject|Issuer|Audience|TokenVersion|userPolicy|Mobile|MemberNumber|membershipNumber|password|roles|permissions|tenantId|isActive/i.test(r.raw)).toBe(false);
}

describe("POST /api/directory/users/lookup", () => {
  test("CRM + directory:read -> 200, own tenant, exactly { id, displayName }, allow-list projection", async () => {
    const r = await lookup({ ids: [U1, U2, U5] }, bearer(tok()));
    expect(r.status).toBe(200);
    expectDirectorySchema(r);
    expect(r.body.data.map((u) => u.id)).toEqual([U1, U2, U5]);
    // fullName wins; blank fullName falls back to trimmed first+last; nothing -> null
    expect(r.body.data.map((u) => u.displayName)).toEqual(["Jane Doe", "Bob Ray", null]);
    expect(mockState.queries).toEqual([{ _id: { $in: [U1, U2, U5] }, tenantId: A }]);
    expect(mockState.selects).toEqual(["_id userFirstName userLastName userFullName"]);
  });

  test("CRM without directory:read -> 403 (forwarded headers claiming it are ignored); no query", async () => {
    for (const perms of [[], ["issues:read"], ["user:read"], ["DIRECTORY:READ:extra"]]) {
      const r = await lookup({ ids: [U1] }, {
        ...bearer(tok({ perms })), "x-user-permissions": JSON.stringify(["directory:read", "*"]), "x-user-type": "CRM",
      });
      expect(r.status).toBe(403);
    }
    expect(mockState.queries).toHaveLength(0);
  });

  test("PORTAL token with forged permission text (directory:read, *, DIRECTORY_READ) -> 403; also with ASU role; no query", async () => {
    for (const extra of [{}, { roles: [{ code: "ASU" }] }]) {
      const r = await lookup({ ids: [U1] }, bearer(tok({ userType: "PORTAL", perms: ["directory:read", "DIRECTORY_READ", "*"], ...extra })));
      expect(r.status).toBe(403);
    }
    expect(mockState.queries).toHaveLength(0);
  });

  test("unknown / missing userType -> 403 even with directory:read or ASU; no query", async () => {
    for (const userType of [undefined, "MEMBER", "crm", "PLATFORM", ""]) {
      for (const extra of [{}, { roles: [{ code: "ASU" }] }]) {
        const r = await lookup({ ids: [U1] }, bearer(tok({ userType, ...extra })));
        expect(r.status).toBe(403);
      }
    }
    expect(mockState.queries).toHaveLength(0);
  });

  test("no / forged / unsigned / expired token, or gateway headers only -> 401; no query", async () => {
    const forged = sign({ id: CALLER, tenantId: A, userType: "CRM", permissions: ["directory:read"] }, { secret: "not-the-secret" });
    const [, p] = tok().split(".");
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${p}.`;
    const expired = sign({ id: CALLER, tenantId: A, userType: "CRM", permissions: ["directory:read"] }, { expiresIn: -120 });
    const gateway = { "x-jwt-verified": "true", "x-auth-source": "gateway", "x-user-id": CALLER, "x-tenant-id": A, "x-user-type": "CRM", "x-user-permissions": JSON.stringify(["directory:read"]) };
    for (const auth of [undefined, "Basic abc", `Bearer ${forged}`, `Bearer ${unsigned}`, `Bearer ${expired}`]) {
      const r = await lookup({ ids: [U1] }, { ...gateway, ...(auth ? { authorization: auth } : {}) });
      expect(r.status).toBe(401);
    }
    expect(mockState.queries).toHaveLength(0);
  });

  test("tenant A caller asking for tenant B ids -> no records (query bound to A)", async () => {
    const r = await lookup({ ids: [U3] }, bearer(tok()));
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
    expect(mockState.queries[0].tenantId).toBe(A);
    const mixed = await lookup({ ids: [U1, U3] }, bearer(tok()));
    expect(mixed.body.data.map((u) => u.id)).toEqual([U1]);
  });

  test("PlatformPrincipal ids -> no records; the PlatformPrincipal collection is never queried", async () => {
    const r = await lookup({ ids: [PP] }, bearer(tok()));
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
    expect(mockState.ppCalls).toBe(0);
    const src = require("fs").readFileSync(require("path").join(__dirname, "../handlers/directory.handler.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(/platformPrincipal/i.test(src)).toBe(false);
    const ctl = require("fs").readFileSync(require("path").join(__dirname, "../controllers/directory.controller.js"), "utf8");
    expect(/platformPrincipal\.model/i.test(ctl)).toBe(false);
  });

  test("forged x-tenant-id: different tenant -> 403 TENANT_CONTEXT_MISMATCH, no query; same-tenant header -> token tenant used", async () => {
    const r = await lookup({ ids: [U3] }, { ...bearer(tok()), "x-tenant-id": B });
    expect([r.status, code(r)]).toEqual([403, "TENANT_CONTEXT_MISMATCH"]);
    expect(mockState.queries).toHaveLength(0);
    const ok = await lookup({ ids: [U1] }, { ...bearer(tok()), "x-tenant-id": A, "x-user-id": "ffffffffffffffffffffffff" });
    expect(ok.status).toBe(200);
    expect(mockState.queries[0].tenantId).toBe(A);
  });

  test("ASU (own-tenant admin) CRM passes without the code; stays own tenant", async () => {
    const r = await lookup({ ids: [U1, U3] }, bearer(tok({ perms: [], roles: [{ code: "ASU" }] })));
    expect(r.status).toBe(200);
    expect(r.body.data.map((u) => u.id)).toEqual([U1]);
  });

  test("catalogue entry absent (before the reviewed catalogue change): non-ASU CRM -> 403, ASU CRM -> 200", async () => {
    mockCatalogue.splice(mockCatalogue.indexOf(DIRECTORY_ENTRY), 1);
    expect((await lookup({ ids: [U1] }, bearer(tok()))).status).toBe(403);
    expect((await lookup({ ids: [U1] }, bearer(tok({ perms: [], roles: [{ code: "ASU" }] })))).status).toBe(200);
  });

  test("validation: non-array -> 400; > 500 -> 400; non-string / non-ObjectId / operator entries ignored", async () => {
    const auth = bearer(tok());
    expect((await lookup({ ids: "x" }, auth)).status).toBe(400);
    expect((await lookup({}, auth)).status).toBe(400);
    expect((await lookup({ ids: Array.from({ length: 501 }, () => U1) }, auth)).status).toBe(400);
    expect((await lookup({ ids: Array.from({ length: 500 }, () => U1) }, auth)).status).toBe(200);
    mockState.queries = [];
    const r = await lookup({ ids: ["nope", { $ne: null }, "", null, 123, [U2], U1] }, auth);
    expect(r.body.data.map((u) => u.id)).toEqual([U1]);
    expect(mockState.queries[0]._id.$in).toEqual([U1]);
    mockState.queries = [];
    const none = await lookup({ ids: ["nope", { $gt: "" }] }, auth);
    expect([none.status, none.body.data, mockState.queries.length]).toEqual([200, [], 0]);
  });

  test("DB failure -> generic 500, no internal text", async () => {
    mockState.fail = true;
    const r = await lookup({ ids: [U1] }, bearer(tok()));
    expect(r.status).toBe(500);
    expect(r.raw).not.toMatch(/DB_INTERNAL_MARKER/);
  });
});

describe("GET /api/directory/users", () => {
  test("CRM + directory:read -> 200, active CRM users of own tenant only, exact schema", async () => {
    const r = await list("", bearer(tok()));
    expect(r.status).toBe(200);
    expectDirectorySchema(r);
    expect(r.body.data.map((u) => u.id).sort()).toEqual([U1, U2]); // not B, not PORTAL, not inactive
    expect(mockState.queries).toEqual([{ tenantId: A, isActive: true, userType: "CRM" }]);
    expect(mockState.selects).toEqual(["_id userFirstName userLastName userFullName"]);
    expect(mockState.limits).toEqual([20]);
    expect(mockState.ppCalls).toBe(0);
  });

  test("CRM without directory:read -> 403; PORTAL forged -> 403; unknown userType -> 403; no query", async () => {
    expect((await list("", bearer(tok({ perms: ["user:read", "issues:read"] })))).status).toBe(403);
    expect((await list("", bearer(tok({ userType: "PORTAL", perms: ["directory:read", "*"] })))).status).toBe(403);
    expect((await list("", bearer(tok({ userType: "PORTAL", perms: ["directory:read"], roles: [{ code: "ASU" }] })))).status).toBe(403);
    expect((await list("", bearer(tok({ userType: undefined })))).status).toBe(403);
    expect((await list("", bearer(tok({ userType: "MEMBER" })))).status).toBe(403);
    expect((await list("", {})).status).toBe(401);
    expect(mockState.queries).toHaveLength(0);
  });

  test("forged x-tenant-id (B) with a tenant-A token -> 403, no query", async () => {
    const r = await list("", { ...bearer(tok()), "x-tenant-id": B });
    expect([r.status, code(r)]).toEqual([403, "TENANT_CONTEXT_MISMATCH"]);
    expect(mockState.queries).toHaveLength(0);
  });

  test("limit: default 20, capped at 50, junk / non-positive -> default, array -> 400", async () => {
    const auth = bearer(tok());
    for (const [qs, want] of [["limit=10", 10], ["limit=50", 50], ["limit=51", 50], ["limit=100000", 50], ["limit=0", 20], ["limit=-5", 20], ["limit=abc", 20]]) {
      mockState.limits = [];
      expect((await list(qs, auth)).status).toBe(200);
      expect(mockState.limits).toEqual([want]);
    }
    expect((await list("limit=1&limit=2", auth)).status).toBe(400);
  });

  test("q: anchored, escaped, case-insensitive prefix on name fields only (never email); regex injection neutralised", async () => {
    const auth = bearer(tok());
    const r = await list("q=jan", auth);
    expect(r.status).toBe(200);
    expect(r.body.data.map((u) => u.id)).toEqual([U1]);
    const or = mockState.queries[0].$or;
    expect(or.map((c) => Object.keys(c)[0]).sort()).toEqual(["userFirstName", "userFullName", "userLastName"]);
    expect(or.every((c) => c[Object.keys(c)[0]].$regex === "^jan" && c[Object.keys(c)[0]].$options === "i")).toBe(true);

    mockState.queries = [];
    const inj = await list(`q=${encodeURIComponent(".*")}`, auth);
    expect(inj.status).toBe(200);
    expect(inj.body.data).toEqual([]);
    expect(mockState.queries[0].$or[0].userFirstName.$regex).toBe("^\\.\\*");

    mockState.queries = [];
    await list(`q=${encodeURIComponent("(a+)+$|[")}`, auth);
    expect(mockState.queries[0].$or[0].userFirstName.$regex).toBe("^\\(a\\+\\)\\+\\$\\|\\[");

    // email is not searchable (no email-prefix oracle)
    mockState.queries = [];
    expect((await list("q=SENT_EMAIL", auth)).body.data).toEqual([]);
  });

  test("q: operator object / array -> 400; over 64 chars -> 400; no query", async () => {
    const auth = bearer(tok());
    expect((await list("q[$ne]=x", auth)).status).toBe(400);
    expect((await list("q=a&q=b", auth)).status).toBe(400);
    expect((await list(`q=${"a".repeat(65)}`, auth)).status).toBe(400);
    expect(mockState.queries).toHaveLength(0);
    expect((await list(`q=${"a".repeat(64)}`, auth)).status).toBe(200);
  });

  test("permission filter: exact resource:action via the tenant's roles; unknown -> []; tenant-bound role lookup", async () => {
    const auth = bearer(tok());
    const r = await list("permission=issues-iro:write", auth);
    expect(r.status).toBe(200);
    expectDirectorySchema(r);
    expect(r.body.data.map((u) => u.id)).toEqual([U1]); // U3 (tenant B) and U4 (PORTAL) also hold the role id
    expect(mockState.permQueries).toEqual([{ resource: "issues-iro", action: "write" }]);
    expect(mockState.roleQueries[0].tenantId).toBe(A);
    expect(mockState.queries[0]).toMatchObject({ tenantId: A, isActive: true, userType: "CRM", roles: { $in: [ROLE_IRO] } });

    mockState.queries = [];
    const unknown = await list("permission=issues-other:write", auth);
    expect([unknown.status, unknown.body.data, mockState.queries.length]).toEqual([200, [], 0]);

    const combined = await list("permission=issues-iro:write&q=bob", auth);
    expect(combined.body.data).toEqual([]);
  });

  test("permission filter: platform namespace, malformed, wildcard and operator values -> 400 without echoing input", async () => {
    const auth = bearer(tok());
    for (const p of ["platform:tenant:admin", "platform:read", "PLATFORM.provisioning:admin", "*", "issues", "a:b:c", "issues-iro:write;drop", "x".repeat(130)]) {
      const r = await list(`permission=${encodeURIComponent(p)}`, auth);
      expect(r.status).toBe(400);
      expect(r.raw.includes(p)).toBe(false);
    }
    expect((await list("permission[$ne]=x", auth)).status).toBe(400);
    expect(mockState.permQueries).toHaveLength(0);
    expect(mockState.queries).toHaveLength(0);
  });

  test("DB failure -> generic 500, no internal text", async () => {
    mockState.fail = true;
    const r = await list("", bearer(tok()));
    expect(r.status).toBe(500);
    expect(r.raw).not.toMatch(/DB_INTERNAL_MARKER/);
  });
});

test("route wiring: both directory routes use the verified-token guard on directory:read, then the CRM-caller guard", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "../routes/directory.routes.js"), "utf8");
  expect(src).toMatch(/"\/directory\/users\/lookup",\s*requireVerifiedUserToken\("directory", "read"\),\s*DirectoryController\.requireVerifiedCrmCaller,\s*DirectoryController\.lookupDirectoryUsers/);
  expect(src).toMatch(/"\/directory\/users",\s*requireVerifiedUserToken\("directory", "read"\),\s*DirectoryController\.requireVerifiedCrmCaller,\s*DirectoryController\.listDirectoryUsers/);
  expect(src).not.toMatch(/defaultPolicyAdapter/);
  const index = require("fs").readFileSync(require("path").join(__dirname, "../routes/index.js"), "utf8");
  expect(index).toMatch(/router\.use\("\/api", require\("\.\/directory\.routes"\)\)/);
});
