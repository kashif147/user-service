/**
 * Phase B / Z3 - wildcard redesign + platform permission namespace reservation.
 *
 * Invariant: "*" may stand for every TENANT permission (inside the caller's tenant), never for a
 * platform:* permission; no tenant role may hold a platform:* permission (today's catalogue or a future
 * code), whoever the actor is (legacy SU included).
 *
 * Covers constants/permissionClassification.js, the tenant PDP (REAL applyPolicyRules, mocked catalogue),
 * permissionsService, and the role API boundary (REAL role.handler + controllers, mocked models).
 * The model-level write guards are in platformNamespace.z3.models.test.js.
 */
const A = "68cbf7806080b4621d469d34";
const B = "6acd6119b28a863c61361ae0";
const OID_PLATFORM = "444444444444444444444444"; // a catalogue entry that (illegally) resolves to platform:*
const OID_USER_READ = "555555555555555555555555";

jest.mock("../services/roleHierarchyService", () => ({
  isSuperUser: (roles) => Array.isArray(roles) && roles.some((r) => (typeof r === "string" ? r : r?.code) === "SU"),
  isAssistantSuperUser: (roles) => Array.isArray(roles) && roles.includes("ASU"),
  getHighestRoleLevel: async () => 0,
}));
jest.mock("../services/cacheService", () => ({ get: async () => null, set: async () => {}, del: async () => {}, delete: async () => {} }));
jest.mock("../services/policyCache", () =>
  function () {
    return { initialize: async () => {}, get: async () => null, set: async () => {}, getStats: async () => ({}) };
  }
);
const mockCatalogue = [
  { code: "USER_READ", resource: "user", action: "read", category: "CRM" },
  { code: "USER_WRITE", resource: "user", action: "write", category: "CRM" },
  { code: "TENANT_READ", resource: "tenant", action: "read", category: "CRM" },
  { code: "ROLE_READ", resource: "role", action: "read", category: "CRM" },
];
jest.mock("../services/permissionsService", () => {
  const actual = jest.requireActual("../services/permissionsService");
  actual.getAllPermissions = async () => mockCatalogue;
  actual.getPermissionsByResource = async (r) => mockCatalogue.filter((p) => p.resource.toLowerCase() === String(r).toLowerCase());
  return actual;
});

const mockRoles = {
  rPlain: { _id: "rPlain", code: "PLAIN", isSystemRole: false, permissions: ["user:read"] },
  "507f1f77bcf86cd799439011": { _id: "507f1f77bcf86cd799439011", code: "PLAIN2", isSystemRole: false, permissions: [] },
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
  Role.find = async () => [];
  return Role;
});
const mockCatalogueLookups = [];
jest.mock("../models/permission.model", () => ({
  findById: async () => null,
  findOne: async () => null,
  find: (q) => ({
    select: async () =>
      [
        { _id: "444444444444444444444444", resource: "platform", action: "tenant:create" },
        { _id: "555555555555555555555555", resource: "user", action: "read" },
      ].filter((d) => q._id.$in.includes(d._id)),
  }),
}));
jest.mock("../models/user.model", () => ({}));
jest.mock("../models/tenant.model", () => ({}));
jest.mock("../handlers/permission.handler", () => ({
  getPermissionByCode: async (code) => (mockCatalogueLookups.push(code), {}),
}));

const C = require("../constants/permissionClassification");
const { PLATFORM_PERMISSIONS } = require("../constants/platformPermissions");
const { applyPolicyRules } = require("../services/policyEvaluationService");
const permissionsService = require("../services/permissionsService");
const RoleHandler = require("../handlers/role.handler");
const RoleController = require("../controllers/role.controller");
const TenantScopedController = require("../controllers/tenantScoped.controller");
const { RolePrivilegeError } = require("../errors/RolePrivilegeError");

const SU = { roles: ["SU"] };
const ASU = { roles: ["ASU"] };
const FUTURE = ["platform:test:future", "PLATFORM_TEST_FUTURE", " Platform:Test:Future ", "platform", "platform:*", "PLATFORM:anything", "platform.billing:read"];
const LISTED = ["platform:tenant:create", "platform:tenant:read:any", "platform:cache:admin", "platform:principals:manage"];

beforeEach(() => {
  mockWrites.length = 0;
  mockSaved.length = 0;
  mockCatalogueLookups.length = 0;
  for (const m of ["log", "warn", "error", "info"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("classification (constants/permissionClassification.js)", () => {
  test("the namespace is a rule: every current catalogue code and every future platform:* code is PLATFORM", () => {
    for (const p of [...PLATFORM_PERMISSIONS, ...FUTURE]) expect([p, C.classifyPermission(p)]).toEqual([p, "PLATFORM"]);
  });
  test("tenant codes stay TENANT, legacy reserved codes stay RESERVED", () => {
    for (const p of ["user:read", "USER_READ", "tenant:read", "tenant:admin", "payments:*", "platforms:read", "platform-ops:read", "my.platform:read"]) {
      expect([p, C.classifyPermission(p)]).toEqual([p, "TENANT"]);
    }
    for (const p of ["*", "admin:write", "permission:create", "tenant:create", "role:super_admin", "lookup:write", "LOOKUPTYPE_WRITE"]) {
      expect([p, C.classifyPermission(p)]).toEqual([p, "RESERVED"]);
    }
  });
  test("non-strings are never platform and never throw", () => {
    for (const p of [null, undefined, 1, {}, []]) expect(C.isPlatformNamespace(p)).toBe(false);
  });
  test("malformed wildcards", () => {
    for (const p of ["*:*", "*:read", "pay*:read", "**", "user:re*d", "platform*"]) expect([p, C.isMalformedWildcard(p)]).toEqual([p, true]);
    for (const p of ["*", " * ", "payments:*", "user:read"]) expect([p, C.isMalformedWildcard(p)]).toEqual([p, false]);
  });
});

describe("tenant wildcard semantics (tenantPermissionGranted)", () => {
  test('"*" satisfies any tenant permission', () => {
    for (const p of ["user:read", "tenant:admin", "payments:write", "issues-complaints:read"]) expect(C.tenantPermissionGranted(["*"], p)).toBe(true);
  });
  test('"*" never satisfies a platform permission - current or future, any spelling', () => {
    for (const p of [...PLATFORM_PERMISSIONS, ...FUTURE]) expect([p, C.tenantPermissionGranted(["*"], p)]).toEqual([p, false]);
  });
  test("an explicit tenant permission works; an explicit platform code in tenant permissions is never honoured", () => {
    expect(C.tenantPermissionGranted(["user:read"], "user:read")).toBe(true);
    expect(C.tenantPermissionGranted(["user:read"], "user:write")).toBe(false);
    expect(C.tenantPermissionGranted(["platform:cache:admin", "*"], "platform:cache:admin")).toBe(false);
  });
});

describe("tenant PDP (applyPolicyRules)", () => {
  const ctx = (o) => ({ roles: [], permissions: [], resource: "user", action: "read", tenantId: A, userTenantId: A, userType: "CRM", ...o });
  const decide = async (o) => applyPolicyRules(ctx(o));

  test('"*" holder (non-SU): tenant resource PERMIT in own tenant', async () => {
    expect((await decide({ permissions: ["*"] })).decision).toBe("PERMIT");
  });
  test("explicit tenant permission PERMIT; missing DENY", async () => {
    expect((await decide({ permissions: ["user:read"] })).decision).toBe("PERMIT");
    expect((await decide({ permissions: ["role:read"] })).decision).toBe("DENY");
  });
  test.each([
    ["platform", "read"], ["platform", "write"], ["platform", "admin"], ["PLATFORM", "read"], ["platform.billing", "read"],
  ])("platform resource %s:%s is never tenant-evaluable: SU '*' own tenant, '*' holder, ASU -> DENY", async (resource, action) => {
    for (const who of [{ roles: ["SU"], permissions: ["*"] }, { roles: ["MO"], permissions: ["*"] }, { roles: ["ASU"], permissions: ["*", "platform:read"] }]) {
      const d = await decide({ ...who, resource, action });
      expect(d).toEqual({ decision: "DENY", reason: "PLATFORM_PERMISSION_NOT_TENANT_EVALUABLE" });
    }
  });
  test("legacy SU stays tenant-confined: own tenant PERMIT, another tenant DENY (tenant boundary before wildcard)", async () => {
    expect((await decide({ roles: ["SU"], permissions: ["*"] })).reason).toBe("SUPER_USER_OWN_TENANT");
    expect(await decide({ roles: ["SU"], permissions: ["*"], tenantId: B })).toEqual({ decision: "DENY", reason: "TENANT_SCOPE_VIOLATION" });
  });
  test("ASU unchanged: own tenant via permission; tenant resource for another tenant still denied", async () => {
    expect((await decide({ roles: ["ASU"], permissions: ["tenant:read"], resource: "tenant", action: "read" })).decision).toBe("PERMIT");
    expect((await decide({ roles: ["ASU"], permissions: ["tenant:read", "*"], resource: "tenant", action: "read", tenantId: B })).decision).toBe("DENY");
  });
});

describe("permissionsService (tenant evaluation)", () => {
  test('"*" covers tenant codes, never platform codes', async () => {
    jest.spyOn(permissionsService, "getEffectivePermissions").mockResolvedValue(["*"]);
    expect(await permissionsService.hasPermission(["X"], "user:read", A)).toBe(true);
    expect(await permissionsService.hasPermission(["X"], "platform:cache:admin", A)).toBe(false);
    expect(await permissionsService.hasAnyPermission(["X"], ["platform:test:future", "user:read"], A)).toBe(true);
    expect(await permissionsService.hasAnyPermission(["X"], ["platform:test:future"], A)).toBe(false);
    expect(await permissionsService.hasAllPermissions(["X"], ["platform:test:future", "user:read"], A)).toBe(false);
    expect(await permissionsService.hasAnyPermission(["X"], [], A)).toBe(true); // unchanged edge
  });
});

describe("role API boundary: no actor may put a platform code on a tenant role", () => {
  const rejects = (p) => expect(p).rejects.toBeInstanceOf(RolePrivilegeError);
  const ALL = [...LISTED, ...FUTURE];

  test.each(ALL)("createRole %p: refused for SU and ASU", async (perm) => {
    for (const actor of [SU, ASU]) {
      await rejects(RoleHandler.createRole({ name: "N", code: "N", description: "d", category: "CRM", permissions: ["user:read", perm] }, A, "u", actor));
    }
    expect(mockSaved).toHaveLength(0);
  });
  test.each(ALL)("updateRole / updateRolePermissions %p: refused for SU and ASU", async (perm) => {
    for (const actor of [SU, ASU]) {
      await rejects(RoleHandler.updateRole("rPlain", { permissions: ["user:read", perm] }, A, "u", actor));
      await rejects(RoleHandler.updateRolePermissions("507f1f77bcf86cd799439011", [perm], A, "u", actor));
    }
    expect(mockWrites).toHaveLength(0);
  });
  test("an ObjectId entry resolving to a platform code is refused, even for SU", async () => {
    await rejects(RoleHandler.createRole({ name: "N", code: "N", description: "d", category: "CRM", permissions: [OID_PLATFORM] }, A, "u", SU));
  });
  test("a single string (Mongoose would cast it to an array) is checked too", async () => {
    await rejects(RoleHandler.createRole({ name: "N", code: "N", description: "d", category: "CRM", permissions: "platform:test:future" }, A, "u", SU));
    await rejects(RoleHandler.createRole({ name: "N", code: "N", description: "d", category: "CRM", permissions: "*" }, A, "u", ASU));
  });
  test('"*" on a tenant role cannot coexist with a platform code (SU)', async () => {
    await rejects(RoleHandler.createRole({ name: "N", code: "N", description: "d", category: "CRM", permissions: ["*", "platform:cache:admin"] }, A, "u", SU));
  });
  test("malformed wildcards are refused for every actor", async () => {
    for (const p of ["*:*", "*:read", "pay*:read"]) {
      await rejects(RoleHandler.createRole({ name: "N", code: "N", description: "d", category: "CRM", permissions: [p] }, A, "u", SU));
    }
  });
  test("legitimate tenant permissions still grant (SU and ASU); SU may still grant the tenant wildcard", async () => {
    await RoleHandler.createRole({ name: "N", code: "N", description: "d", category: "CRM", permissions: ["user:read", OID_USER_READ, "payments:*"] }, A, "u", ASU);
    await RoleHandler.createRole({ name: "N", code: "N", description: "d", category: "CRM", permissions: ["*"] }, A, "u", SU);
    await RoleHandler.updateRolePermissions("507f1f77bcf86cd799439011", ["user:read", "user:write"], A, "u", ASU);
    expect(mockSaved).toHaveLength(2);
    expect(mockWrites).toHaveLength(1);
  });
  test("non-SU still cannot add '*' (legacy rule unchanged)", async () => {
    await rejects(RoleHandler.createRole({ name: "N", code: "N", description: "d", category: "CRM", permissions: ["*"] }, A, "u", ASU));
  });
  test("connection default roles: a platform code makes a role RESERVED_PERMISSION", () => {
    expect(RoleHandler.isReservedPermission("platform:test:future")).toBe(true);
    expect(RoleHandler.isReservedPermission("user:read")).toBe(false);
  });
});

describe("HTTP mapping: 403 ROLE_PRIVILEGE_VIOLATION", () => {
  const res = () => {
    const r = { statusCode: null, body: null };
    r.status = (c) => ((r.statusCode = c), r);
    r.json = (b) => ((r.body = b), r);
    r.success = (b) => ((r.statusCode = 200), (r.body = b), r);
    r.sendBadRequest = (m) => ((r.statusCode = 400), (r.body = m), r);
    r.notFoundRecord = (m) => ((r.statusCode = 404), (r.body = m), r);
    return r;
  };
  test("tenant-scoped (ASU) permissions route: 403 before any catalogue lookup", async () => {
    const r = res();
    await TenantScopedController.assignPermissionsToRoleInTenant(
      { params: { id: "rPlain" }, body: { permissions: ["platform:test:future"] }, ctx: { tenantId: A, userId: "u", roles: ["ASU"] } },
      r
    );
    expect(r.statusCode).toBe(403);
    expect(r.body.code).toBe("ROLE_PRIVILEGE_VIOLATION");
    expect(mockCatalogueLookups).toHaveLength(0);
  });
  test("SU role routes: createRole / updateRolePermissions -> AppError 403 ROLE_PRIVILEGE_VIOLATION", async () => {
    for (const [fn, req] of [
      [RoleController.createRole, { body: { name: "N", code: "N", description: "d", category: "CRM", permissions: ["platform:tenant:create"] } }],
      [RoleController.updateRolePermissions, { params: { id: "507f1f77bcf86cd799439011" }, body: { permissions: ["platform:test:future"] } }],
    ]) {
      const next = jest.fn();
      await fn({ ...req, ctx: { tenantId: A, userId: "u", roles: ["SU"] } }, res(), next);
      const err = next.mock.calls[0][0];
      expect([err.status ?? err.statusCode, err.code ?? err.details?.code]).toEqual([403, "ROLE_PRIVILEGE_VIOLATION"]);
    }
  });
});
