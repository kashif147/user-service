/**
 * PDP rollout P1 - token serialisation == PDP serialisation for the nine new codes, end to end through the
 * REAL functions (no re-implementation of either transform):
 *
 *   issuance   handlers/role.handler.js getUserPermissions (catalogue resolve -> `${resource}:${action}`)
 *              -> helpers/jwt.js generateToken (normalizePermission) -> signed claim `permissions`
 *   code form  constants/permissionClassification.js canonicalPermission(code)
 *   PDP        services/policyEvaluationService.js applyPolicyRules / evaluatePolicy (token path)
 *
 * And the P2 claim (d): under the CURRENT evaluator the eight CRM-category codes PERMIT a non-ASU CRM holder
 * and DENY a PORTAL holder; ACCOUNTS.MEMBER_READ (category ACCOUNT) is denied to every non-ASU caller until
 * P5. `audience` is stored but ignored: the decisions are identical with and without it on the rows.
 */
process.env.REDIS_ENABLED = "false";
process.env.NODE_ENV = "test";
delete process.env.AUTH_BYPASS_ENABLED;

const jwt = require("jsonwebtoken");
const { PERMISSIONS, CODES } = require("../scripts/add-p6-catalogue-permissions");

const ids = PERMISSIONS.map((_, i) => `0000000000000000006e00${String(i).padStart(2, "0")}`);
const mockRows = PERMISSIONS.map((p, i) => ({ _id: ids[i], ...p }));
const mockState = { user: null, withAudience: true };

jest.mock("../models/permission.model", () => ({
  find: jest.fn(async (q) =>
    mockRows.filter((d) => (q._id && q._id.$in ? q._id.$in.map(String).includes(String(d._id)) : q.code && q.code.$in ? q.code.$in.includes(d.code) : false)).map((d) => ({ ...d }))
  ),
}));
jest.mock("../models/user.model", () => ({
  findOne: jest.fn(() => ({ populate: async () => mockState.user })),
  findByIdAndUpdate: jest.fn(async () => ({})),
}));
jest.mock("../models/role.model", () => ({}));
jest.mock("../models/tenant.model", () => ({}));
jest.mock("../services/roleHierarchyService", () => ({
  isTenantAdmin: (roles) => Array.isArray(roles) && roles.some((r) => String(typeof r === "string" ? r : r && r.code).trim().toUpperCase() === "ASU"),
  isAssistantSuperUser: () => false,
  isSystemAdmin: () => false,
  getHighestRoleLevel: async () => 1,
  hasMinimumRole: async () => false,
}));
jest.mock("../services/permissionsService", () => {
  const view = () => mockRows.map(({ code, name, resource, action, level, category, audience }) => (mockState.withAudience ? { code, name, resource, action, level, category, audience } : { code, name, resource, action, level, category }));
  return {
    getAllPermissions: async () => view(),
    getPermissionsByResource: async (r) => view().filter((p) => p.resource.toLowerCase() === String(r).toLowerCase()),
  };
});
jest.mock("../services/platformAuditService", () => ({ auditAuthzDecision: () => {}, auditTenantAdminChange: () => {} }));

const RoleHandler = require("../handlers/role.handler");
const jwtHelper = require("../helpers/jwt");
const { canonicalPermission } = require("../constants/permissionClassification");
const { applyPolicyRules, evaluatePolicy } = require("../services/policyEvaluationService");

const SECRET = "test-secret-p6-serialisation";
const TA = "68cbf7806080b4621d469d34";
const userWith = (rolePermissions, userType = "CRM", roleCode = "MO") => ({
  _id: "68cbf7806080b4621d469d99",
  tenantId: TA,
  userEmail: "staff@example.test",
  userType,
  isActive: true,
  roles: [{ _id: "f".repeat(24), code: roleCode, name: roleCode, permissions: rolePermissions }],
  tokens: {},
});
const decide = (p, userType, permissions, roles = ["MO"]) =>
  applyPolicyRules({ roles, permissions, resource: p.resource, action: p.action, tenantId: TA, userTenantId: TA, userType });

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
  process.env.JWT_EXPIRY = "1h";
});
beforeEach(() => {
  mockState.withAudience = true;
  for (const m of ["log", "warn", "error", "info"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const issuedClaim = async (rolePermissions, userType = "CRM") => {
  mockState.user = userWith(rolePermissions, userType);
  const { token } = await jwtHelper.generateToken(mockState.user);
  return { token, permissions: jwt.verify(token, SECRET).permissions };
};

describe("token form == code transform == PDP form (all nine)", () => {
  test.each(PERMISSIONS.map((p) => [p.code, p]))("%s", async (_c, p) => {
    const pdp = `${p.resource}:${p.action}`;
    expect(canonicalPermission(p.code)).toBe(pdp);
    mockState.user = userWith([p.code]);
    expect(await RoleHandler.getUserPermissions(mockState.user._id, TA)).toEqual([pdp]);
    const { permissions } = await issuedClaim([p.code]);
    expect(permissions).toEqual([pdp]);
  });

  test("role stores codes or ObjectIds: identical signed claim, exactly the nine PDP forms", async () => {
    const expected = PERMISSIONS.map((p) => `${p.resource}:${p.action}`).sort();
    expect((await issuedClaim(CODES)).permissions.sort()).toEqual(expected);
    expect((await issuedClaim(ids)).permissions.sort()).toEqual(expected);
    expect(CODES.map(canonicalPermission).sort()).toEqual(expected);
  });
});

describe("current evaluator (P2 claim d)", () => {
  const crm = PERMISSIONS.filter((p) => p.category === "CRM");
  const account = PERMISSIONS.filter((p) => p.category !== "CRM");

  test("eight codes are category CRM; ACCOUNTS.MEMBER_READ is ACCOUNT", () => {
    expect(crm).toHaveLength(8);
    expect(account.map((p) => p.code)).toEqual(["ACCOUNTS.MEMBER_READ"]);
  });

  test.each(crm.map((p) => [p.code, p]))("%s: non-ASU CRM holder PERMIT (issued claim)", async (_c, p) => {
    const { permissions } = await issuedClaim([p.code]);
    expect(await decide(p, "CRM", permissions)).toMatchObject({ decision: "PERMIT" });
  });

  test.each(PERMISSIONS.map((p) => [p.code, p]))("%s: PORTAL holder DENY", async (_c, p) => {
    const { permissions } = await issuedClaim([p.code], "PORTAL");
    // P7 ROLE_CLASS_MODE=enforce: the CRM-class MO role is left out of a PORTAL user's token, so the
    // claim carries no permission at all and the PDP denies one step earlier (still DENY).
    const enforce = require("../helpers/roleClass").roleClassMode() === "enforce";
    if (enforce) expect(permissions).toEqual([]);
    expect(await decide(p, "PORTAL", permissions, ["MEMBER"])).toMatchObject({
      decision: "DENY",
      reason: enforce ? "INSUFFICIENT_RESOURCE_PERMISSION" : "INVALID_USER_TYPE",
    });
  });

  test("ACCOUNTS.MEMBER_READ: non-ASU CRM holder DENY until P5 (category ACCOUNT)", async () => {
    const p = account[0];
    const { permissions } = await issuedClaim([p.code]);
    expect(await decide(p, "CRM", permissions)).toMatchObject({ decision: "DENY", reason: "INVALID_USER_TYPE" });
  });

  test.each(PERMISSIONS.map((p) => [p.code, p]))("%s: CRM caller holding only the other eight -> DENY", async (_c, p) => {
    const others = CODES.filter((c) => c !== p.code);
    const { permissions } = await issuedClaim(others);
    expect(await decide(p, "CRM", permissions)).toMatchObject({ decision: "DENY" });
  });

  test.each(PERMISSIONS.map((p) => [p.code, p]))("%s: ASU (own tenant) PERMIT", async (_c, p) => {
    expect(await decide(p, "CRM", ["*"], ["ASU"])).toMatchObject({ decision: "PERMIT" });
  });

  test("token path (evaluatePolicy) agrees for the issued token", async () => {
    const { token } = await issuedClaim(CODES);
    for (const p of PERMISSIONS) {
      const r = await evaluatePolicy({ token, resource: p.resource, action: p.action, context: { tenantId: TA } });
      expect([p.code, r.decision]).toEqual([p.code, p.category === "CRM" ? "PERMIT" : "DENY"]);
    }
  });
});

describe("audience is ignored by the evaluator (no behaviour change in P1)", () => {
  test("identical decisions with and without audience on the catalogue rows", async () => {
    const run = async () => {
      const out = [];
      for (const p of PERMISSIONS) {
        for (const userType of ["CRM", "PORTAL", "SYSTEM", undefined]) {
          const r = await decide(p, userType, [`${p.resource}:${p.action}`]);
          out.push(`${p.code}/${userType}/${r.decision}/${r.reason}`);
        }
      }
      return out;
    };
    mockState.withAudience = true;
    const withAudience = await run();
    mockState.withAudience = false;
    const without = await run();
    expect(withAudience).toEqual(without);
  });

  // P5: the evaluator reads `audience` on three paths only - shadow (logged, discarded), the comparison harness, and
  // enforce (PDP_AUDIENCE_MODE=enforce, catalogue only). The committed P4 map is referenced only by the shadow /
  // comparison decision; the enforce decision never reads it.
  test("audience wiring: shadow, comparison and catalogue-only enforce; the committed map never reaches enforce (source guard)", () => {
    const src = require("fs").readFileSync(require.resolve("../services/policyEvaluationService"), "utf8");
    expect(src.match(/useAudience: true/g)).toHaveLength(3);
    const fn = (start, end) => src.slice(src.indexOf(start), src.indexOf(end));
    expect(fn("async function shadowAudience", "async function compareAudienceDecision")).toMatch(/useAudience: true \}/);
    expect(fn("const applyPolicyRules = async", "const applyTenantPolicyRules = async")).toMatch(/audMode === "enforce" \? \{ useAudience: true, audienceSource: "catalogue" \} : \{\}/);
    const enforceFn = fn("function catalogueAudienceDecision", "let audienceEnforceDataLogged");
    expect(enforceFn.length).toBeGreaterThan(100);
    expect(enforceFn).not.toMatch(/PROPOSED_AUDIENCE/);
    expect(src.match(/PROPOSED_AUDIENCE\[/g)).toHaveLength(2); // both inside audienceDecision (shadow / comparison)
    expect(fn("function audienceDecision", "function catalogueAudienceDecision")).toMatch(/PROPOSED_AUDIENCE\[p\.code\]/);
    expect(src).toMatch(/if \(AUDIENCE_MODES\.includes\(mode\)\) return mode;/);
  });
});
