/**
 * Phase 1C-2M — category (user-type) denial keeps its intended reason.
 *
 * evaluateResourcePolicy's category-check log referenced `action`, which is not in that function's
 * scope. Every category denial therefore threw a ReferenceError inside the try block and was
 * reported as RESOURCE_EVALUATION_ERROR instead of INVALID_USER_TYPE. The decision was DENY either
 * way; only the reason (and a misleading error log) differed.
 *
 * Uses the REAL applyPolicyRules with a stubbed permission catalogue / role hierarchy / cache.
 */
const CATALOGUE = [
  { code: "CRMONLY_READ", resource: "crmonly", action: "read", category: "CRM" },
  { code: "CRMONLY_DELETE", resource: "crmonly", action: "delete", category: "CRM" },
  { code: "PORTALONLY_READ", resource: "portalonly", action: "read", category: "PORTAL" },
  { code: "SHARED_READ", resource: "shared", action: "read", category: "COMMUNICATION" },
  { code: "TENANT_READ", resource: "tenant", action: "read", category: "CRM" },
];

jest.mock("../services/roleHierarchyService", () => ({
  isSuperUser: (roles) => !!roles && roles.includes("SU"),
  isAssistantSuperUser: (roles) => !!roles && roles.includes("ASU"),
  getHighestRoleLevel: async () => 1,
}));
jest.mock("../services/permissionsService", () => ({
  getAllPermissions: async () => CATALOGUE,
  getPermissionsByResource: async (r) => CATALOGUE.filter((p) => p.resource.toLowerCase() === r.toLowerCase()),
}));
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
  resource: "crmonly",
  action: "read",
  tenantId: TA,
  userTenantId: TA,
  userType: "CRM",
  ...o,
});

let errorSpy;
beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("1/6 the category-denial path returns its intended reason (no exception)", () => {
  test("PORTAL user holding crmonly:read on a CRM-only resource -> DENY INVALID_USER_TYPE", async () => {
    const d = await applyPolicyRules(ctx({ userType: "PORTAL", permissions: ["crmonly:read"] }));
    expect(d).toMatchObject({
      decision: "DENY",
      reason: "INVALID_USER_TYPE",
      allowedCategories: ["CRM", "CRM"],
      userTypeCategory: "PORTAL",
    });
    expect(d.reason).not.toBe("RESOURCE_EVALUATION_ERROR");
    expect(errorSpy).not.toHaveBeenCalled(); // no "Error in resource policy evaluation: ReferenceError"
  });

  test.each([
    ["MEMBER", ["crmonly:read"], "crmonly"],
    ["CRM", ["portalonly:read"], "portalonly"],
    [undefined, ["CRMONLY_READ"], "crmonly"], // unknown user type -> GENERAL category; code-format permission
    ["SYSTEM", ["*"], "crmonly"],
  ])("userType %p with %p on %p -> DENY INVALID_USER_TYPE", async (userType, permissions, resource) => {
    const d = await applyPolicyRules(ctx({ userType, permissions, resource }));
    expect(d).toMatchObject({ decision: "DENY", reason: "INVALID_USER_TYPE" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("tenant resource, non-SU/ASU PORTAL user: category denial also keeps its reason", async () => {
    const d = await applyPolicyRules(ctx({ userType: "PORTAL", resource: "tenant", permissions: ["tenant:read"] }));
    expect(d).toMatchObject({ decision: "DENY", reason: "INVALID_USER_TYPE" });
  });

  test("the category-failure log line still names the resource and the action from the request", async () => {
    await applyPolicyRules(ctx({ userType: "PORTAL", permissions: ["crmonly:read"], action: "read" }));
    const logged = console.log.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain("Category check failed for crmonly:read");
  });
});

describe("2 permitted category cases remain PERMIT", () => {
  test("CRM user on a CRM resource", async () => {
    expect((await applyPolicyRules(ctx({ permissions: ["crmonly:read"] }))).decision).toBe("PERMIT");
  });
  test("PORTAL user on a PORTAL resource", async () => {
    expect((await applyPolicyRules(ctx({ userType: "PORTAL", resource: "portalonly", permissions: ["portalonly:read"] }))).decision).toBe("PERMIT");
  });
  test("PORTAL user on a shared-category resource", async () => {
    expect((await applyPolicyRules(ctx({ userType: "PORTAL", resource: "shared", permissions: ["shared:read"] }))).decision).toBe("PERMIT");
  });
});

describe("3 normal resource/action denials unchanged", () => {
  test("no permission for the resource -> INSUFFICIENT_RESOURCE_PERMISSION", async () => {
    expect(await applyPolicyRules(ctx({ permissions: [] }))).toMatchObject({ decision: "DENY", reason: "INSUFFICIENT_RESOURCE_PERMISSION" });
  });
  test("resource permission but not the action -> MISSING_PERMISSION", async () => {
    expect(await applyPolicyRules(ctx({ action: "delete", permissions: ["crmonly:read"] }))).toMatchObject({ decision: "DENY", reason: "MISSING_PERMISSION" });
  });
  test("unknown resource -> UNKNOWN_RESOURCE", async () => {
    expect(await applyPolicyRules(ctx({ resource: "nope", permissions: ["*"] }))).toMatchObject({ decision: "DENY", reason: "UNKNOWN_RESOURCE" });
  });
});

describe("4 SU bypass unchanged", () => {
  test("SU with a PORTAL user type on a CRM-only resource -> PERMIT SUPER_USER_BYPASS", async () => {
    expect(await applyPolicyRules(ctx({ roles: ["SU"], userType: "PORTAL" }))).toMatchObject({ decision: "PERMIT", reason: "SUPER_USER_BYPASS" });
  });
});

describe("5 tenant-scoped behaviour unchanged", () => {
  test("missing tenant context -> MISSING_TENANT_CONTEXT", async () => {
    expect(await applyPolicyRules(ctx({ tenantId: null, userType: "PORTAL", permissions: ["crmonly:read"] }))).toMatchObject({ decision: "DENY", reason: "MISSING_TENANT_CONTEXT" });
  });
  test("ASU on the tenant resource: own tenant PERMIT, other tenant TENANT_SCOPE_VIOLATION", async () => {
    expect(await applyPolicyRules(ctx({ roles: ["ASU"], resource: "tenant", permissions: ["tenant:read"] }))).toMatchObject({ decision: "PERMIT", reason: "POLICY_SATISFIED" });
    expect(await applyPolicyRules(ctx({ roles: ["ASU"], resource: "tenant", permissions: ["tenant:read"], tenantId: TB }))).toMatchObject({ decision: "DENY", reason: "TENANT_SCOPE_VIOLATION" });
  });
});

test("6 no request in a broad matrix produces RESOURCE_EVALUATION_ERROR", async () => {
  const seen = new Set();
  for (const userType of ["CRM", "PORTAL", "MEMBER", "SYSTEM", undefined, "WEIRD"])
    for (const roles of [[], ["MANAGER"], ["ASU"], ["SU"]])
      for (const resource of ["crmonly", "portalonly", "shared", "tenant", "nope"])
        for (const action of ["read", "delete", "frobnicate"])
          for (const permissions of [[], [`${resource}:${action}`], ["*"], ["CRMONLY_READ"]]) {
            const d = await applyPolicyRules(ctx({ userType, roles, resource, action, permissions }));
            seen.add(d.reason);
          }
  expect(seen.has("RESOURCE_EVALUATION_ERROR")).toBe(false);
  expect(seen.has("INVALID_USER_TYPE")).toBe(true);
  expect(errorSpy).not.toHaveBeenCalled();
});
