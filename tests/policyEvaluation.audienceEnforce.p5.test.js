/**
 * PDP rollout P5 - audience ENFORCEMENT (PDP_AUDIENCE_MODE=enforce), catalogue only.
 * REAL applyPolicyRules / compareAudienceDecision with a stubbed catalogue, role hierarchy and cache.
 *   A. catalogue audience x userType matrix (CRM / PORTAL / BOTH / LEGACY / missing / invalid)
 *   B. aliases (several rows for one resource:action): agree -> applied; disagree -> AUDIENCE_ALIAS_CONFLICT
 *   C. catalogue unavailable (fallback rows) -> CATALOGUE_UNAVAILABLE; never the broader legacy rule
 *   D. the committed P4 map is never consulted; no exact row -> AUDIENCE_DATA_MISSING
 *   E. rules ahead of the resource stage (platform namespace, retired SU, tenant invariant, ASU) unchanged
 *   F. data-quality denials are logged (pdp.audience.enforce.data), rate-limited
 *   G. DEV proposed catalogue (back-fill dry run) x live MEMBER / NON-MEMBER / MO / REO / IRO claims:
 *      the exact 46 divergences; no intended (P8 target + held) access lost; every active row classified.
 */
let mockCatalogue = [];
jest.mock("../services/roleHierarchyService", () => ({
  isTenantAdmin: (roles) => !!roles && roles.includes("ASU"),
  isAssistantSuperUser: (roles) => !!roles && roles.includes("ASU"),
  getHighestRoleLevel: async () => 1,
}));
jest.mock("../services/permissionsService", () => ({
  getAllPermissions: async () => mockCatalogue,
  getPermissionsByResource: async (r) => mockCatalogue.filter((p) => p.resource.toLowerCase() === String(r).toLowerCase()),
}));
jest.mock("../services/policyCache", () =>
  function () {
    return { initialize: async () => {}, get: async () => null, set: async () => {}, getStats: async () => ({}), generateKey: () => null };
  },
);

const pdp = require("../services/policyEvaluationService");
const FIX = require("./fixtures/p5-dev-proposed-catalogue.json");

const TA = "68cbf7806080b4621d469d34";
const TB = "6acd6119b28a863c61361ae0";
const ctx = (o = {}) => ({ roles: ["X"], permissions: ["r:read"], resource: "r", action: "read", tenantId: TA, userTenantId: TA, userType: "CRM", ...o });
const row = (o = {}) => ({ code: "R_READ", resource: "r", action: "read", category: "CRM", ...o });

let warnSpy;
const lines = (tag) => warnSpy.mock.calls.filter((c) => c[0] === tag).map((c) => JSON.parse(c[1]));
const prev = process.env.PDP_AUDIENCE_MODE;
beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  process.env.PDP_AUDIENCE_MODE = "enforce";
});
afterEach(() => {
  jest.restoreAllMocks();
  if (prev === undefined) delete process.env.PDP_AUDIENCE_MODE;
  else process.env.PDP_AUDIENCE_MODE = prev;
});
const enforce = (catalogue, o) => { mockCatalogue = catalogue; return pdp.applyPolicyRules(ctx(o)); };

describe("A. catalogue audience x caller type", () => {
  const TYPES = ["CRM", "PORTAL", "MEMBER", "SYSTEM", undefined];
  const expectFor = { CRM: ["CRM"], PORTAL: ["PORTAL", "MEMBER"], BOTH: ["CRM", "PORTAL", "MEMBER"] };
  for (const aud of ["CRM", "PORTAL", "BOTH"]) {
    test.each(TYPES.map((t) => [String(t), t]))(`audience ${aud} x %s`, async (_l, t) => {
      // category deliberately mismatched with the audience: enforce must follow the audience, not the category
      const d = await enforce([row({ category: "PROFILE", audience: aud })], { userType: t });
      if (expectFor[aud].includes(t)) expect(d).toMatchObject({ decision: "PERMIT", reason: "POLICY_SATISFIED" });
      else expect(d).toMatchObject({ decision: "DENY", reason: "AUDIENCE_MISMATCH" });
    });
  }
  test("LEGACY -> the legacy category rule exactly (deliberately not audience-scoped)", async () => {
    expect(await enforce([row({ category: "CRM", audience: "LEGACY" })], { userType: "CRM" })).toMatchObject({ decision: "PERMIT" });
    expect(await enforce([row({ category: "CRM", audience: "LEGACY" })], { userType: "PORTAL" })).toMatchObject({ decision: "DENY", reason: "INVALID_USER_TYPE" });
    expect(await enforce([row({ category: "COMMUNICATION", audience: "LEGACY" })], { userType: "PORTAL" })).toMatchObject({ decision: "PERMIT" });
  });
  test.each([[undefined], [null], [""]])("missing audience (%p) -> DENY AUDIENCE_DATA_MISSING even where the legacy rule would permit", async (a) => {
    const r = row({ category: "CRM" });
    if (a !== undefined) r.audience = a;
    expect(await enforce([r], { userType: "CRM" })).toMatchObject({ decision: "DENY", reason: "AUDIENCE_DATA_MISSING" });
  });
  test.each([["crm"], ["ALL"], ["ANY"], ["*"]])("invalid audience %p -> DENY AUDIENCE_DATA_INVALID", async (a) => {
    expect(await enforce([row({ audience: a })], { userType: "CRM" })).toMatchObject({ decision: "DENY", reason: "AUDIENCE_DATA_INVALID" });
  });
  test("the audience never skips the resource gate or the exact-permission stage", async () => {
    expect(await enforce([row({ audience: "BOTH" })], { permissions: [] })).toMatchObject({ decision: "DENY", reason: "INSUFFICIENT_RESOURCE_PERMISSION" });
    expect(await enforce([row({ audience: "BOTH" }), row({ code: "R_WRITE", action: "write", audience: "BOTH" })], { action: "write", permissions: ["r:read"] })).toMatchObject({ decision: "DENY" });
  });
});

describe("B. aliases (several active rows for one resource:action)", () => {
  test("all agree (CRM + CRM, like ACCOUNTS.REPORTS_READ + ACCOUNTS_REPORTS) -> applied", async () => {
    const cat = [row({ code: "A1", audience: "CRM", category: "PORTAL" }), row({ code: "A2", audience: "CRM", category: "ACCOUNT" })];
    expect(await enforce(cat, { userType: "CRM" })).toMatchObject({ decision: "PERMIT" });
    expect(await enforce(cat, { userType: "PORTAL" })).toMatchObject({ decision: "DENY", reason: "AUDIENCE_MISMATCH" });
  });
  test("all LEGACY (like user:read's four codes) -> legacy rule", async () => {
    expect(await enforce([row({ code: "U1", audience: "LEGACY" }), row({ code: "U2", audience: "LEGACY" })], { userType: "CRM" })).toMatchObject({ decision: "PERMIT" });
  });
  test.each([
    [["CRM", "BOTH"]], [["CRM", "PORTAL"]], [["LEGACY", "CRM"]], [["LEGACY", "BOTH"]],
  ])("disagree %p -> DENY AUDIENCE_ALIAS_CONFLICT for every caller type (no 'most permissive' pick)", async (vals) => {
    const cat = vals.map((a, i) => row({ code: `C${i}`, audience: a, category: "COMMUNICATION" }));
    for (const t of ["CRM", "PORTAL"]) expect(await enforce(cat, { userType: t })).toMatchObject({ decision: "DENY", reason: "AUDIENCE_ALIAS_CONFLICT" });
  });
  test("one alias missing its audience -> DENY AUDIENCE_DATA_MISSING (not the other alias's audience)", async () => {
    expect(await enforce([row({ code: "A1", audience: "BOTH" }), row({ code: "A2" })], { userType: "CRM" })).toMatchObject({ decision: "DENY", reason: "AUDIENCE_DATA_MISSING" });
  });
});

describe("C. catalogue unavailable: the in-code fallback can never restore broader access", () => {
  const fb = (o) => ({ ...row(o), source: "fallback" });
  test("fallback rows -> DENY CATALOGUE_UNAVAILABLE where legacy would PERMIT (non-ASU)", async () => {
    expect(await enforce([fb({ category: "CRM" })], { userType: "CRM" })).toMatchObject({ decision: "DENY", reason: "CATALOGUE_UNAVAILABLE" });
    expect(await enforce([fb({ category: "CRM", audience: "CRM" })], { userType: "CRM" })).toMatchObject({ decision: "DENY", reason: "CATALOGUE_UNAVAILABLE" });
  });
  test("ASU is decided by its own-tenant rule before the catalogue (unchanged)", async () => {
    expect(await enforce([fb()], { roles: ["ASU"], permissions: ["*"] })).toMatchObject({ decision: "PERMIT", reason: "ASU_OWN_TENANT_ADMIN" });
  });
  test("shadow on a fallback catalogue: the legacy decision is returned (shadow never enforces)", async () => {
    process.env.PDP_AUDIENCE_MODE = "shadow";
    expect(await enforce([fb({ category: "CRM" })], { userType: "CRM" })).toMatchObject({ decision: "PERMIT" });
  });
});

describe("D. catalogue only: the committed map is never consulted under enforce", () => {
  test("a row WITHOUT a stored audience whose code IS in the P4 map -> DENY AUDIENCE_DATA_MISSING (map ignored)", async () => {
    // PROFILE_READ is CRM in the map; under shadow the map would apply - under enforce only the catalogue counts.
    const cat = [{ code: "PROFILE_READ", resource: "profile", action: "read", category: "PROFILE" }];
    expect(await enforce(cat, { resource: "profile", permissions: ["profile:read"], userType: "CRM" })).toMatchObject({ decision: "DENY", reason: "AUDIENCE_DATA_MISSING" });
  });
  test("the resource exists but has no row for the exact action -> DENY AUDIENCE_DATA_MISSING", async () => {
    expect(await enforce([row({ audience: "CRM" })], { action: "delete", permissions: ["r:read", "r:delete"] })).toMatchObject({ decision: "DENY", reason: "AUDIENCE_DATA_MISSING" });
  });
});

describe("E. rules ahead of the resource stage are unchanged under enforce", () => {
  beforeEach(() => { mockCatalogue = [row({ audience: "CRM" })]; });
  test.each([
    ["ASU own tenant", { roles: ["ASU"], permissions: ["*"], userType: "PORTAL" }, "PERMIT", "ASU_OWN_TENANT_ADMIN"],
    ["platform namespace", { resource: "platform", action: "read", permissions: ["*"] }, "DENY", "PLATFORM_PERMISSION_NOT_TENANT_EVALUABLE"],
    ["retired SU", { roles: ["SU"] }, "DENY", "RETIRED_ROLE_REAUTH_REQUIRED"],
    ["cross-tenant", { userTenantId: TB }, "DENY", "TENANT_SCOPE_VIOLATION"],
    ["no tenant", { tenantId: undefined }, "DENY", "MISSING_TENANT_CONTEXT"],
  ])("%s", async (_n, o, decision, reason) => {
    expect(await pdp.applyPolicyRules(ctx(o))).toMatchObject({ decision, reason });
  });
});

describe("F. data-quality denials are logged (rate-limited); ordinary mismatches are not", () => {
  test("rate limit: the first 20 are logged, then every 100th; the count keeps going", async () => {
    pdp.resetAudienceEnforceDataLog();
    for (let i = 0; i < 120; i += 1) await enforce([row()], {});
    const l = lines("[PDP] audience enforce data");
    expect(l).toHaveLength(21);
    expect(l[20].countSoFar).toBe(100);
  });

  test("missing / invalid / conflict / unavailable each log pdp.audience.enforce.data; AUDIENCE_MISMATCH does not", async () => {
    pdp.resetAudienceEnforceDataLog();
    await enforce([row()], {});
    await enforce([row({ audience: "ALL" })], {});
    await enforce([row({ code: "A", audience: "CRM" }), row({ code: "B", audience: "BOTH" })], {});
    await enforce([{ ...row(), source: "fallback" }], {});
    await enforce([row({ audience: "PORTAL" })], { userType: "CRM" });
    const got = lines("[PDP] audience enforce data").map((l) => l.reason);
    expect(got).toEqual(["AUDIENCE_DATA_MISSING", "AUDIENCE_DATA_INVALID", "AUDIENCE_ALIAS_CONFLICT", "CATALOGUE_UNAVAILABLE"]);
    expect(Object.keys(lines("[PDP] audience enforce data")[0]).sort()).toEqual(["action", "audience", "countSoFar", "event", "reason", "resource", "userType"]);
  });
});

describe("G. DEV proposed catalogue (back-fill dry run) x live role claims", () => {
  const EXPECTED = ["IRO accounts.reports:read DENY->PERMIT", "MEMBER accounts.reports:read PERMIT->DENY", "MEMBER application:read PERMIT->DENY", "MO accounts.reports:read DENY->PERMIT", "MO application:create DENY->PERMIT", "MO application:delete DENY->PERMIT", "MO application:read DENY->PERMIT", "MO application:write DENY->PERMIT", "MO audit:read DENY->PERMIT", "MO changeOfCategory:create DENY->PERMIT", "MO changeOfCategory:delete DENY->PERMIT", "MO changeOfCategory:read DENY->PERMIT", "MO changeOfCategory:write DENY->PERMIT", "MO communication:create DENY->PERMIT", "MO communication:delete DENY->PERMIT", "MO communication:read DENY->PERMIT", "MO communication:write DENY->PERMIT", "MO payments:read DENY->PERMIT", "MO payments:write DENY->PERMIT", "MO profile:create DENY->PERMIT", "MO profile:delete DENY->PERMIT", "MO profile:read DENY->PERMIT", "MO profile:write DENY->PERMIT", "MO subscriptions:create DENY->PERMIT", "MO subscriptions:delete DENY->PERMIT", "MO subscriptions:read DENY->PERMIT", "MO subscriptions:write DENY->PERMIT", "MO tenant:read DENY->PERMIT", "MO transferRequests:create DENY->PERMIT", "MO transferRequests:delete DENY->PERMIT", "MO transferRequests:read DENY->PERMIT", "MO transferRequests:write DENY->PERMIT", "NON-MEMBER accounts.reports:read PERMIT->DENY", "NON-MEMBER application:create PERMIT->DENY", "NON-MEMBER application:delete PERMIT->DENY", "NON-MEMBER application:read PERMIT->DENY", "NON-MEMBER application:write PERMIT->DENY", "REO changeOfCategory:create DENY->PERMIT", "REO changeOfCategory:read DENY->PERMIT", "REO payments:read DENY->PERMIT", "REO profile:read DENY->PERMIT", "REO subscriptions:read DENY->PERMIT", "REO subscriptions:write DENY->PERMIT", "REO transferRequests:create DENY->PERMIT", "REO transferRequests:read DENY->PERMIT", "REO transferRequests:write DENY->PERMIT"];
  const INTENDED = {"MO": ["Notification:read", "Profile.corn_market_rewards:read", "Profile.recruit_friend:read", "Profile_new_graduate:read", "application-payment-links:read", "application-payment-links:write", "application:create", "application:read", "application:write", "audit:read", "changeOfCategory:read", "communication:create", "communication:delete", "communication:read", "communication:write", "dashboard:read", "events:create", "events:read", "events:write", "issues-complaints:read", "issues-complaints:write", "lookup:read", "lookuptype:read", "menu:configuration_access", "menu:correspondence_access", "menu:events_access", "menu:finance_access", "menu:membership_access", "menu:reports_access", "notifications:create", "payments:read", "profile:create", "profile:read", "profile:write", "subscriptions:read", "subscriptions:write", "templates:read", "tenant:read", "transferRequests:read", "transferRequests:write"], "REO": ["Notification:read", "application-payment-links:read", "changeOfCategory:read", "events:read", "lookup:read", "lookuptype:read", "menu:finance_access", "menu:membership_access", "menu:reports_access", "payments:read", "pricing:read", "product-type:read", "profile:read", "subscriptions:read", "transferRequests:read"], "MEMBER": ["events:read", "lookup:read", "portal:create", "portal:read", "portal:write", "registrations:create", "registrations:read", "registrations:write"], "NON-MEMBER": ["events:read", "lookup:read", "portal:create", "portal:read", "portal:write", "product:read", "registrations:create", "registrations:read", "registrations:write"], "IRO": ["Notification:read", "accounts.reports:read", "events:create", "events:read", "issues-complaints:read", "issues-complaints:write", "issues-ftp:read", "issues-ftp:write", "issues-ir:read", "issues-ir:write", "lookup:read", "lookuptype:read", "membership-drives:read", "membership-drives:write"]};
  const pairs = () => [...new Map(FIX.catalogue.map((p) => [`${p.resource}:${p.action}`, [p.resource, p.action]])).values()];

  test("every active row is classified: 73 typed (60 CRM / 6 BOTH / 7 PORTAL) + 68 LEGACY; aliases agree", () => {
    const c = {};
    FIX.catalogue.forEach((p) => (c[p.audience] = (c[p.audience] || 0) + 1));
    expect(c).toEqual({ CRM: 60, BOTH: 6, PORTAL: 7, LEGACY: 68 });
    const by = new Map();
    for (const p of FIX.catalogue) {
      const k = `${p.resource}:${p.action}`.toLowerCase();
      by.set(k, [...(by.get(k) || []), p.audience]);
    }
    for (const [k, v] of by) expect([k, new Set(v).size]).toEqual([k, 1]);
  });

  test("enforce vs legacy: exactly the 46 known divergences (= the P4 shadow prediction)", async () => {
    pdp.resetAudienceEnforceDataLog();
    mockCatalogue = FIX.catalogue;
    const got = [];
    for (const [role, def] of Object.entries(FIX.roles)) {
      for (const [resource, action] of pairs()) {
        const c = ctx({ roles: [role], permissions: def.claims, resource, action, userType: def.intendedUserType });
        process.env.PDP_AUDIENCE_MODE = "off";
        const legacy = await pdp.applyPolicyRules(c);
        process.env.PDP_AUDIENCE_MODE = "enforce";
        const enforced = await pdp.applyPolicyRules(c);
        if (legacy.decision !== enforced.decision) got.push(`${role} ${resource}:${action} ${legacy.decision}->${enforced.decision}`);
      }
    }
    expect(got.sort()).toEqual(EXPECTED);
    // no data-quality denial anywhere on the proposed catalogue
    expect(lines("[PDP] audience enforce data")).toHaveLength(0);
  });

  test("intended access (P8 target AND held): nothing legacy permits is lost under enforce", async () => {
    mockCatalogue = FIX.catalogue;
    for (const [role, list] of Object.entries(INTENDED)) {
      const def = FIX.roles[role];
      for (const ra of list) {
        const i = ra.lastIndexOf(":");
        const c = ctx({ roles: [role], permissions: def.claims, resource: ra.slice(0, i), action: ra.slice(i + 1), userType: def.intendedUserType });
        process.env.PDP_AUDIENCE_MODE = "off";
        const legacy = await pdp.applyPolicyRules(c);
        process.env.PDP_AUDIENCE_MODE = "enforce";
        const enforced = await pdp.applyPolicyRules(c);
        if (legacy.decision === "PERMIT") expect([role, ra, enforced.decision]).toEqual([role, ra, "PERMIT"]);
      }
    }
  });

  test("portal roles keep their portal flows under enforce (every held portal-flow claim still permits)", async () => {
    mockCatalogue = FIX.catalogue;
    for (const role of ["MEMBER", "NON-MEMBER"]) {
      const def = FIX.roles[role];
      const flows = ["portal:read", "portal:write", "portal:create", "registrations:read", "registrations:create", "registrations:write", "events:read", "lookup:read", "product:read"];
      // live MEMBER does not hold product:read today (NON-MEMBER does) - only held claims are asserted
      for (const ra of flows.filter((x) => def.claims.includes(x))) {
        const i = ra.lastIndexOf(":");
        const d = await pdp.applyPolicyRules(ctx({ roles: [role], permissions: def.claims, resource: ra.slice(0, i), action: ra.slice(i + 1), userType: "PORTAL" }));
        expect([role, ra, d.decision]).toEqual([role, ra, "PERMIT"]);
      }
    }
  });
});
