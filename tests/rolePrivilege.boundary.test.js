/**
 * Phase 1C-2B (M1) — role privilege boundary.
 *
 * Non-SU actors (roles from trusted req.ctx) cannot mint platform-admin access by editing role
 * definitions: reserved codes SU/ASU, system roles, isSystemRole, level >= 95, category SYSTEM and
 * reserved permissions ("*", platform catalogue / tenant creation / admin resource / :super_admin)
 * are SU-only. Covers createRole, updateRole, updateRolePermissions and their controllers
 * (incl. the ASU tenant-scoped permissions route). Models are mocked; no DB.
 */
const A = "68cbf7806080b4621d469d34";
const OID_TENANT_CREATE = "111111111111111111111111";
const OID_LOOKUP_READ = "222222222222222222222222";

const mockRoles = {
  rCustom: { _id: "rCustom", code: "CUSTOM", isSystemRole: false, permissions: ["role:read", "TENANT_CREATE"] },
  rPlain: { _id: "rPlain", code: "PLAIN", isSystemRole: false, permissions: ["role:read"] },
  rAsu: { _id: "rAsu", code: "ASU", isSystemRole: true, permissions: [] },
  rSu: { _id: "rSu", code: " su ", isSystemRole: false, permissions: [] },
  rSys: { _id: "rSys", code: "GS", isSystemRole: true, permissions: [] },
};
const mockWrites = [];
const mockSaved = [];

jest.mock("../models/role.model", () => {
  function Role(doc) {
    Object.assign(this, doc);
    this.save = async () => (mockSaved.push(doc), this);
  }
  Role.findOne = async (sel) => {
    const r = sel && mockRoles[sel._id] && sel.tenantId === "68cbf7806080b4621d469d34" ? mockRoles[sel._id] : null;
    return r ? { ...r, toObject: () => ({ ...r }) } : null;
  };
  Role.findOneAndUpdate = async (sel, update) => (mockWrites.push({ sel, update }), { _id: sel._id });
  return Role;
});
jest.mock("../models/permission.model", () => ({
  findById: async () => null,
  findOne: async () => null,
  find: (q) => ({
    select: async () =>
      [
        { _id: "111111111111111111111111", resource: "tenant", action: "create" },
        { _id: "222222222222222222222222", resource: "lookup", action: "read" },
      ].filter((d) => q._id.$in.includes(d._id)),
  }),
}));
jest.mock("../models/user.model", () => ({}));
jest.mock("../models/tenant.model", () => ({}));
jest.mock("../handlers/permission.handler", () => ({ getPermissionByCode: async () => ({}) }));

const RoleHandler = require("../handlers/role.handler");
const RoleController = require("../controllers/role.controller");
const TenantScopedController = require("../controllers/tenantScoped.controller");

const ASU = { roles: ["ASU"] };
const SU = { roles: ["SU"] };

beforeEach(() => {
  mockWrites.length = 0;
  mockSaved.length = 0;
});

const rejects = (p) => expect(p).rejects.toBeInstanceOf(RoleHandler.RolePrivilegeError);

describe("non-SU cannot cross the boundary (updateRole)", () => {
  test.each(["SU", "ASU", " su ", "asu"])("cannot rename a role to reserved code %p", async (code) => {
    await rejects(RoleHandler.updateRole("rCustom", { code }, A, "u1", ASU));
    expect(mockWrites).toHaveLength(0);
  });

  test.each(["rAsu", "rSu", "rSys"])("cannot modify protected role %s (ASU/SU code or isSystemRole)", async (id) => {
    await rejects(RoleHandler.updateRole(id, { description: "x" }, A, "u1", ASU));
    expect(mockWrites).toHaveLength(0);
  });

  test.each([95, 100, "100"])("cannot set platform-tier level %p", async (level) => {
    await rejects(RoleHandler.updateRole("rCustom", { level }, A, "u1", ASU));
  });

  test("cannot set category SYSTEM", async () => {
    await rejects(RoleHandler.updateRole("rCustom", { category: "system" }, A, "u1", ASU));
  });

  test.each([["*"], ["PERMISSION_ADMIN"], ["permission:create"], ["admin:write"], ["role:super_admin"], [OID_TENANT_CREATE]])(
    "cannot add reserved permission %p",
    async (perm) => {
      await rejects(RoleHandler.updateRole("rPlain", { permissions: ["role:read", perm] }, A, "u1", ASU));
      expect(mockWrites).toHaveLength(0);
    }
  );

  test("missing actor fails closed", async () => {
    await rejects(RoleHandler.updateRole("rCustom", { name: "x" }, A, "u1"));
  });
});

describe("legitimate tenant-level editing still works (non-SU)", () => {
  test("re-submitting a reserved permission the role already has (any form) is not a new grant", async () => {
    await RoleHandler.updateRole("rCustom", { permissions: ["role:read", OID_TENANT_CREATE] }, A, "u1", ASU);
    expect(mockWrites).toHaveLength(1);
  });

  test("name/description/code/level<95/category/permissions/isActive update; selector tenant-scoped; body tenantId ignored", async () => {
    await RoleHandler.updateRole(
      "rCustom",
      {
        name: "Branch Officer",
        description: "d",
        code: "BRO",
        level: 90,
        category: "CRM",
        isActive: true,
        // existing reserved permission (TENANT_CREATE) is kept, not "added"; lookup:read is new and ordinary
        permissions: ["role:read", "TENANT_CREATE", OID_LOOKUP_READ, "lookup:write"],
        tenantId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      },
      A,
      "u1",
      ASU
    );
    expect(mockWrites).toHaveLength(1);
    expect(mockWrites[0].sel).toEqual({ _id: "rCustom", tenantId: A });
    expect(mockWrites[0].update.$set).toMatchObject({ name: "Branch Officer", code: "BRO", level: 90, category: "CRM" });
    expect(mockWrites[0].update.$set).not.toHaveProperty("tenantId");
  });

  test("a role in another tenant is not found (tenant-scoped persisted read)", async () => {
    await expect(RoleHandler.updateRole("rCustom", { name: "x" }, "aaaaaaaaaaaaaaaaaaaaaaaa", "u1", ASU)).rejects.toThrow(/Role not found/);
  });
});

describe("SU retains platform-admin behaviour", () => {
  test("SU can rename to ASU, modify the ASU/system role, set level 100 and grant *", async () => {
    await RoleHandler.updateRole("rCustom", { code: "ASU", level: 100, permissions: ["*"] }, A, "u1", SU);
    await RoleHandler.updateRole("rAsu", { description: "x" }, A, "u1", SU);
    await RoleHandler.updateRole("rSys", { category: "SYSTEM" }, A, "u1", SU);
    expect(mockWrites).toHaveLength(3);
    expect(mockWrites.every((w) => w.update.$set.tenantId === undefined)).toBe(true);
  });
});

describe("createRole and updateRolePermissions share the boundary", () => {
  test.each([
    [{ code: "SU", name: "x" }],
    [{ code: "OK", name: "x", isSystemRole: true }],
    [{ code: "OK", name: "x", level: 99 }],
    [{ code: "OK", name: "x", permissions: ["*"] }],
  ])("non-SU createRole %p is rejected", async (body) => {
    await rejects(RoleHandler.createRole(body, A, "u1", ASU));
    expect(mockSaved).toHaveLength(0);
  });

  test("non-SU createRole of an ordinary role works; SU may create reserved", async () => {
    await RoleHandler.createRole({ code: "BRO", name: "x", level: 40, permissions: ["lookup:read"] }, A, "u1", ASU);
    await RoleHandler.createRole({ code: "ASU", name: "x", isSystemRole: true }, A, "u1", SU);
    expect(mockSaved).toHaveLength(2);
  });

  test("updateRolePermissions: non-SU cannot add *, cannot touch protected roles; ordinary change ok", async () => {
    const id = "aaaaaaaaaaaaaaaaaaaaaaab";
    mockRoles[id] = { _id: id, code: "CUSTOM", isSystemRole: false, permissions: ["role:read"] };
    const asu = "aaaaaaaaaaaaaaaaaaaaaaac";
    mockRoles[asu] = { _id: asu, code: "ASU", isSystemRole: true, permissions: [] };
    await rejects(RoleHandler.updateRolePermissions(id, ["role:read", "*"], A, "u1", ASU));
    await rejects(RoleHandler.updateRolePermissions(asu, ["role:read"], A, "u1", ASU));
    await RoleHandler.updateRolePermissions(id, ["role:read", "lookup:read"], A, "u1", ASU);
    expect(mockWrites).toHaveLength(1);
    expect(mockWrites[0].sel).toEqual({ _id: id, tenantId: A });
  });
});

describe("controllers map violations to 403 using trusted req.ctx roles", () => {
  const ctxReq = (roles, extra = {}) => ({ ctx: { tenantId: A, userId: "u1", roles }, params: {}, body: {}, ...extra });
  const mkRes = () => {
    const r = { statusCode: null, body: null };
    r.status = (c) => ((r.statusCode = c), r);
    r.json = (b) => ((r.body = b), r);
    r.notFoundRecord = () => r.status(404);
    r.success = (d) => r.status(200).json(d);
    return r;
  };

  test("role.controller update/create/permissions: ASU -> next(403); body roles cannot claim SU", async () => {
    const cases = [
      ["updateRole", ctxReq(["ASU"], { params: { id: "rCustom" }, body: { code: "SU", roles: ["SU"] } })],
      ["createRole", ctxReq(["ASU"], { body: { code: "ASU", name: "x" } })],
      ["updateRolePermissions", ctxReq(["ASU"], { params: { id: "aaaaaaaaaaaaaaaaaaaaaaab" }, body: { permissions: ["*"] } })],
    ];
    for (const [fn, req] of cases) {
      const next = jest.fn();
      await RoleController[fn](req, mkRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0]).toMatchObject({ status: 403, code: "ROLE_PRIVILEGE_VIOLATION" });
    }
    expect(mockWrites).toHaveLength(0);
    expect(mockSaved).toHaveLength(0);
  });

  test("tenantScoped assignPermissionsToRoleInTenant: ASU adding * -> 403, no write", async () => {
    const res = mkRes();
    await TenantScopedController.assignPermissionsToRoleInTenant(
      ctxReq(["ASU"], { params: { id: "aaaaaaaaaaaaaaaaaaaaaaab" }, body: { permissions: ["role:read", "*"] } }),
      res
    );
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("ROLE_PRIVILEGE_VIOLATION");
    expect(mockWrites).toHaveLength(0);
  });

  test("role.controller updateRole: SU succeeds", async () => {
    const res = mkRes();
    const next = jest.fn();
    await RoleController.updateRole(ctxReq(["SU"], { params: { id: "rAsu" }, body: { description: "x" } }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});

test("reserved-permission classifier", () => {
  const r = RoleHandler.isReservedPermission;
  for (const p of ["*", "tenant:create", "permission:admin", "permission:delete", "admin:read", "lookup:super_admin"]) expect(r(p)).toBe(true);
  for (const p of ["tenant:read", "tenant:update", "permission:read", "role:admin", "lookup:write", "user:read"]) expect(r(p)).toBe(false);
});
