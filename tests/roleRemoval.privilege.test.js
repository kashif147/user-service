/**
 * Phase 1C-2C — protected-role REMOVAL boundary.
 *
 * Non-SU actors (trusted req.ctx roles) cannot remove a role whose PERSISTED, tenant-scoped document
 * is SU/ASU (case/whitespace-insensitive) or isSystemRole — from themselves or anyone else.
 * Batch removal and sync validate everything before the user is saved (no partial updates).
 * Same protected-role model as role definition/assignment (isProtectedRole, RolePrivilegeError).
 *
 * Endpoints:
 *   POST /users/remove-role        -> RoleController.removeRoleFromUser  -> RoleHandler.removeRoleFromUser
 *   POST /users/remove-roles-batch -> RoleController.removeRolesFromUser -> RoleHandler.removeRolesFromUser
 *   POST /users/sync-roles         -> RoleController.syncRolesForUser    -> RoleHandler.syncRolesForUser
 *   (also POST /tenant/users/remove-role -> TenantScopedController.removeRoleFromUserInTenant)
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
  ord3: "a00000000000000000000006",
  otherTenantOrd: "b00000000000000000000001",
  self: "c00000000000000000000001",
  other: "c00000000000000000000002",
};

const mockRoleRows = [
  { _id: ID.su, tenantId: A, code: "SU", isSystemRole: false, isActive: true, permissions: [] },
  { _id: ID.asu, tenantId: A, code: " asu ", isSystemRole: false, isActive: false, permissions: [] }, // inactive still protected
  { _id: ID.sys, tenantId: A, code: "GS", isSystemRole: true, isActive: true, permissions: [] },
  { _id: ID.ord1, tenantId: A, code: "BRO", isSystemRole: false, isActive: true, permissions: [] },
  { _id: ID.ord2, tenantId: A, code: "IO", isSystemRole: false, isActive: true, permissions: [] },
  { _id: ID.ord3, tenantId: A, code: "MO", isSystemRole: false, isActive: true, permissions: [] },
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

const START = [ID.su, ID.asu, ID.sys, ID.ord1, ID.ord2];
function resetUsers() {
  for (const id of [ID.self, ID.other]) {
    mockUsers[id] = { _id: id, tenantId: A, roles: [...START], save: jest.fn(async function () { return this; }) };
  }
}
beforeEach(() => {
  resetUsers();
  mockRoleQueries.length = 0;
});

const mkRes = () => {
  const r = { statusCode: null, body: null, failMessage: null };
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  r.success = (d) => r.status(200).json(d);
  r.fail = (m) => ((r.failMessage = m), r.status(400).json({ status: "fail", message: m }));
  r.notFoundRecord = (m) => r.status(404).json({ message: m });
  return r;
};
const callCtl = async (fn, roles, body, actorId = ID.self) => {
  const res = mkRes();
  const next = jest.fn();
  await RoleController[fn]({ ctx: { tenantId: A, userId: actorId, roles }, body, params: {} }, res, next);
  return { res, next, err: next.mock.calls[0] && next.mock.calls[0][0] };
};
const rolesOf = (id) => mockUsers[id].roles.map(String);
const untouched = (id) => {
  expect(mockUsers[id].save).not.toHaveBeenCalled();
  expect(rolesOf(id)).toEqual(START);
};
const expect403 = (err) => {
  expect(err).toMatchObject({ status: 403, code: "ROLE_PRIVILEGE_VIOLATION" });
  expect(err.message).toBe("Only SU may remove platform or system roles"); // generic, no internals
};

// ---------------------------------------------------------------------------
// remove-role (single)
// ---------------------------------------------------------------------------
describe("POST /users/remove-role — non-SU (ASU)", () => {
  test.each([["A SU", ID.su], ["B ASU (inactive, lower-case/whitespace)", ID.asu], ["C system role", ID.sys]])(
    "%s from another user -> 403, user untouched (F)",
    async (_l, roleId) => {
      const { err } = await callCtl("removeRoleFromUser", ["ASU"], { userId: ID.other, roleId });
      expect403(err);
      untouched(ID.other);
    }
  );

  test.each([[ID.su], [ID.asu], [ID.sys]])("E self-removal of protected role %s -> 403", async (roleId) => {
    const { err } = await callCtl("removeRoleFromUser", ["ASU"], { userId: ID.self, roleId }, ID.self);
    expect403(err);
    untouched(ID.self);
  });

  test("D ordinary role removal succeeds", async () => {
    const { res, next } = await callCtl("removeRoleFromUser", ["ASU"], { userId: ID.other, roleId: ID.ord1 });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(rolesOf(ID.other)).toEqual([ID.su, ID.asu, ID.sys, ID.ord2]);
  });

  test("G cross-tenant role id -> 400 Roles not found, user untouched, lookup tenant-scoped", async () => {
    const { err } = await callCtl("removeRoleFromUser", ["ASU"], { userId: ID.other, roleId: ID.otherTenantOrd });
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Roles not found/);
    untouched(ID.other);
    expect(mockRoleQueries.length).toBeGreaterThan(0);
    expect(mockRoleQueries.every((q) => q.tenantId === A)).toBe(true);
  });

  test("H body claims an ordinary role but the stored role is SU -> 403", async () => {
    const { err } = await callCtl("removeRoleFromUser", ["ASU"], {
      userId: ID.other,
      roleId: ID.su,
      roleCode: "BRO",
      role: { _id: ID.su, code: "BRO", isSystemRole: false },
    });
    expect403(err);
    untouched(ID.other);
  });
});

// ---------------------------------------------------------------------------
// remove-roles-batch
// ---------------------------------------------------------------------------
describe("POST /users/remove-roles-batch — non-SU (ASU)", () => {
  test("J all ordinary removals succeed", async () => {
    const { res, next } = await callCtl("removeRolesFromUser", ["ASU"], { userId: ID.other, roleIds: [ID.ord1, ID.ord2] });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(rolesOf(ID.other)).toEqual([ID.su, ID.asu, ID.sys]);
  });

  test.each([[ID.su], [ID.asu], [ID.sys]])("K/L one protected (%s) + ordinary -> whole batch rejected, no partial save", async (p) => {
    const { err } = await callCtl("removeRolesFromUser", ["ASU"], { userId: ID.other, roleIds: [ID.ord1, p, ID.ord2] });
    expect403(err);
    untouched(ID.other);
  });

  test("self batch including a protected role -> 403", async () => {
    const { err } = await callCtl("removeRolesFromUser", ["ASU"], { userId: ID.self, roleIds: [ID.sys, ID.ord1] }, ID.self);
    expect403(err);
    untouched(ID.self);
  });

  test("cross-tenant id in a batch -> 400, nothing removed", async () => {
    const { err } = await callCtl("removeRolesFromUser", ["ASU"], { userId: ID.other, roleIds: [ID.ord1, ID.otherTenantOrd] });
    expect(err.status).toBe(400);
    untouched(ID.other);
  });
});

// ---------------------------------------------------------------------------
// sync-roles
// ---------------------------------------------------------------------------
describe("POST /users/sync-roles — non-SU (ASU)", () => {
  test("M protected roles retained -> sync succeeds (ordinary change applied)", async () => {
    // user keeps SU + system role (already held — not newly assigned); swaps ord1 -> ord3, keeps ord2.
    // (sync's pre-existing rule requires every desired role to be active, so the inactive ASU fixture
    // is not part of this user's set here.)
    mockUsers[ID.other].roles = [ID.su, ID.sys, ID.ord1, ID.ord2];
    const { res, next } = await callCtl("syncRolesForUser", ["ASU"], {
      userId: ID.other,
      roleIds: [ID.su, ID.sys, ID.ord2, ID.ord3],
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(rolesOf(ID.other)).toEqual([ID.su, ID.sys, ID.ord2, ID.ord3]);
  });

  test("N dropping held SU/ASU/system implicitly (sync to ordinary only) -> 403, untouched", async () => {
    const { err } = await callCtl("syncRolesForUser", ["ASU"], { userId: ID.other, roleIds: [ID.ord3] });
    expect403(err);
    untouched(ID.other);
  });

  test("M' a user holding only ordinary roles: ordinary sync works; protected kept on another user is not blocked by removal rule", async () => {
    mockUsers[ID.other].roles = [ID.ord1, ID.ord2];
    const { res, next } = await callCtl("syncRolesForUser", ["ASU"], { userId: ID.other, roleIds: [ID.ord2, ID.ord3] });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(rolesOf(ID.other)).toEqual([ID.ord2, ID.ord3]);
  });

  test("N protected role would be removed -> 403, no save", async () => {
    mockUsers[ID.other].roles = [ID.sys, ID.ord1];
    const { err } = await callCtl("syncRolesForUser", ["ASU"], { userId: ID.other, roleIds: [ID.ord1] });
    expect403(err);
    expect(mockUsers[ID.other].save).not.toHaveBeenCalled();
    expect(rolesOf(ID.other)).toEqual([ID.sys, ID.ord1]);
  });

  test("N empty sync (remove all) on a user with a protected role -> 403", async () => {
    mockUsers[ID.self].roles = [ID.asu];
    const { err } = await callCtl("syncRolesForUser", ["ASU"], { userId: ID.self, roleIds: [] }, ID.self);
    expect403(err);
    expect(mockUsers[ID.self].save).not.toHaveBeenCalled();
  });

  test("unverifiable held role (cannot be resolved in tenant) cannot be dropped by non-SU", async () => {
    mockUsers[ID.other].roles = [ID.otherTenantOrd, ID.ord1];
    const { err } = await callCtl("syncRolesForUser", ["ASU"], { userId: ID.other, roleIds: [ID.ord1] });
    expect403(err);
    expect(mockUsers[ID.other].save).not.toHaveBeenCalled();
  });

  test("O ordinary changes still work when protected roles are not part of the user's set", async () => {
    mockUsers[ID.other].roles = [ID.ord1];
    const { res } = await callCtl("syncRolesForUser", ["ASU"], { userId: ID.other, roleIds: [ID.ord2, ID.ord3] });
    expect(res.statusCode).toBe(200);
    expect(rolesOf(ID.other)).toEqual([ID.ord2, ID.ord3]);
  });

  test("assignment rule still applies inside sync (adding a protected role is 403)", async () => {
    mockUsers[ID.other].roles = [ID.ord1];
    const { err } = await callCtl("syncRolesForUser", ["ASU"], { userId: ID.other, roleIds: [ID.ord1, ID.sys] });
    expect(err).toMatchObject({ status: 403, code: "ROLE_PRIVILEGE_VIOLATION" });
    expect(mockUsers[ID.other].save).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SU
// ---------------------------------------------------------------------------
describe("I/P SU retains existing behaviour", () => {
  test("I SU may remove protected roles (single and batch)", async () => {
    const single = await callCtl("removeRoleFromUser", ["SU"], { userId: ID.other, roleId: ID.su });
    expect(single.next).not.toHaveBeenCalled();
    expect(rolesOf(ID.other)).not.toContain(ID.su);
    const batch = await callCtl("removeRolesFromUser", ["SU"], { userId: ID.other, roleIds: [ID.asu, ID.sys] });
    expect(batch.next).not.toHaveBeenCalled();
    expect(rolesOf(ID.other)).toEqual([ID.ord1, ID.ord2]);
  });

  test("P SU may remove protected roles through sync", async () => {
    const { res, next } = await callCtl("syncRolesForUser", ["SU"], { userId: ID.other, roleIds: [ID.ord1] });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(rolesOf(ID.other)).toEqual([ID.ord1]);
  });

  test("handlers fail closed without an actor", async () => {
    await expect(RoleHandler.removeRoleFromUser(ID.other, ID.ord1, A)).rejects.toBeInstanceOf(RoleHandler.RolePrivilegeError);
    await expect(RoleHandler.removeRolesFromUser(ID.other, [ID.ord1], A)).rejects.toBeInstanceOf(RoleHandler.RolePrivilegeError);
    await expect(RoleHandler.syncRolesForUser(ID.other, [ID.ord1], A)).rejects.toBeInstanceOf(RoleHandler.RolePrivilegeError);
    untouched(ID.other);
  });
});

describe("POST /tenant/users/remove-role (tenant-scoped) uses the same rule", () => {
  const call = async (roles, roleId, userId = ID.other) => {
    const res = mkRes();
    await TenantScopedController.removeRoleFromUserInTenant({ ctx: { tenantId: A, userId: ID.self, roles }, body: { userId, roleId } }, res);
    return res;
  };
  test("non-SU removing protected role (self or other) -> 403; ordinary -> 200; SU -> 200", async () => {
    for (const userId of [ID.other, ID.self]) {
      expect((await call(["ASU"], ID.sys, userId)).statusCode).toBe(403);
    }
    untouched(ID.other);
    expect((await call(["ASU"], ID.ord1)).statusCode).toBe(200);
    expect((await call(["SU"], ID.su)).statusCode).toBe(200);
  });
});

test("route wiring: removal endpoints map to the guarded controllers", () => {
  const role = fs.readFileSync(path.join(__dirname, "..", "routes", "role.routes.js"), "utf8");
  expect(role).toMatch(/"\/users\/remove-role",\s*\n\s*defaultPolicyAdapter\.middleware\("role", "admin"\),\s*\n\s*RoleController\.removeRoleFromUser/);
  expect(role).toMatch(/"\/users\/remove-roles-batch",\s*\n\s*defaultPolicyAdapter\.middleware\("role", "admin"\),\s*\n\s*RoleController\.removeRolesFromUser/);
  expect(role).toMatch(/"\/users\/sync-roles",\s*\n\s*defaultPolicyAdapter\.middleware\("role", "admin"\),\s*\n\s*RoleController\.syncRolesForUser/);
});
