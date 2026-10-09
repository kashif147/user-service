/**
 * Phase 1C-2O — tenantScoped.controller.js no longer calls res.fail().
 *
 * middlewares/response.mw.js does not define res.fail. Every error path that reached it threw a
 * TypeError inside an async Express 4 handler -> unhandled rejection -> on Node 22 the whole
 * user-service process exits. GET /api/tenant/users hit it on EVERY call (RoleHandler.getAllUsers
 * does not exist). These tests prove each formerly broken path now gets a real HTTP response,
 * success/403 paths are unchanged, nothing is mutated on rejection, and 500s stay generic.
 *
 * Mounts the REAL routes/tenantScoped.routes.js + REAL response.mw + REAL requireTenant over HTTP.
 * authenticate is a stub (x-test-* headers -> req.ctx); the policy adapter is a pass-through;
 * models are fixture-backed mocks that evaluate tenant-scoped selectors. No DB.
 */
const http = require("http");
const express = require("express");

const A = "68cbf7806080b4621d469d34";
const B = "aaaaaaaaaaaaaaaaaaaaaaaa";
const ID = {
  su: "a00000000000000000000001",
  ord1: "a00000000000000000000004",
  ord2: "a00000000000000000000005",
  otherTenantOrd: "b00000000000000000000001",
  other: "c00000000000000000000002",
  otherTenantUser: "d00000000000000000000001",
};
const mockState = { fail: null, mutations: 0, roleQueries: [], userQueries: [] };
const mockRoleRows = [
  { _id: ID.su, tenantId: A, code: "SU", isSystemRole: false, isActive: true, permissions: [] },
  { _id: ID.ord1, tenantId: A, code: "BRO", isSystemRole: false, isActive: true, permissions: [] },
  { _id: ID.ord2, tenantId: A, code: "IO", isSystemRole: false, isActive: true, permissions: [] },
  { _id: ID.otherTenantOrd, tenantId: B, code: "BRO", isSystemRole: false, isActive: true, permissions: [] },
];
const mockPerms = [{ _id: "e00000000000000000000001", code: "LOOKUP_READ", resource: "lookup", action: "read", category: "CRM", isActive: true }];
const mockUsers = {};
const mockChain = (fn) => {
  const o = { sort: () => o, lean: () => o, select: () => o, populate: () => o, exec: () => Promise.resolve().then(fn), then: (a, b) => Promise.resolve().then(fn).then(a, b) };
  return o;
};

jest.mock("../models/role.model", () => ({
  find: (q) => mockChain(() => {
    mockState.roleQueries.push(q);
    if (mockState.fail === "roles") throw new Error("mongo down: secret-host:27017");
    return mockRoleRows.filter((r) => (!q._id || q._id.$in.includes(r._id)) && r.tenantId === q.tenantId && (q.isActive === undefined || r.isActive === q.isActive));
  }),
  findOne: async (q) => {
    mockState.roleQueries.push(q);
    const r = mockRoleRows.find((x) => x._id === q._id && x.tenantId === q.tenantId);
    return r ? { ...r, toObject: () => ({ ...r }) } : null;
  },
  findOneAndUpdate: async (q, u) => {
    mockState.roleQueries.push(q);
    if (mockState.fail === "update") throw new Error("mongo down: secret-host:27017");
    const r = mockRoleRows.find((x) => x._id === q._id && x.tenantId === q.tenantId);
    if (!r) return null;
    mockState.mutations++;
    return { ...r, permissions: u.$set.permissions };
  },
}));
jest.mock("../models/user.model", () => ({
  findOne: (q) => {
    mockState.userQueries.push(q);
    const u = mockUsers[q._id] && mockUsers[q._id].tenantId === q.tenantId ? mockUsers[q._id] : null;
    const p = Promise.resolve(u);
    p.populate = () => Promise.resolve(u);
    return p;
  },
}));
jest.mock("../models/permission.model", () => ({
  findById: async () => null,
  findOne: async (q) => mockPerms.find((p) => p.code === q.code && p.isActive) || null,
  find: () => mockChain(() => {
    if (mockState.fail === "perms") throw new Error("mongo down: secret-host:27017");
    return mockPerms;
  }),
}));
jest.mock("../models/tenant.model", () => ({}));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../services/roleHierarchyService", () => ({
  isSuperUser: () => false, isAssistantSuperUser: () => false, isSystemAdmin: () => false,
  getHighestRoleLevel: () => 1, hasMinimumRole: () => false,
}));
jest.mock("../helpers/policyAdapter.js", () => ({ defaultPolicyAdapter: { middleware: () => (req, res, next) => next() } }));
jest.mock("../middlewares/auth", () => {
  const actual = jest.requireActual("../middlewares/auth");
  return {
    ...actual,
    tenantContextWarn: (req, res, next) => next(),
    authenticate: (req, res, next) => {
      const t = req.headers["x-test-tenant"];
      if (t || req.headers["x-test-roles"]) {
        req.ctx = { tenantId: t, userId: "c00000000000000000000009", roles: JSON.parse(req.headers["x-test-roles"] || "[]") };
      }
      next();
    },
  };
});

let server;
let port;
const unhandled = [];
const onUnhandled = (e) => unhandled.push(String((e && e.message) || e));
beforeAll(async () => {
  process.on("unhandledRejection", onUnhandled);
  const app = express();
  app.use(express.json());
  app.use(require("../middlewares/response.mw"));
  app.use("/api", require("../routes/tenantScoped.routes"));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  await new Promise((r) => (server = app.listen(0, r)));
  port = server.address().port;
});
afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
  return new Promise((r) => server.close(r));
});
beforeEach(() => {
  mockState.fail = null;
  mockState.mutations = 0;
  mockState.roleQueries.length = 0;
  mockState.userQueries.length = 0;
  unhandled.length = 0;
  mockUsers[ID.other] = {
    _id: ID.other, tenantId: A, roles: [ID.ord2],
    save: jest.fn(async function () { if (mockState.fail === "save") throw new Error("mongo down: secret-host:27017"); mockState.mutations++; return this; }),
  };
  mockUsers[ID.otherTenantUser] = { _id: ID.otherTenantUser, tenantId: B, roles: [ID.otherTenantOrd], save: jest.fn(async function () { mockState.mutations++; return this; }) };
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20)); // let any late rejection surface
  expect(unhandled).toEqual([]); // no request may leave an unhandled rejection (would kill the process)
  jest.restoreAllMocks();
});

function call(method, path, { body, actorRoles = ["MO"], tenant = A, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { "content-type": "application/json", "x-test-roles": JSON.stringify(actorRoles), ...headers };
    if (tenant) h["x-test-tenant"] = tenant;
    if (data) h["content-length"] = Buffer.byteLength(data);
    const rq = http.request({ port, path, method, headers: h, timeout: 3000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    rq.on("timeout", () => { rq.destroy(); resolve({ status: "NO_RESPONSE" }); });
    if (data) rq.write(data);
    rq.end();
  });
}
const errMsg = (r) => r.body && r.body.error && r.body.error.message;
const noLeak = (r) => expect(JSON.stringify(r.body)).not.toMatch(/secret-host|mongo down/);

describe("POST /api/tenant/users/remove-role (removeRoleFromUserInTenant)", () => {
  const P = "/api/tenant/users/remove-role";
  test("success unchanged: 200, role removed", async () => {
    const r = await call("POST", P, { body: { userId: ID.other, roleId: ID.ord2 } });
    expect(r.status).toBe(200);
    expect(mockUsers[ID.other].roles).toEqual([]);
  });
  test("another tenant's role -> 400 (was a process crash), user untouched", async () => {
    const r = await call("POST", P, { body: { userId: ID.other, roleId: ID.otherTenantOrd } });
    expect(r.status).toBe(400);
    expect(errMsg(r)).toMatch(/Role not found/);
    expect(mockUsers[ID.other].save).not.toHaveBeenCalled();
    expect(mockUsers[ID.other].roles).toEqual([ID.ord2]);
  });
  test("another tenant's user -> 400 User not found, that user untouched", async () => {
    const r = await call("POST", P, { body: { userId: ID.otherTenantUser, roleId: ID.ord2 } });
    expect(r.status).toBe(400);
    expect(errMsg(r)).toBe("User not found");
    expect(mockUsers[ID.otherTenantUser].roles).toEqual([ID.otherTenantOrd]);
    expect(mockState.mutations).toBe(0);
  });
  test("privilege violation still 403 (non-SU removing SU role)", async () => {
    const r = await call("POST", P, { body: { userId: ID.other, roleId: ID.su } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("ROLE_PRIVILEGE_VIOLATION");
    expect(mockState.mutations).toBe(0);
  });
  test("unexpected failure -> generic 500, no internal text", async () => {
    mockState.fail = "save";
    const r = await call("POST", P, { body: { userId: ID.other, roleId: ID.ord2 } });
    expect(r.status).toBe(500);
    expect(errMsg(r)).toBe("Failed to remove role from user");
    noLeak(r);
  });
  test("tenant spoof via body/query/header ignored; missing tenant fails closed", async () => {
    const spoof = await call("POST", `${P}?tenantId=${B}`, { body: { userId: ID.otherTenantUser, roleId: ID.otherTenantOrd, tenantId: B }, headers: { "x-tenant-id": B } });
    expect(spoof.status).toBe(400);
    expect(mockState.roleQueries.concat(mockState.userQueries).every((q) => q.tenantId === A)).toBe(true);
    expect(mockUsers[ID.otherTenantUser].roles).toEqual([ID.otherTenantOrd]);
    const missing = await call("POST", P, { body: { userId: ID.other, roleId: ID.ord2 }, tenant: null });
    expect(missing.status).toBe(400);
    expect(mockState.mutations).toBe(0);
  });
});

describe("PUT /api/tenant/roles/:id/permissions (assignPermissionsToRoleInTenant)", () => {
  const P = (id) => `/api/tenant/roles/${id}/permissions`;
  test("success unchanged: 200, tenant-scoped update", async () => {
    const r = await call("PUT", P(ID.ord1), { body: { permissions: ["LOOKUP_READ"] } });
    expect(r.status).toBe(200);
    expect(r.body.data.permissions).toEqual(["LOOKUP_READ"]);
    expect(mockState.roleQueries.every((q) => q.tenantId === A)).toBe(true);
  });
  test.each([
    ["another tenant's role", ID.otherTenantOrd, { permissions: ["LOOKUP_READ"] }, /Role not found/],
    ["unknown permission code", ID.ord1, { permissions: ["NO_SUCH_PERM"] }, /Permission not found/],
    ["permissions not an array", ID.ord1, { permissions: "LOOKUP_READ" }, /permissions must be an array/],
  ])("%s -> 400 (was a process crash), nothing updated", async (_l, id, body, re) => {
    const r = await call("PUT", P(id), { body });
    expect(r.status).toBe(400);
    expect(errMsg(r)).toMatch(re);
    expect(mockState.mutations).toBe(0);
  });
  test("privilege violation still 403 (non-SU editing SU role)", async () => {
    const r = await call("PUT", P(ID.su), { body: { permissions: ["LOOKUP_READ"] } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("ROLE_PRIVILEGE_VIOLATION");
    expect(mockState.mutations).toBe(0);
  });
  test("unexpected failure -> generic 500, no internal text", async () => {
    mockState.fail = "update";
    const r = await call("PUT", P(ID.ord1), { body: { permissions: ["LOOKUP_READ"] } });
    expect(r.status).toBe(500);
    expect(errMsg(r)).toBe("Failed to update role permissions");
    noLeak(r);
  });
});

describe("tenant reads", () => {
  test("GET /api/tenant/users: RoleHandler.getAllUsers does not exist -> generic 500 instead of a crash", async () => {
    const r = await call("GET", "/api/tenant/users");
    expect(r.status).toBe(500);
    expect(errMsg(r)).toBe("Failed to retrieve users");
    noLeak(r);
  });
  test("GET /api/tenant/roles: success unchanged (tenant-scoped); failure -> generic 500", async () => {
    const ok = await call("GET", "/api/tenant/roles");
    expect(ok.status).toBe(200);
    expect(ok.body.data.map((r) => r._id).sort()).toEqual([ID.ord1, ID.ord2, ID.su].sort());
    mockState.fail = "roles";
    const bad = await call("GET", "/api/tenant/roles");
    expect(bad.status).toBe(500);
    expect(errMsg(bad)).toBe("Failed to retrieve roles");
    noLeak(bad);
  });
  test("GET /api/tenant/permissions: success unchanged; failure -> generic 500", async () => {
    const ok = await call("GET", "/api/tenant/permissions");
    expect(ok.status).toBe(200);
    expect(ok.body.data.map((p) => p.code)).toEqual(["LOOKUP_READ"]);
    mockState.fail = "perms";
    const bad = await call("GET", "/api/tenant/permissions");
    expect(bad.status).toBe(500);
    expect(errMsg(bad)).toBe("Failed to retrieve permissions");
    noLeak(bad);
  });
});

test("controller has no executable res.fail() and route chains are unchanged", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "tenantScoped.controller.js"), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  expect(code).not.toMatch(/res\.fail\(/);
  const router = require("../routes/tenantScoped.routes");
  const routerWide = router.stack.filter((l) => !l.route).map((l) => l.name);
  expect(routerWide).toHaveLength(3); // authenticate, tenantContextWarn (anonymous in prod), requireTenant
  expect([routerWide[0], routerWide[2]]).toEqual(["authenticate", "requireTenant"]);
  expect(router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path} x${l.route.stack.length}`)).toEqual([
    "POST /tenant/users/assign-role x2",
    "POST /tenant/users/remove-role x2",
    "PUT /tenant/roles/:id/permissions x2",
    "GET /tenant/users x2",
    "GET /tenant/roles x2",
    "GET /tenant/permissions x2",
  ]);
});
