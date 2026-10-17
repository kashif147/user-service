/**
 * CRM Microsoft-token containment - role mutation responses never carry the target user's stored
 * OAuth tokens (or password) to the administrator's browser.
 *
 *   POST /users/assign-role(s)     -> RoleController.assignRolesToUser
 *   POST /users/sync-roles         -> RoleController.syncRolesForUser
 *   POST /users/remove-roles-batch -> RoleController.removeRolesFromUser
 *   POST /users/remove-role        -> RoleController.removeRoleFromUser
 *   POST /tenant/users/assign-role -> TenantScopedController.assignRoleToUserInTenant
 *   POST /tenant/users/remove-role -> TenantScopedController.removeRoleFromUserInTenant
 * Models are mocked (as in roleAssignment.privilege.test.js); the user documents carry legacy
 * stored Microsoft tokens.
 */
const A = "68cbf7806080b4621d469d34";
const B = "aaaaaaaaaaaaaaaaaaaaaaaa";
const ID = { ord1: "a00000000000000000000004", ord2: "a00000000000000000000005", target: "c00000000000000000000002", otherTenantUser: "d00000000000000000000001" };
const SECRET = { id: "STORED-MS-ID-TOKEN", refresh: "STORED-MS-REFRESH-TOKEN", password: "STORED-PASSWORD-HASH" };

const mockRoleRows = [
  { _id: "a00000000000000000000004", tenantId: "68cbf7806080b4621d469d34", code: "BRO", isSystemRole: false, isActive: true, permissions: [] },
  { _id: "a00000000000000000000005", tenantId: "68cbf7806080b4621d469d34", code: "IO", isSystemRole: false, isActive: true, permissions: [] },
];
const mockUsers = {};
jest.mock("../models/role.model", () => ({
  find: async (q) => mockRoleRows.filter((r) => q._id.$in.map(String).includes(r._id) && r.tenantId === q.tenantId && (q.isActive === undefined || r.isActive === q.isActive)),
  findOne: async (q) => {
    const r = mockRoleRows.find((x) => x._id === String(q._id) && x.tenantId === q.tenantId);
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

const RoleController = require("../controllers/role.controller");
const TenantScopedController = require("../controllers/tenantScoped.controller");
const { safeUserResponse } = require("../handlers/role.handler");

// A mongoose-like document: toObject() returns every stored field, including the credentials.
function userDoc(id, tenantId) {
  const doc = {
    _id: id, tenantId, userEmail: `${id}@x.org`, userType: "CRM", userMicrosoftId: "oid-1", roles: [ID.ord2],
    password: SECRET.password,
    tokens: { id_token: SECRET.id, refresh_token: SECRET.refresh, refresh_token_expires_at: null },
    save: jest.fn(async function save() { return this; }),
  };
  doc.toObject = () => { const { save, toObject, ...rest } = doc; return JSON.parse(JSON.stringify(rest)); };
  return doc;
}
const mkRes = () => {
  const r = { statusCode: null, body: null };
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  r.success = (d) => r.status(200).json(d);
  r.sendBadRequest = (m) => r.status(400).json({ message: m });
  r.sendInternalError = (m) => r.status(500).json({ message: m });
  r.notFoundRecord = (m) => r.status(404).json({ message: m });
  return r;
};
const ctx = { tenantId: A, userId: "c00000000000000000000001", roles: ["ASU"] };
async function call(ctl, fn, body) {
  const res = mkRes();
  const next = jest.fn();
  await ctl[fn]({ ctx, body, params: {} }, res, next);
  return { res, err: next.mock.calls[0]?.[0] };
}
function assertNoCredentials(body) {
  const json = JSON.stringify(body);
  for (const v of Object.values(SECRET)) expect(json).not.toContain(v);
  const keys = [];
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
  })(body);
  for (const k of ["tokens", "refresh_token", "id_token", "password"]) expect(keys).not.toContain(k);
}

beforeEach(() => {
  mockUsers[ID.target] = userDoc(ID.target, A);
  mockUsers[ID.otherTenantUser] = userDoc(ID.otherTenantUser, B);
  for (const m of ["log", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test.each([
  ["assign", RoleController, "assignRolesToUser", { userId: ID.target, roleIds: [ID.ord1] }, [ID.ord2, ID.ord1]],
  ["sync", RoleController, "syncRolesForUser", { userId: ID.target, roleIds: [ID.ord1] }, [ID.ord1]],
  ["remove batch", RoleController, "removeRolesFromUser", { userId: ID.target, roleIds: [ID.ord2] }, []],
  ["remove", RoleController, "removeRoleFromUser", { userId: ID.target, roleId: ID.ord2 }, []],
  ["tenant-scoped assign", TenantScopedController, "assignRoleToUserInTenant", { userId: ID.target, roleId: ID.ord1 }, [ID.ord2, ID.ord1]],
  ["tenant-scoped remove", TenantScopedController, "removeRoleFromUserInTenant", { userId: ID.target, roleId: ID.ord2 }, []],
])("%s: 200, correct user, roles changed, and no stored OAuth token / password in the response", async (_l, ctl, fn, body, expectedRoles) => {
  const { res, err } = await call(ctl, fn, body);
  expect(err).toBeUndefined();
  expect(res.statusCode).toBe(200);
  assertNoCredentials(res.body);
  const json = JSON.stringify(res.body);
  expect(json).toContain(ID.target); // the right user, otherwise compatible
  expect(json).toContain(`${ID.target}@x.org`);
  expect(mockUsers[ID.target].roles.map(String)).toEqual(expectedRoles);
  // the stored document itself is untouched apart from its roles (the mapper copies)
  expect(mockUsers[ID.target].tokens.refresh_token).toBe(SECRET.refresh);
});

test("tenant isolation unchanged: a user of another tenant is not found and nothing is returned", async () => {
  const { res, err } = await call(RoleController, "assignRolesToUser", { userId: ID.otherTenantUser, roleIds: [ID.ord1] });
  expect(res.statusCode === 200).toBe(false);
  expect(err || res.body).toBeTruthy();
  assertNoCredentials(res.body || {});
  expect(mockUsers[ID.otherTenantUser].roles.map(String)).toEqual([ID.ord2]);
});

test("safeUserResponse: plain copy without tokens / password; null stays null", () => {
  const out = safeUserResponse(userDoc(ID.target, A));
  expect(out).not.toHaveProperty("tokens");
  expect(out).not.toHaveProperty("password");
  expect(out).toMatchObject({ _id: ID.target, userEmail: `${ID.target}@x.org`, userMicrosoftId: "oid-1" });
  expect(safeUserResponse(null)).toBeNull();
  const plain = { _id: "x", tokens: { refresh_token: "r" } };
  expect(safeUserResponse(plain)).toEqual({ _id: "x" });
  expect(plain.tokens.refresh_token).toBe("r"); // input not mutated
});
