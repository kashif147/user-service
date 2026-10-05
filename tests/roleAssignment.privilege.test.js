/**
 * Phase 1C-2B — role ASSIGNMENT privilege boundary.
 *
 * Non-SU actors (trusted req.ctx roles) cannot assign a role whose PERSISTED document is SU/ASU
 * (case/whitespace-insensitive) or isSystemRole — to anyone, including themselves. Batch/sync
 * operations validate every requested role before the user is touched (no partial updates).
 * Role documents are loaded with the trusted tenantId only.
 *
 * Endpoints (routes/role.routes.js, routes/tenantScoped.routes.js):
 *   POST /users/assign-role, POST /users/assign-roles-batch -> RoleController.assignRolesToUser
 *   POST /users/sync-roles                                  -> RoleController.syncRolesForUser
 *   POST /tenant/users/assign-role                          -> TenantScopedController.assignRoleToUserInTenant
 * Models are mocked; no DB.
 */
const fs = require("fs");
const path = require("path");

const A = "68cbf7806080b4621d469d34";
const B = "aaaaaaaaaaaaaaaaaaaaaaaa";
const ID = {
  su: "a00000000000000000000001",
  asu: "a00000000000000000000002",
  sys: "a00000000000000000000003",
  ord1: "a00000000000000000000004",
  ord2: "a00000000000000000000005",
  otherTenantOrd: "b00000000000000000000001",
  self: "c00000000000000000000001",
  other: "c00000000000000000000002",
};

const mockRoleRows = [
  { _id: ID.su, tenantId: A, code: "SU", isSystemRole: false, isActive: true, permissions: [] },
  { _id: ID.asu, tenantId: A, code: " asu ", isSystemRole: false, isActive: true, permissions: [] },
  { _id: ID.sys, tenantId: A, code: "GS", isSystemRole: true, isActive: true, permissions: [] },
  { _id: ID.ord1, tenantId: A, code: "BRO", isSystemRole: false, isActive: true, permissions: [] },
  { _id: ID.ord2, tenantId: A, code: "IO", isSystemRole: false, isActive: true, permissions: [] },
  { _id: ID.otherTenantOrd, tenantId: B, code: "BRO", isSystemRole: false, isActive: true, permissions: [] },
];
const mockUsers = {};
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
    const u = mockUsers[q._id] && mockUsers[q._id].tenantId === q.tenantId ? mockUsers[q._id] : null;
    const p = Promise.resolve(u);
    p.populate = () => Promise.resolve(u);
    return p;
  },
}));
jest.mock("../models/permission.model", () => ({ findById: async () => null, findOne: async () => null, find: () => ({ select: async () => [] }) }));
jest.mock("../models/tenant.model", () => ({}));
jest.mock("../handlers/permission.handler", () => ({ getPermissionByCode: async () => ({}) }));

const RoleHandler = require("../handlers/role.handler");
const RoleController = require("../controllers/role.controller");
const TenantScopedController = require("../controllers/tenantScoped.controller");

function resetUsers() {
  for (const id of [ID.self, ID.other]) {
    mockUsers[id] = { _id: id, tenantId: A, roles: [ID.ord2], save: jest.fn(async function () { return this; }) };
  }
}
beforeEach(() => {
  resetUsers();
  mockRoleQueries.length = 0;
});

const ctx = (roles, userId = ID.self) => ({ tenantId: A, userId, roles });
const mkRes = () => {
  const r = { statusCode: null, body: null, failMessage: null };
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  r.success = (d) => r.status(200).json(d);
  r.fail = (m) => ((r.failMessage = m), r.status(400).json({ status: "fail", message: m }));
  return r;
};
const callCtl = async (fn, roles, body, actorId) => {
  const res = mkRes();
  const next = jest.fn();
  await RoleController[fn]({ ctx: ctx(roles, actorId), body, params: {} }, res, next);
  return { res, next, err: next.mock.calls[0] && next.mock.calls[0][0] };
};
const userRoles = (id) => mockUsers[id].roles.map(String);
const unchanged = (id) => {
  expect(mockUsers[id].save).not.toHaveBeenCalled();
  expect(userRoles(id)).toEqual([ID.ord2]);
};

// ---------------------------------------------------------------------------
// assign-role / assign-roles-batch (same controller) and sync-roles — non-SU
// ---------------------------------------------------------------------------
describe.each([["assignRolesToUser"], ["syncRolesForUser"]])("%s — non-SU (ASU)", (fn) => {
  test.each([["SU", ID.su], ["ASU (lower-case/whitespace)", ID.asu], ["system role", ID.sys]])(
    "A/B/C assigning %s to another user -> 403 ROLE_PRIVILEGE_VIOLATION, user untouched",
    async (_l, roleId) => {
      const { err } = await callCtl(fn, ["ASU"], { userId: ID.other, roleIds: [roleId] });
      expect(err).toMatchObject({ status: 403, code: "ROLE_PRIVILEGE_VIOLATION" });
      expect(err.message).not.toMatch(/GS|asu|SU,|_id/); // generic message, no role internals
      unchanged(ID.other);
    }
  );

  test.each([[ID.su], [ID.asu], [ID.sys]])("D self-assign protected role %s -> 403", async (roleId) => {
    const { err } = await callCtl(fn, ["ASU"], { userId: ID.self, roleIds: [roleId] }, ID.self);
    expect(err).toMatchObject({ status: 403, code: "ROLE_PRIVILEGE_VIOLATION" });
    unchanged(ID.self);
  });

  test("E/H ordinary tenant roles succeed", async () => {
    const { res, next } = await callCtl(fn, ["ASU"], { userId: ID.other, roleIds: [ID.ord1, ID.ord2] });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(mockUsers[ID.other].save).toHaveBeenCalledTimes(1);
    expect(userRoles(ID.other)).toEqual(expect.arrayContaining([ID.ord1, ID.ord2]));
  });

  test("F another tenant's role _id is not found (400), never assigned", async () => {
    const { err } = await callCtl(fn, ["ASU"], { userId: ID.other, roleIds: [ID.otherTenantOrd] });
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Roles not found/);
    unchanged(ID.other);
    // role lookup is tenant-scoped by the trusted tenant; no _id-only fallback query was issued
    expect(mockRoleQueries.every((q) => q.tenantId === A)).toBe(true);
  });

  test("G body claiming an ordinary code while the _id resolves to SU -> 403", async () => {
    const { err } = await callCtl(fn, ["ASU"], {
      userId: ID.other,
      roleIds: [ID.su],
      roleCodes: ["BRO"],
      roles: [{ _id: ID.su, code: "BRO", isSystemRole: false }],
    });
    expect(err).toMatchObject({ status: 403, code: "ROLE_PRIVILEGE_VIOLATION" });
    unchanged(ID.other);
  });

  test("I/J one protected role mixed with ordinary roles -> whole operation rejected, no partial update", async () => {
    const { err } = await callCtl(fn, ["ASU"], { userId: ID.other, roleIds: [ID.ord1, ID.sys, ID.ord2] });
    expect(err).toMatchObject({ status: 403, code: "ROLE_PRIVILEGE_VIOLATION" });
    unchanged(ID.other);
  });

  test("actor roles come from req.ctx only: SU claimed in the body is ignored", async () => {
    const { err } = await callCtl(fn, ["ASU"], { userId: ID.other, roleIds: [ID.su], actorRoles: ["SU"], ctx: { roles: ["SU"] } });
    expect(err).toMatchObject({ status: 403 });
    unchanged(ID.other);
  });
});

describe("K SU keeps existing assignment behaviour", () => {
  test.each([["assignRolesToUser"], ["syncRolesForUser"]])("%s: SU may assign SU/ASU/system roles", async (fn) => {
    const { res, next } = await callCtl(fn, ["SU"], { userId: ID.other, roleIds: [ID.su, ID.asu, ID.sys] });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(userRoles(ID.other)).toEqual(expect.arrayContaining([ID.su, ID.asu, ID.sys]));
  });

  test("handlers fail closed without an actor", async () => {
    await expect(RoleHandler.assignRolesToUser(ID.other, [ID.ord1], A)).rejects.toBeInstanceOf(RoleHandler.RolePrivilegeError);
    await expect(RoleHandler.syncRolesForUser(ID.other, [ID.ord1], A)).rejects.toBeInstanceOf(RoleHandler.RolePrivilegeError);
    unchanged(ID.other);
  });
});

// ---------------------------------------------------------------------------
// POST /tenant/users/assign-role (tenant-scoped, ASU)
// ---------------------------------------------------------------------------
describe("tenantScoped assignRoleToUserInTenant", () => {
  const call = async (roles, roleId, userId = ID.other) => {
    const res = mkRes();
    await TenantScopedController.assignRoleToUserInTenant({ ctx: ctx(roles), body: { userId, roleId } }, res);
    return res;
  };

  test.each([[ID.su], [ID.asu], [ID.sys]])("non-SU assigning protected role %s (incl. self) -> 403", async (roleId) => {
    for (const userId of [ID.other, ID.self]) {
      const res = await call(["ASU"], roleId, userId);
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe("ROLE_PRIVILEGE_VIOLATION");
    }
    unchanged(ID.other);
    unchanged(ID.self);
  });

  test("ordinary role passes the guard; another tenant's role is not found", async () => {
    const ok = await call(["ASU"], ID.ord1);
    expect(ok.statusCode).not.toBe(403);
    // pre-existing: RoleHandler.assignRoleToUser does not exist, so this endpoint cannot assign at all
    expect(ok.failMessage).toMatch(/assignRoleToUser is not a function/);
    const cross = await call(["ASU"], ID.otherTenantOrd);
    expect(cross.statusCode).toBe(400);
    expect(mockRoleQueries.every((q) => q.tenantId === A)).toBe(true);
  });

  test("SU passes the guard for a protected role", async () => {
    const res = await call(["SU"], ID.su);
    expect(res.statusCode).not.toBe(403);
  });
});

test("route wiring: the four assignment endpoints map to the guarded controllers", () => {
  const role = fs.readFileSync(path.join(__dirname, "..", "routes", "role.routes.js"), "utf8");
  expect(role).toMatch(/"\/users\/assign-role",\s*\n\s*defaultPolicyAdapter\.middleware\("role", "admin"\),\s*\n\s*RoleController\.assignRolesToUser/);
  expect(role).toMatch(/"\/users\/assign-roles-batch",\s*\n\s*defaultPolicyAdapter\.middleware\("role", "admin"\),\s*\n\s*RoleController\.assignRolesToUser/);
  expect(role).toMatch(/"\/users\/sync-roles",\s*\n\s*defaultPolicyAdapter\.middleware\("role", "admin"\),\s*\n\s*RoleController\.syncRolesForUser/);
  const scoped = fs.readFileSync(path.join(__dirname, "..", "routes", "tenantScoped.routes.js"), "utf8");
  expect(scoped).toMatch(/"\/tenant\/users\/assign-role",\s*\n\s*defaultPolicyAdapter\.middleware\("role", "write"\),\s*\n\s*TenantScopedController\.assignRoleToUserInTenant/);
});

test("one privilege model: assignment and definition rules share reserved codes / system flag", () => {
  expect(RoleHandler.isProtectedRole({ code: " su " })).toBe(true);
  expect(RoleHandler.isProtectedRole({ code: "Asu" })).toBe(true);
  expect(RoleHandler.isProtectedRole({ code: "GS", isSystemRole: true })).toBe(true);
  expect(RoleHandler.isProtectedRole({ code: "BRO", isSystemRole: false })).toBe(false);
});
