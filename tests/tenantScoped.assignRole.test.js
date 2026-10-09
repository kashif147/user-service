/**
 * Phase 1C-2N — POST /api/tenant/users/assign-role restored.
 *
 * Before: the controller called RoleHandler.assignRoleToUser (never existed) and its catch called
 * res.fail() (not defined by middlewares/response.mw.js), so every non-403 request got NO RESPONSE.
 * After: it delegates to the hardened RoleHandler.assignRolesToUser(userId, [roleId], tenantId, actor)
 * and maps errors like RoleController.assignRolesToUser (400 / 403 / 500).
 *
 * Mounts the REAL routes/tenantScoped.routes.js with the REAL response.mw and REAL requireTenant over
 * HTTP. authenticate is a stub (x-test-* headers -> req.ctx); the policy adapter is a pass-through;
 * models are fixture-backed mocks that evaluate tenant-scoped selectors. No DB.
 */
const http = require("http");
const express = require("express");

const A = "68cbf7806080b4621d469d34";
const B = "aaaaaaaaaaaaaaaaaaaaaaaa";
const ID = {
  su: "a00000000000000000000001",
  asu: "a00000000000000000000002",
  sys: "a00000000000000000000003",
  ord1: "a00000000000000000000004",
  ord2: "a00000000000000000000005",
  inactive: "a00000000000000000000006",
  otherTenantOrd: "b00000000000000000000001",
  actor: "c00000000000000000000001",
  other: "c00000000000000000000002",
  otherTenantUser: "d00000000000000000000001",
};
const mockRoleRows = [
  { _id: ID.su, tenantId: A, code: "SU", isSystemRole: false, isActive: true, permissions: [] },
  { _id: ID.asu, tenantId: A, code: " asu ", isSystemRole: false, isActive: true, permissions: [] },
  { _id: ID.sys, tenantId: A, code: "GS", isSystemRole: true, isActive: true, permissions: [] },
  { _id: ID.ord1, tenantId: A, code: "BRO", isSystemRole: false, isActive: true, permissions: [] },
  { _id: ID.ord2, tenantId: A, code: "IO", isSystemRole: false, isActive: true, permissions: [] },
  { _id: ID.inactive, tenantId: A, code: "OLD", isSystemRole: false, isActive: false, permissions: [] },
  { _id: ID.otherTenantOrd, tenantId: B, code: "BRO", isSystemRole: false, isActive: true, permissions: [] },
];
const mockUsers = {};
const mockUserQueries = [];
const mockRoleQueries = [];

jest.mock("../models/role.model", () => ({
  find: async (q) => {
    mockRoleQueries.push(q);
    return mockRoleRows.filter(
      (r) => q._id.$in.includes(r._id) && r.tenantId === q.tenantId && (q.isActive === undefined || r.isActive === q.isActive)
    );
  },
  findOne: async (q) => {
    mockRoleQueries.push(q);
    const r = mockRoleRows.find((x) => x._id === q._id && x.tenantId === q.tenantId);
    return r ? { ...r, toObject: () => ({ ...r }) } : null;
  },
}));
jest.mock("../models/user.model", () => ({
  findOne: (q) => {
    mockUserQueries.push(q);
    const u = mockUsers[q._id] && mockUsers[q._id].tenantId === q.tenantId ? mockUsers[q._id] : null;
    const p = Promise.resolve(u);
    p.populate = () => Promise.resolve(u);
    return p;
  },
}));
jest.mock("../models/permission.model", () => ({ findById: async () => null, findOne: async () => null, find: () => ({ select: async () => [] }) }));
jest.mock("../models/tenant.model", () => ({}));
jest.mock("../handlers/permission.handler", () => ({ getPermissionByCode: async () => ({}) }));
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
        req.ctx = { tenantId: t, userId: "c00000000000000000000001", roles: JSON.parse(req.headers["x-test-roles"] || "[]") };
      }
      next();
    },
  };
});

const RoleController = require("../controllers/role.controller");

let server;
let port;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(require("../middlewares/response.mw"));
  app.use("/api", require("../routes/tenantScoped.routes"));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  await new Promise((r) => (server = app.listen(0, r)));
  port = server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));

const resetUsers = () => {
  for (const id of [ID.actor, ID.other]) {
    mockUsers[id] = { _id: id, tenantId: A, roles: [ID.ord2], save: jest.fn(async function () { return this; }) };
  }
  mockUsers[ID.otherTenantUser] = { _id: ID.otherTenantUser, tenantId: B, roles: [], save: jest.fn(async function () { return this; }) };
};
beforeEach(() => {
  resetUsers();
  mockUserQueries.length = 0;
  mockRoleQueries.length = 0;
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const roles = (id) => mockUsers[id].roles.map(String);
const untouched = (id, expected) => {
  expect(mockUsers[id].save).not.toHaveBeenCalled();
  expect(roles(id)).toEqual(expected);
};

function post(body, { actorRoles = ["MO"], tenant = A, headers = {}, query = "" } = {}) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const h = { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-test-roles": JSON.stringify(actorRoles), ...headers };
    if (tenant) h["x-test-tenant"] = tenant;
    const rq = http.request({ port, path: `/api/tenant/users/assign-role${query}`, method: "POST", headers: h, timeout: 3000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    rq.on("timeout", () => { rq.destroy(); resolve({ status: "NO_RESPONSE" }); });
    rq.end(data);
  });
}

test("1 valid same-tenant ordinary role assignment succeeds (200, role added once, tenant-scoped lookups)", async () => {
  const res = await post({ userId: ID.other, roleId: ID.ord1 });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("success");
  expect(res.body.data.roles.map(String)).toEqual([ID.ord2, ID.ord1]);
  expect(mockUsers[ID.other].save).toHaveBeenCalledTimes(1);
  expect(mockUserQueries.every((q) => q.tenantId === A)).toBe(true);
  expect(mockRoleQueries.every((q) => q.tenantId === A)).toBe(true);
});

test("2 missing trusted tenant fails closed (400 from requireTenant, nothing touched)", async () => {
  const res = await post({ userId: ID.other, roleId: ID.ord1 }, { tenant: null });
  expect(res.status).toBe(400);
  expect(mockUserQueries).toHaveLength(0);
  untouched(ID.other, [ID.ord2]);
});

test("3 target user from another tenant is rejected (400 User not found, other tenant's user untouched)", async () => {
  const res = await post({ userId: ID.otherTenantUser, roleId: ID.ord1 });
  expect(res.status).toBe(400);
  expect(res.body.error.message).toBe("User not found");
  untouched(ID.otherTenantUser, []);
});

test("4 role from another tenant (and an inactive role) is unresolved -> 400, nothing touched", async () => {
  const cross = await post({ userId: ID.other, roleId: ID.otherTenantOrd });
  expect(cross.status).toBe(400);
  expect(cross.body.error.message).toMatch(/Role not found/);
  const inactive = await post({ userId: ID.other, roleId: ID.inactive });
  expect(inactive.status).toBe(400);
  expect(inactive.body.error.message).toMatch(/Roles not found/);
  untouched(ID.other, [ID.ord2]);
});

test.each([
  ["5 SU", ID.su],
  ["6 ASU (code ' asu ')", ID.asu],
  ["7 system role (isSystemRole)", ID.sys],
])("%s cannot be assigned by non-SU — to another user or to themselves (403)", async (_label, roleId) => {
  for (const actorRoles of [["MO"], ["ASU"], [{ code: "ASU" }], []]) {
    for (const userId of [ID.other, ID.actor]) {
      const res = await post({ userId, roleId }, { actorRoles });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("ROLE_PRIVILEGE_VIOLATION");
    }
  }
  untouched(ID.other, [ID.ord2]);
  untouched(ID.actor, [ID.ord2]);
});

test("SU actor may assign a protected role (existing SU rule unchanged)", async () => {
  const res = await post({ userId: ID.other, roleId: ID.su }, { actorRoles: ["SU"] });
  expect(res.status).toBe(200);
  expect(roles(ID.other)).toEqual([ID.ord2, ID.su]);
});

test("8 body / query / header tenant spoofing is ignored (lookups use trusted tenant A only)", async () => {
  const res = await post(
    { userId: ID.otherTenantUser, roleId: ID.otherTenantOrd, tenantId: B },
    { query: `?tenantId=${B}`, headers: { "x-tenant-id": B } }
  );
  expect(res.status).toBe(400);
  expect(mockUserQueries.every((q) => q.tenantId === A)).toBe(true);
  expect(mockRoleQueries.every((q) => q.tenantId === A)).toBe(true);
  untouched(ID.otherTenantUser, []);
  const self = await post({ userId: ID.actor, roleId: ID.su, roles: ["SU"] }, { headers: { "x-user-roles": '["SU"]' } });
  expect(self.status).toBe(403); // SU claimed in body/header does not elevate
  untouched(ID.actor, [ID.ord2]);
});

test("9 duplicate assignment -> 400 'already has all', same as /users/assign-role; no save", async () => {
  const res = await post({ userId: ID.other, roleId: ID.ord2 });
  expect(res.status).toBe(400);
  expect(res.body.error.message).toBe("User already has all the specified roles");
  untouched(ID.other, [ID.ord2]);
});

test("invalid ids -> 400 (no hang); every request now gets a response", async () => {
  const res = await post({ userId: "not-an-id", roleId: ID.ord1 });
  expect(res.status).toBe(400);
  expect(res.body.error.message).toMatch(/Invalid userId format/);
});

test("unexpected failure -> 500 via sendInternalError (no hang, no internal message leaked)", async () => {
  mockUsers[ID.other].save = jest.fn(async () => { throw new Error("db write exploded"); });
  const res = await post({ userId: ID.other, roleId: ID.ord1 });
  expect(res.status).toBe(500);
  expect(res.body.error.message).toBe("Failed to assign role to user");
});

// 10 — decision equivalence with the existing hardened endpoint (RoleController.assignRolesToUser)
test("10 tenant endpoint follows the same decisions as /users/assign-role for every case", async () => {
  const outcome = async (fn) => {
    resetUsers();
    const r = await fn();
    return { r, roles: { other: roles(ID.other), actor: roles(ID.actor), b: roles(ID.otherTenantUser) } };
  };
  const viaController = async (actorRoles, userId, roleId) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; } };
    let err;
    await RoleController.assignRolesToUser({ ctx: { tenantId: A, userId: ID.actor, roles: actorRoles }, body: { userId, roleIds: [roleId] } }, res, (e) => (err = e));
    return err ? err.status : res.statusCode;
  };
  const rows = [];
  for (const actorRoles of [["SU"], ["ASU"], ["MO"], []])
    for (const userId of [ID.other, ID.actor, ID.otherTenantUser, "not-an-id"])
      for (const roleId of [ID.su, ID.asu, ID.sys, ID.ord1, ID.ord2, ID.inactive, ID.otherTenantOrd]) {
        const t = await outcome(async () => (await post({ userId, roleId }, { actorRoles })).status);
        const c = await outcome(() => viaController(actorRoles, userId, roleId));
        rows.push([JSON.stringify(actorRoles), userId, roleId, t.r, c.r]);
        expect(t.r).not.toBe("NO_RESPONSE");
        expect([t.r === 200, t.roles]).toEqual([c.r === 200, c.roles]); // same allow/deny + same resulting state
        if (c.r === 403) expect(t.r).toBe(403); // privilege denials are 403 on both
      }
  expect(rows.length).toBe(112);
});

test("11/12 existing assign-role / batch / sync / remove wiring is unchanged", () => {
  const fs = require("fs");
  const path = require("path");
  const role = fs.readFileSync(path.join(__dirname, "..", "routes", "role.routes.js"), "utf8");
  expect(role).toMatch(/"\/users\/assign-role",\s*\n\s*defaultPolicyAdapter\.middleware\("role", "admin"\),\s*\n\s*RoleController\.assignRolesToUser/);
  expect(role).toMatch(/"\/users\/assign-roles-batch",\s*\n\s*defaultPolicyAdapter\.middleware\("role", "admin"\),\s*\n\s*RoleController\.assignRolesToUser/);
  expect(role).toMatch(/"\/users\/sync-roles",\s*\n\s*defaultPolicyAdapter\.middleware\("role", "admin"\),\s*\n\s*RoleController\.syncRolesForUser/);
  const scoped = fs.readFileSync(path.join(__dirname, "..", "routes", "tenantScoped.routes.js"), "utf8");
  expect(scoped).toMatch(/"\/tenant\/users\/assign-role",\s*\n\s*defaultPolicyAdapter\.middleware\("role", "write"\),\s*\n\s*TenantScopedController\.assignRoleToUserInTenant/);
  expect(scoped).toMatch(/"\/tenant\/users\/remove-role",\s*\n\s*defaultPolicyAdapter\.middleware\("role", "write"\),\s*\n\s*TenantScopedController\.removeRoleFromUserInTenant/);
  const RoleHandler = require("../handlers/role.handler");
  expect(RoleHandler.assignRoleToUser).toBeUndefined(); // no second assignment implementation added
  expect(typeof RoleHandler.assignRolesToUser).toBe("function");
});
