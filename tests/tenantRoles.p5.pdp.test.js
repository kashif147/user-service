/**
 * P5 / D4-D5 - PDP proof for the proposed canonical REO and MO permission sets (config/tenantRoles.v1.json) versus
 * today's live DEV sets. REAL applyPolicyRules (user-service PDP that every requirePermission() in the platform calls);
 * the permission catalogue is the read-only DEV export in tests/fixtures (code / resource / action / category only).
 * Token permissions are built exactly as getUserPermissions does: catalogue code -> `${resource}:${action}` lower-cased.
 */
const FIXTURE = require("./fixtures/p5-dev-permission-catalogue.json");
const CATALOGUE = FIXTURE.catalogue.filter((p) => p.isActive);

jest.mock("../services/roleHierarchyService", () => ({
  isTenantAdmin: (roles) => !!roles && roles.includes("ASU"),
  isAssistantSuperUser: (roles) => !!roles && roles.includes("ASU"),
  getHighestRoleLevel: async () => 1,
}));
jest.mock("../services/permissionsService", () => ({
  getAllPermissions: async () => require("./fixtures/p5-dev-permission-catalogue.json").catalogue.filter((p) => p.isActive),
  getPermissionsByResource: async (r) => require("./fixtures/p5-dev-permission-catalogue.json").catalogue.filter((p) => p.isActive && p.resource.toLowerCase() === String(r).toLowerCase()),
}));
jest.mock("../services/policyCache", () => function () { return { initialize: async () => {}, get: async () => null, set: async () => {}, getStats: async () => ({}) }; });

const { applyPolicyRules } = require("../services/policyEvaluationService");
const { loadManifest } = require("../services/tenantRoleManifest");

const T = "68cbf7806080b4621d469d34";
const byCode = new Map(CATALOGUE.map((p) => [p.code, p]));
const token = (codes) => codes.filter((c) => byCode.has(c)).map((c) => `${byCode.get(c).resource}:${byCode.get(c).action}`.toLowerCase());
const role = (code) => loadManifest().manifest.roles.find((r) => r.code === code).permissions;
const decide = async (roleCode, perms, resource, action) => (await applyPolicyRules({ roles: [roleCode], permissions: perms, resource, action, tenantId: T, userTenantId: T, userType: "CRM" })).decision;

beforeEach(() => { for (const m of ["log", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

// Mutations enforced through the PDP on live routes (REO / MO review: routes per resource:action).
const MUTATIONS = [
  ["pricing", "write"], ["product", "write"], ["tenant", "delete"], ["tenant", "update"], ["events", "create"], ["events", "write"],
  ["issues", "write"], ["issues-templates", "write"], ["lookuptype", "delete"], ["lookup", "write"], ["portal", "write"], ["portal", "create"],
  ["portal", "delete"], ["role", "write"], ["role", "delete"], ["role", "admin"], ["user", "delete"], ["communication", "create"],
  ["communication", "write"], ["communication", "delete"], ["application-payment-links", "write"], ["tenant", "admin"],
];
const REO_READS = [
  ["lookup", "read"], ["lookuptype", "read"], ["events", "read"], ["issues", "read"], ["issues-templates", "read"], ["payments", "read"],
  ["portal", "read"], ["pricing", "read"], ["product-type", "read"], ["product", "read"], ["application-payment-links", "read"],
];

const decision = async (roleCode, perms, resource, action) => applyPolicyRules({ roles: [roleCode], permissions: perms, resource, action, tenantId: T, userTenantId: T, userType: "CRM" });

describe("REO (proposed canonical) at the PDP", () => {
  const reo = () => token(role("REO"));
  const live = () => token(FIXTURE.liveRoles.REO);
  test.each(MUTATIONS)("DENY %s:%s", async (res, act) => {
    expect(await decide("REO", reo(), res, act)).toBe("DENY");
  });
  test.each(REO_READS)("%s:%s - the proposed set loses no read the live REO has today", async (res, act) => {
    const was = await decide("REO", live(), res, act);
    const now = await decide("REO", reo(), res, act);
    if (was === "PERMIT") expect(now).toBe("PERMIT");
  });
  test("reads PERMITTED for the proposed REO (lookups, events, issues, pricing, products, payment-link status)", async () => {
    const permitted = [];
    for (const [res, act] of REO_READS) if ((await decide("REO", reo(), res, act)) === "PERMIT") permitted.push(`${res}:${act}`);
    expect(permitted).toEqual(expect.arrayContaining(["lookup:read", "lookuptype:read", "events:read", "issues:read", "issues-templates:read", "pricing:read", "product-type:read", "application-payment-links:read"]));
  });
  test("FINDING (not role content): the PDP category rule denies CRM staff these reads whatever the role holds", async () => {
    for (const [res, act] of [["payments", "read"], ["portal", "read"], ["tenant", "read"]]) {
      expect({ res, d: await decision("REO", reo(), res, act) }).toEqual({ res, d: { decision: "DENY", reason: "INVALID_USER_TYPE", error: expect.any(String), allowedCategories: expect.any(Array), userTypeCategory: "CRM" } });
    }
  });
  test("contrast: today's live REO is PERMITTED to mutate fees, products, events and issues", async () => {
    const permitted = [];
    for (const [res, act] of MUTATIONS) if ((await decide("REO", live(), res, act)) === "PERMIT") permitted.push(`${res}:${act}`);
    expect(permitted).toEqual(expect.arrayContaining(["pricing:write", "product:write", "events:create", "events:write", "issues:write"]));
  });
});

describe("MO (proposed canonical) at the PDP", () => {
  const mo = () => token(role("MO"));
  const live = () => token(FIXTURE.liveRoles.MO);
  const KEPT = [["portal", "read"], ["portal", "write"], ["portal", "create"], ["communication", "read"], ["communication", "write"], ["communication", "create"], ["events", "read"], ["events", "write"], ["events", "create"], ["issues-complaints", "read"], ["issues-complaints", "write"], ["application-payment-links", "write"], ["application-payment-links", "read"], ["payments", "read"], ["audit", "read"], ["lookup", "read"], ["user", "read"]];
  test.each(KEPT)("%s:%s - kept Membership Officer capability: same decision as the live MO (no regression)", async (res, act) => {
    const was = await decide("MO", live(), res, act);
    if (was === "PERMIT") expect(await decide("MO", mo(), res, act)).toBe("PERMIT");
  });
  test("added issues:read / issues:write make the complaints grants usable (issue routes require the base resource first)", async () => {
    expect(await decide("MO", mo(), "issues", "read")).toBe("PERMIT");
    expect(await decide("MO", live(), "issues", "read")).toBe("DENY");
  });
  test.each([["role", "write"], ["role", "delete"], ["role", "admin"], ["role", "read"], ["user", "delete"], ["user", "write"], ["tenant", "delete"], ["tenant", "admin"], ["lookup", "write"], ["lookup", "delete"], ["lookuptype", "delete"], ["portal", "delete"]])("DENY %s:%s", async (res, act) => {
    expect(await decide("MO", mo(), res, act)).toBe("DENY");
  });
  test("FINDING: live MO role:write / role:delete is denied today ONLY by the category rule (ROLE), not by its permissions", async () => {
    for (const act of ["write", "delete"]) expect(await decision("MO", live(), "role", act)).toMatchObject({ decision: "DENY", reason: "INVALID_USER_TYPE" });
    expect(live()).toEqual(expect.arrayContaining(["role:write", "role:delete"]));
    expect(mo()).not.toEqual(expect.arrayContaining(["role:write"]));
  });
});

describe("SECURITY BLOCKER evidence: MEMBER / NON-MEMBER (PORTAL users) at the PDP", () => {
  const asPortal = async (roleCode, perms, resource, action) => (await applyPolicyRules({ roles: [roleCode], permissions: perms, resource, action, tenantId: T, userTenantId: T, userType: "PORTAL" })).decision;
  test("a PORTAL member is PERMITTED communication create / write / delete (campaign send, letters with any member's data, template delete)", async () => {
    const member = token(role("MEMBER"));
    for (const act of ["create", "write", "delete"]) expect(await asPortal("MEMBER", member, "communication", act)).toBe("PERMIT");
  });
  test("a PORTAL member / non-member is PERMITTED portal:write (also gates the CRM payment-form verify / approve / delete routes)", async () => {
    expect(await asPortal("MEMBER", token(role("MEMBER")), "portal", "write")).toBe("PERMIT");
    expect(await asPortal("NON-MEMBER", token(role("NON-MEMBER")), "portal", "write")).toBe("PERMIT");
  });
});
