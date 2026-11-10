/**
 * P7 role / user-type compatibility at every user-service assignment path, in each ROLE_CLASS_MODE.
 *
 *   POST /users/assign-role, /users/assign-roles-batch -> RoleController.assignRolesToUser
 *   POST /users/sync-roles                             -> RoleController.syncRolesForUser
 *   POST /tenant/users/assign-role                     -> TenantScopedController.assignRoleToUserInTenant
 *   helpers/roleAssignment.js assignMemberRole / assignNonMemberRole / assignDefaultRole
 *     (application approval, membership promotion and demotion listeners, portalRoleSync,
 *      RoleController.testDefaultRoleAssignment, scripts/assign-default-roles-enhanced.js)
 *
 * off and shadow: today's outcome exactly (shadow also logs what enforce would refuse).
 * enforce: an incompatible role refuses the WHOLE request (409 ROLE_CLASS_INCOMPATIBLE); the user is
 * never saved and its roles are unchanged, including for mixed batches and redelivered events.
 * Models are mocked; no DB.
 */
const A = "68cbf7806080b4621d469d34";
const ID = {
  mo: "a00000000000000000000001",
  reo: "a00000000000000000000002",
  member: "a00000000000000000000003",
  nonMember: "a00000000000000000000004",
  asu: "a00000000000000000000005",
  customCrm: "a00000000000000000000006",
  noCategory: "a00000000000000000000007",
  badCategory: "a00000000000000000000008",
  crmUser: "c00000000000000000000001",
  portalUser: "c00000000000000000000002",
  noTypeUser: "c00000000000000000000003",
  oddTypeUser: "c00000000000000000000004",
};

// Live-like data: standard staff roles stored with category PORTAL (as on DEV MULTIAUTH).
const mockRoleRows = [
  { _id: ID.mo, tenantId: A, code: "MO", category: "PORTAL", isActive: true, permissions: [] },
  { _id: ID.reo, tenantId: A, code: "REO", category: "CRM", isActive: true, permissions: [] },
  { _id: ID.member, tenantId: A, code: "MEMBER", category: "PORTAL", isActive: true, permissions: [] },
  { _id: ID.nonMember, tenantId: A, code: "NON-MEMBER", category: "PORTAL", isActive: true, permissions: [] },
  { _id: ID.asu, tenantId: A, code: "ASU", category: "SYSTEM", isActive: true, permissions: [] },
  { _id: ID.customCrm, tenantId: A, code: "PSG-CRM", category: "CRM", isActive: true, permissions: [] },
  { _id: ID.noCategory, tenantId: A, code: "CUSTOM1", isActive: true, permissions: [] },
  { _id: ID.badCategory, tenantId: A, code: "CUSTOM2", category: "STAFF", isActive: true, permissions: [] },
];
const mockUsers = {};
let mockListenerUser = null;

const mockRowMatch = (r, q) =>
  Object.entries(q).every(([k, v]) => {
    if (v && typeof v === "object" && "$in" in v) return v.$in.map(String).includes(String(r[k]));
    return String(r[k]) === String(v);
  });

jest.mock("../models/role.model", () => ({
  find: async (q) => mockRoleRows.filter((r) => mockRowMatch(r, q)),
  findOne: async (q) => {
    const r = mockRoleRows.find((x) => mockRowMatch(x, q));
    return r ? { ...r, _id: { toString: () => r._id, equals: (o) => String(o) === r._id, valueOf: () => r._id }, toObject: () => ({ ...r }) } : null;
  },
}));
jest.mock("../models/user.model", () => {
  const findOne = (q) => {
    let u = null;
    if (q && q._id && mockUsers[String(q._id)] && (!q.tenantId || mockUsers[String(q._id)].tenantId === q.tenantId)) {
      u = mockUsers[String(q._id)];
    }
    if (q && q.userType === "PORTAL" && mockListenerUser) u = mockListenerUser; // listener lookups
    const p = Promise.resolve(u);
    p.populate = () => Promise.resolve(u);
    return p;
  };
  return { findOne };
});
jest.mock("../models/permission.model", () => ({ findById: async () => null, findOne: async () => null, find: () => ({ select: async () => [] }) }));
jest.mock("../models/tenant.model", () => ({}));
jest.mock("../handlers/permission.handler", () => ({ getPermissionByCode: async () => ({}) }));
jest.mock("../services/membershipCheck.service", () => ({ hasActiveMembership: jest.fn(async () => true) }));

const RoleController = require("../controllers/role.controller");
const TenantScopedController = require("../controllers/tenantScoped.controller");
const roleAssignment = require("../helpers/roleAssignment");
const { syncPortalUserRolesFromMembership } = require("../helpers/portalRoleSync");
const { handleApplicationApproved } = require("../rabbitMQ/listeners/application.approval.listener");
const { handlePortalMemberPromotion } = require("../rabbitMQ/listeners/subscription.membership.promotion.listener");
const { handlePortalMemberDemotion } = require("../rabbitMQ/listeners/subscription.membership.demotion.listener");

const ASU_ACTOR = ["ASU"];
const savedMode = process.env.ROLE_CLASS_MODE;
let warn;

function mkUser(id, userType, roles) {
  const u = { _id: id, tenantId: A, roles: [...roles], save: jest.fn(async function () { return this; }) };
  if (userType !== undefined) u.userType = userType;
  return u;
}
function resetUsers() {
  mockUsers[ID.crmUser] = mkUser(ID.crmUser, "CRM", [ID.reo]);
  mockUsers[ID.portalUser] = mkUser(ID.portalUser, "PORTAL", [ID.nonMember]);
  mockUsers[ID.noTypeUser] = mkUser(ID.noTypeUser, undefined, [ID.reo]);
  mockUsers[ID.oddTypeUser] = mkUser(ID.oddTypeUser, "ADMIN", [ID.reo]);
  mockListenerUser = null;
}
const setMode = (m) => { process.env.ROLE_CLASS_MODE = m; };
const classLogs = () => warn.mock.calls.filter((c) => c[0] === "[ROLE_CLASS]").map((c) => JSON.parse(c[1]));

beforeEach(() => {
  resetUsers();
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  if (savedMode === undefined) delete process.env.ROLE_CLASS_MODE;
  else process.env.ROLE_CLASS_MODE = savedMode;
});

const mkRes = () => {
  const r = { statusCode: null, body: null };
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  r.success = (d) => r.status(200).json(d);
  r.sendBadRequest = (m) => r.status(400).json({ success: false, error: { message: m } });
  r.sendInternalError = (m) => r.status(500).json({ success: false, error: { message: m } });
  return r;
};
const callCtl = async (fn, body) => {
  const res = mkRes();
  const next = jest.fn();
  await RoleController[fn]({ ctx: { tenantId: A, userId: "c0000000000000000000ffff", roles: ASU_ACTOR }, body, params: {} }, res, next);
  return { res, err: next.mock.calls[0] && next.mock.calls[0][0] };
};
const callTenantScoped = async (body) => {
  const res = mkRes();
  await TenantScopedController.assignRoleToUserInTenant({ ctx: { tenantId: A, userId: "c0000000000000000000ffff", roles: ASU_ACTOR }, body }, res);
  return res;
};
const rolesOf = (id) => mockUsers[id].roles.map(String);

// Request cases: [label, userId, roleIds requested, compatible?]
const CASES = [
  ["CRM user + MO (standard, stored category PORTAL)", ID.crmUser, [ID.mo], true],
  ["CRM user + ASU", ID.crmUser, [ID.asu], true],
  ["CRM user + custom CRM role", ID.crmUser, [ID.customCrm], true],
  ["CRM user + MEMBER", ID.crmUser, [ID.member], false],
  ["mixed batch: CRM user + MO + MEMBER", ID.crmUser, [ID.mo, ID.member], false],
  ["mixed batch: CRM user + ASU + NON-MEMBER + custom CRM", ID.crmUser, [ID.asu, ID.nonMember, ID.customCrm], false],
  ["PORTAL user + MEMBER", ID.portalUser, [ID.member], true],
  ["PORTAL user + MO", ID.portalUser, [ID.mo], false],
  ["PORTAL user + ASU", ID.portalUser, [ID.asu], false],
  ["mixed batch: PORTAL user + MEMBER + REO", ID.portalUser, [ID.member, ID.reo], false],
  ["CRM user + custom role without category", ID.crmUser, [ID.noCategory], false],
  ["CRM user + custom role with unknown category", ID.crmUser, [ID.badCategory], false],
  ["user with missing userType + MO", ID.noTypeUser, [ID.mo], false],
  ["user with unknown userType + MO", ID.oddTypeUser, [ID.mo], false],
];

describe.each([["assignRolesToUser"], ["syncRolesForUser"]])("RoleController.%s", (fn) => {
  const bodyFor = (userId, roleIds) =>
    fn === "syncRolesForUser" ? { userId, roleIds: [...rolesOf(userId), ...roleIds] } : { userId, roleIds };

  describe.each([["off"], ["shadow"]])("ROLE_CLASS_MODE=%s keeps today's outcome", (mode) => {
    test.each(CASES)("%s -> 200, roles saved", async (_l, userId, roleIds) => {
      setMode(mode);
      const before = rolesOf(userId);
      const { res, err } = await callCtl(fn, bodyFor(userId, roleIds));
      expect(err).toBeUndefined();
      expect(res.statusCode).toBe(200);
      expect(mockUsers[userId].save).toHaveBeenCalledTimes(1);
      expect(rolesOf(userId)).toEqual([...before, ...roleIds]);
    });
  });

  test.each(CASES)("shadow logs exactly the refusals enforce would make: %s", async (_l, userId, roleIds, ok) => {
    setMode("shadow");
    await callCtl(fn, bodyFor(userId, roleIds));
    const logs = classLogs();
    if (ok) expect(logs).toHaveLength(0);
    else {
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ event: "role.class.shadow", outcome: "assignment_would_be_refused", mode: "shadow" });
    }
  });

  test("off evaluates nothing (no class log at all)", async () => {
    setMode("off");
    for (const [, userId, roleIds] of CASES) await callCtl(fn, bodyFor(userId, roleIds));
    expect(classLogs()).toHaveLength(0);
  });

  describe("ROLE_CLASS_MODE=enforce", () => {
    test.each(CASES.filter((c) => c[3]))("%s -> 200", async (_l, userId, roleIds) => {
      setMode("enforce");
      const { res, err } = await callCtl(fn, bodyFor(userId, roleIds));
      expect(err).toBeUndefined();
      expect(res.statusCode).toBe(200);
      expect(mockUsers[userId].save).toHaveBeenCalledTimes(1);
    });

    test.each(CASES.filter((c) => !c[3]))("%s -> 409, user not saved, roles unchanged", async (_l, userId, roleIds) => {
      setMode("enforce");
      const before = rolesOf(userId);
      const { err } = await callCtl(fn, bodyFor(userId, roleIds));
      expect(err).toMatchObject({ status: 409, code: "ROLE_CLASS_INCOMPATIBLE" });
      expect(mockUsers[userId].save).not.toHaveBeenCalled();
      expect(rolesOf(userId)).toEqual(before);
      expect(classLogs()[0]).toMatchObject({ event: "role.class.enforce", outcome: "assignment_refused" });
    });

    test("mixed batch names only the incompatible roles", async () => {
      setMode("enforce");
      const { err } = await callCtl(fn, bodyFor(ID.crmUser, [ID.asu, ID.nonMember, ID.customCrm, ID.member]));
      expect(err.details.map((d) => d.roleCode).sort()).toEqual(["MEMBER", "NON-MEMBER"]);
    });
  });
});

describe("only NEWLY added roles are checked (as for the privilege rule)", () => {
  test("sync keeping an incompatible role the user already holds is not refused", async () => {
    setMode("enforce");
    mockUsers[ID.crmUser].roles = [ID.reo, ID.member]; // pre-existing bad data (0 such holders on DEV)
    const { res, err } = await callCtl("syncRolesForUser", { userId: ID.crmUser, roleIds: [ID.reo, ID.member, ID.mo] });
    expect(err).toBeUndefined();
    expect(res.statusCode).toBe(200);
  });

  test("assign that repeats a held incompatible role plus a compatible one is not refused", async () => {
    setMode("enforce");
    mockUsers[ID.crmUser].roles = [ID.reo, ID.member];
    const { res } = await callCtl("assignRolesToUser", { userId: ID.crmUser, roleIds: [ID.member, ID.mo] });
    expect(res.statusCode).toBe(200);
  });

  test("sync to an empty list never consults the class rule", async () => {
    setMode("enforce");
    mockUsers[ID.noTypeUser].roles = [ID.reo];
    const { res } = await callCtl("syncRolesForUser", { userId: ID.noTypeUser, roleIds: [] });
    expect(res.statusCode).toBe(200);
    expect(rolesOf(ID.noTypeUser)).toEqual([]);
  });
});

describe("TenantScopedController.assignRoleToUserInTenant", () => {
  test.each([["off"], ["shadow"]])("%s: PORTAL user + MO -> 200 as today", async (mode) => {
    setMode(mode);
    const res = await callTenantScoped({ userId: ID.portalUser, roleId: ID.mo });
    expect(res.statusCode).toBe(200);
    expect(rolesOf(ID.portalUser)).toEqual([ID.nonMember, ID.mo]);
  });

  test("enforce: PORTAL user + MO -> 409, unchanged", async () => {
    setMode("enforce");
    const res = await callTenantScoped({ userId: ID.portalUser, roleId: ID.mo });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ status: "fail", code: "ROLE_CLASS_INCOMPATIBLE" });
    expect(mockUsers[ID.portalUser].save).not.toHaveBeenCalled();
    expect(rolesOf(ID.portalUser)).toEqual([ID.nonMember]);
  });

  test("enforce: CRM user + MO -> 200", async () => {
    setMode("enforce");
    const res = await callTenantScoped({ userId: ID.crmUser, roleId: ID.mo });
    expect(res.statusCode).toBe(200);
  });
});

describe("helpers/roleAssignment.js", () => {
  const fns = [
    ["assignMemberRole", (u) => roleAssignment.assignMemberRole(u, A), ID.member],
    ["assignNonMemberRole", (u) => roleAssignment.assignNonMemberRole(u, A), ID.nonMember],
  ];

  test.each(fns)("%s: PORTAL user is assigned in every mode", async (_n, call, roleId) => {
    for (const mode of ["off", "shadow", "enforce"]) {
      setMode(mode);
      const u = mkUser("x", "PORTAL", [ID.reo]);
      expect(await call(u)).toBe(true);
      expect(u.roles.map(String)).toEqual([roleId]);
    }
  });

  test.each(fns)("%s: CRM user -> off/shadow assigned as today, enforce false and untouched", async (_n, call, roleId) => {
    for (const mode of ["off", "shadow"]) {
      setMode(mode);
      const u = mkUser("x", "CRM", [ID.reo]);
      expect(await call(u)).toBe(true);
      expect(u.roles.map(String)).toEqual([roleId]);
    }
    setMode("enforce");
    const u = mkUser("x", "CRM", [ID.reo]);
    expect(await call(u)).toBe(false);
    expect(u.roles).toEqual([ID.reo]);
  });

  test.each(fns)("%s: missing / unknown user type -> enforce false", async (_n, call) => {
    setMode("enforce");
    for (const t of [undefined, "ADMIN"]) {
      const u = mkUser("x", t, [ID.reo]);
      expect(await call(u)).toBe(false);
      expect(u.roles).toEqual([ID.reo]);
    }
  });

  test("assignDefaultRole uses the user's STORED type: CRM user given the PORTAL default", async () => {
    for (const mode of ["off", "shadow"]) {
      setMode(mode);
      const u = mkUser("x", "CRM", []);
      await roleAssignment.assignDefaultRole(u, "PORTAL", A);
      expect(u.roles.map(String)).toEqual([ID.nonMember]);
    }
    setMode("enforce");
    const u = mkUser("x", "CRM", []);
    await roleAssignment.assignDefaultRole(u, "PORTAL", A);
    expect(u.roles).toEqual([]);
  });

  test("assignDefaultRole: matching types assign in enforce (CRM -> REO, PORTAL -> NON-MEMBER)", async () => {
    setMode("enforce");
    const c = mkUser("x", "CRM", []);
    await roleAssignment.assignDefaultRole(c, "CRM", A);
    expect(c.roles.map(String)).toEqual([ID.reo]);
    const p = mkUser("y", "PORTAL", []);
    await roleAssignment.assignDefaultRole(p, "PORTAL", A);
    expect(p.roles.map(String)).toEqual([ID.nonMember]);
  });
});

describe("portalRoleSync (sign-in NON-MEMBER -> MEMBER upgrade)", () => {
  const nonMemberOnly = (userType) => {
    const u = mkUser("p", userType, []);
    u.roles = [{ equals: (o) => String(o) === ID.nonMember, toString: () => ID.nonMember }];
    return u;
  };

  test.each([["off"], ["shadow"], ["enforce"]])("%s: PORTAL user upgraded and saved", async (mode) => {
    setMode(mode);
    const u = nonMemberOnly("PORTAL");
    const r = await syncPortalUserRolesFromMembership(u, "m@example.test", A);
    expect(r.assignedMemberFromCheck).toBe(true);
    expect(u.save).toHaveBeenCalledTimes(1);
  });

  test("enforce: a non-PORTAL user is not upgraded and not saved", async () => {
    setMode("enforce");
    const u = nonMemberOnly("CRM");
    const r = await syncPortalUserRolesFromMembership(u, "m@example.test", A);
    expect(r.assignedMemberFromCheck).toBe(false);
    expect(u.save).not.toHaveBeenCalled();
  });
});

describe("RabbitMQ listeners: refusal leaves no change, including redelivery", () => {
  const OID = "64f000000000000000000001";
  const LISTENERS = [
    ["application approval", () => handleApplicationApproved({ data: { applicationId: "app-1", tenantId: A, userId: OID } }), ID.member],
    ["membership promotion", () => handlePortalMemberPromotion({ data: { tenantId: A, userId: OID, profileId: "p1", subscriptionId: "s1" } }, { routingKey: "members.subscription.current.updated.v1" }), ID.member],
    ["membership demotion", () => handlePortalMemberDemotion({ data: { tenantId: A, userId: OID, profileId: "p1", subscriptionId: "s1" } }, { routingKey: "members.subscription.resigned.v1" }), ID.nonMember],
  ];

  test.each(LISTENERS)("%s: PORTAL user updated in every mode; redelivery is idempotent", async (_n, deliver, roleId) => {
    for (const mode of ["off", "shadow", "enforce"]) {
      setMode(mode);
      mockListenerUser = mkUser(OID, "PORTAL", [ID.reo]);
      await deliver();
      await deliver();
      expect(mockListenerUser.save).toHaveBeenCalledTimes(2);
      expect(mockListenerUser.roles.map(String)).toEqual([roleId]);
    }
  });

  test.each(LISTENERS)("%s: user whose stored type is not PORTAL -> enforce never saves, across retries", async (_n, deliver) => {
    setMode("enforce");
    mockListenerUser = mkUser(OID, "CRM", [ID.reo]);
    await deliver();
    await deliver();
    await deliver();
    expect(mockListenerUser.save).not.toHaveBeenCalled();
    expect(mockListenerUser.roles).toEqual([ID.reo]);
    expect(classLogs().filter((l) => l.outcome === "assignment_refused")).toHaveLength(3);
  });

  test.each(LISTENERS)("%s: same user in shadow -> today's outcome (saved) plus a shadow line", async (_n, deliver, roleId) => {
    setMode("shadow");
    mockListenerUser = mkUser(OID, "CRM", [ID.reo]);
    await deliver();
    expect(mockListenerUser.save).toHaveBeenCalledTimes(1);
    expect(mockListenerUser.roles.map(String)).toEqual([roleId]);
    expect(classLogs()).toEqual([expect.objectContaining({ event: "role.class.shadow", outcome: "assignment_would_be_refused" })]);
  });
});
