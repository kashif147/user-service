/**
 * Phase 1C-2G — PDP decisions no longer consult tenant-less, role-CODE-keyed maps.
 *
 * Removed fallbacks in services/policyEvaluationService.js:
 *  - rule 3 (resource): permissionsService.hasAnyPermission(roles, …)   (role code -> permissions)
 *  - rule 4 (action):   roleHierarchyService.getHighestRoleLevel(roles)  (role code -> level)
 * Final decisions depend on trusted tenant context, the tenant-scoped token permissions, and the
 * SU code bypass. Uses the REAL applyPolicyRules with mocked permission catalogue / caches; the
 * removed lookups are spies that must never be called.
 */
const mockLevel = { value: 0 };
const mockHasAny = jest.fn(async () => true); // worst case: a same-code role elsewhere "has" everything
const mockLevelSpy = jest.fn(async () => mockLevel.value);

jest.mock("../services/roleHierarchyService", () => ({
  isSuperUser: (roles) => !!roles && roles.includes("SU"),
  isAssistantSuperUser: (roles) => !!roles && roles.includes("ASU"),
  getHighestRoleLevel: (...a) => mockLevelSpy(...a),
}));
jest.mock("../services/permissionsService", () => {
  const perms = [
    { code: "LOOKUP_READ", resource: "lookup", action: "read", category: "CRM" },
    { code: "LOOKUP_DELETE", resource: "lookup", action: "delete", category: "CRM" },
    { code: "LOOKUP_ADMIN", resource: "lookup", action: "admin", category: "CRM" },
    { code: "TENANT_READ", resource: "tenant", action: "read", category: "CRM" },
  ];
  return {
    getAllPermissions: async () => perms,
    getPermissionsByResource: async (r) => perms.filter((p) => p.resource.toLowerCase() === r.toLowerCase()),
    hasAnyPermission: (...a) => mockHasAny(...a),
  };
});
jest.mock("../services/policyCache", () =>
  function () {
    return { initialize: async () => {}, get: async () => null, set: async () => {}, getStats: async () => ({}) };
  }
);

const { applyPolicyRules } = require("../services/policyEvaluationService");

const TA = "68cbf7806080b4621d469d34";
const TB = "aaaaaaaaaaaaaaaaaaaaaaaa";
const ctx = (o = {}) => ({
  roles: ["MANAGER"],
  permissions: [],
  resource: "lookup",
  action: "delete",
  tenantId: TA,
  userTenantId: TA,
  userType: "CRM",
  ...o,
});
const decide = async (o) => (await applyPolicyRules(ctx(o))).decision;

beforeEach(() => {
  mockHasAny.mockClear();
  mockLevelSpy.mockClear();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  // the removed global-map lookups are never consulted
  expect(mockLevelSpy).not.toHaveBeenCalled();
  expect(mockHasAny).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

describe("A/B role level never changes the outcome", () => {
  test.each([0, 1, 30, 60, 80, 95, 100])("level %p: without lookup:delete -> DENY; with it -> PERMIT", async (lvl) => {
    mockLevel.value = lvl;
    expect(await decide({ permissions: [] })).toBe("DENY");
    expect(await decide({ permissions: ["lookup:read"] })).toBe("DENY");
    expect(await decide({ permissions: ["lookup:delete"] })).toBe("PERMIT");
  });

  test.each(["read", "delete", "admin"])("action %s: permitted only by the exact permission (or *)", async (action) => {
    expect(await decide({ action, permissions: [] })).toBe("DENY");
    expect(await decide({ action, permissions: [`lookup:${action}`] })).toBe("PERMIT");
    expect(await decide({ action, permissions: ["*"] })).toBe("PERMIT");
  });
});

describe("C shared role code in another tenant cannot affect the result", () => {
  test("a same-code role elsewhere 'having' every permission (hasAnyPermission -> true) is irrelevant", async () => {
    mockHasAny.mockResolvedValue(true);
    expect(await decide({ roles: ["MANAGER"], permissions: [] })).toBe("DENY");
    expect(await decide({ roles: ["MANAGER"], permissions: [], tenantId: TB, userTenantId: TB })).toBe("DENY");
  });
  test("result depends only on the caller's own token permissions", async () => {
    expect(await decide({ tenantId: TA, userTenantId: TA, permissions: ["lookup:delete"] })).toBe("PERMIT");
    expect(await decide({ tenantId: TB, userTenantId: TB, permissions: [] })).toBe("DENY");
  });
});

describe("D/E SU and ASU unchanged", () => {
  test("SU bypasses by code (no permissions, any level)", async () => {
    expect(await decide({ roles: ["SU"], permissions: [] })).toBe("PERMIT");
    expect(await decide({ roles: ["SU"], permissions: [], tenantId: null })).toBe("PERMIT");
  });
  test("ASU on the tenant resource: needs tenant:read; own tenant permitted", async () => {
    expect(await decide({ roles: ["ASU"], resource: "tenant", action: "read", permissions: ["tenant:read"] })).toBe("PERMIT");
    expect(await decide({ roles: ["ASU"], resource: "tenant", action: "read", permissions: [] })).toBe("DENY");
  });
  test("ASU gets no implicit permissions from its role code", async () => {
    expect(await decide({ roles: ["ASU"], permissions: [] })).toBe("DENY");
  });
});

describe("F/G other existing semantics", () => {
  test("missing tenant context still denied for non-SU", async () => {
    const d = await applyPolicyRules(ctx({ tenantId: null, permissions: ["lookup:delete"] }));
    expect(d).toMatchObject({ decision: "DENY", reason: "MISSING_TENANT_CONTEXT" });
  });
  test("unknown action still denied", async () => {
    const d = await applyPolicyRules(ctx({ action: "frobnicate", permissions: ["*"] }));
    expect(d.decision).toBe("DENY");
  });
  test("unknown resource still denied", async () => {
    const d = await applyPolicyRules(ctx({ resource: "nope", permissions: ["nope:delete"] }));
    expect(d).toMatchObject({ decision: "DENY", reason: "UNKNOWN_RESOURCE" });
  });
  test("deny reason for a missing action permission is MISSING_PERMISSION", async () => {
    const d = await applyPolicyRules(ctx({ permissions: ["lookup:read"] }));
    expect(d).toMatchObject({ decision: "DENY", reason: "MISSING_PERMISSION", requiredPermission: "lookup:delete" });
  });
  test("deny reason when the caller has no permission for the resource is INSUFFICIENT_RESOURCE_PERMISSION", async () => {
    const d = await applyPolicyRules(ctx({ permissions: [] }));
    expect(d).toMatchObject({ decision: "DENY", reason: "INSUFFICIENT_RESOURCE_PERMISSION" });
  });
});
