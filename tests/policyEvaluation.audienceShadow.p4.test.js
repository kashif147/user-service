/**
 * PDP rollout P4 - audience branch in SHADOW (services/policyEvaluationService.js, PDP_AUDIENCE_MODE).
 * REAL applyPolicyRules / compareAudienceDecision with a stubbed catalogue, role hierarchy and cache.
 *   A. synthetic matrix: audience (CRM/PORTAL/BOTH/unset) x userType (CRM/PORTAL/MEMBER/SYSTEM/missing) - the
 *      returned decision is the legacy one in every mode; shadow logs iff the final decisions differ.
 *   B. modes: off default; shadow; "enforce" and unknown values -> off (P4 can never enforce).
 *   C. ASU / platform namespace / retired SU / tenant invariant: unchanged in shadow, nothing logged.
 *   D. DEV snapshot: live MEMBER, NON-MEMBER, MO, REO claim sets x every active resource:action - the exact
 *      divergence set is pinned (the P5 blocker analysis is built on it).
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
    return { initialize: async () => {}, get: async () => null, set: async () => {}, getStats: async () => ({}) };
  },
);

const pdp = require("../services/policyEvaluationService");
const SNAPSHOT = require("./fixtures/p4-dev-audience-snapshot.json");

const TA = "68cbf7806080b4621d469d34";
const TB = "6acd6119b28a863c61361ae0";
const ctx = (o = {}) => ({ roles: ["X"], permissions: [], resource: "r", action: "read", tenantId: TA, userTenantId: TA, userType: "CRM", ...o });

let warnSpy;
const shadowLines = () =>
  warnSpy.mock.calls.filter((c) => c[0] === "[PDP] audience shadow").map((c) => JSON.parse(c[1]));
const prevMode = process.env.PDP_AUDIENCE_MODE;
beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  if (prevMode === undefined) delete process.env.PDP_AUDIENCE_MODE;
  else process.env.PDP_AUDIENCE_MODE = prevMode;
});

describe("A. synthetic matrix: shadow never changes the returned decision", () => {
  // One resource per audience. Category is deliberately the "wrong" one so legacy and audience disagree.
  const SYN = [
    { code: "AUDCRM_READ", resource: "audcrm", action: "read", category: "PORTAL", audience: "CRM" },
    { code: "AUDPORTAL_READ", resource: "audportal", action: "read", category: "CRM", audience: "PORTAL" },
    { code: "AUDBOTH_READ", resource: "audboth", action: "read", category: "PROFILE", audience: "BOTH" },
    { code: "AUDNONE_READ", resource: "audnone", action: "read", category: "CRM" },
    // stored audience absent -> the committed map fills it (PROFILE_READ -> CRM)
    { code: "PROFILE_READ", resource: "profile", action: "read", category: "PROFILE" },
  ];
  const TYPES = ["CRM", "PORTAL", "MEMBER", "SYSTEM", undefined];
  const RES = ["audcrm", "audportal", "audboth", "audnone", "profile"];
  const legacyCat = { audcrm: "PORTAL", audportal: "CRM", audboth: "PROFILE", audnone: "CRM", profile: "PROFILE" };
  const typeCat = { CRM: "CRM", PORTAL: "PORTAL", MEMBER: "PORTAL", SYSTEM: "ADMIN", undefined: "GENERAL" };
  const audOf = { audcrm: "CRM", audportal: "PORTAL", audboth: "BOTH", audnone: null, profile: "CRM" };
  const cls = { CRM: "CRM", PORTAL: "PORTAL", MEMBER: "PORTAL", SYSTEM: null, undefined: null };
  beforeAll(() => { mockCatalogue = SYN; });

  const cells = [];
  for (const r of RES) for (const t of TYPES) cells.push([r, String(t), t]);

  test.each(cells)("%s x %s: off and shadow return the legacy decision; shadow logs iff divergent", async (r, _label, t) => {
    const c = ctx({ resource: r, userType: t, permissions: [`${r}:read`] });
    const legacy = legacyCat[r] === typeCat[t] ? "PERMIT" : "DENY";
    const a = audOf[r];
    const proposed = a === null ? legacy : (a === "BOTH" ? cls[t] !== null : a === cls[t]) ? "PERMIT" : "DENY";

    delete process.env.PDP_AUDIENCE_MODE;
    const off = await pdp.applyPolicyRules(c);
    expect(off.decision).toBe(legacy);
    expect(shadowLines()).toHaveLength(0);

    process.env.PDP_AUDIENCE_MODE = "shadow";
    const sh = await pdp.applyPolicyRules(c);
    expect(sh).toEqual(off);
    const lines = shadowLines();
    if (proposed === legacy) expect(lines).toHaveLength(0);
    else {
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: "pdp.audience.shadow", resource: r, action: "read", oldDecision: legacy, newDecision: proposed, audience: a, audienceSource: r === "profile" ? "map" : "stored" });
      expect(Object.keys(lines[0]).sort()).toEqual(
        ["action", "audience", "audienceSource", "correlationId", "event", "newDecision", "newReason", "oldDecision", "oldReason", "principalTenantId", "resource", "targetTenantId", "userType"],
      );
    }

    const cmp = await pdp.compareAudienceDecision(c);
    expect([cmp.oldDecision.decision, cmp.newDecision.decision]).toEqual([legacy, proposed]);
  });

  test("the audience rule never skips the 'holds a permission on this resource' gate", async () => {
    process.env.PDP_AUDIENCE_MODE = "shadow";
    const cmp = await pdp.compareAudienceDecision(ctx({ resource: "audboth", userType: "PORTAL", permissions: [] }));
    expect(cmp.newDecision).toMatchObject({ decision: "DENY", reason: "INSUFFICIENT_RESOURCE_PERMISSION" });
  });

  test("nor the exact-permission stage (resource held, other action)", async () => {
    mockCatalogue = [...SYN, { code: "AUDBOTH_WRITE", resource: "audboth", action: "write", category: "PROFILE", audience: "BOTH" }];
    const cmp = await pdp.compareAudienceDecision(ctx({ resource: "audboth", action: "write", userType: "CRM", permissions: ["audboth:read"] }));
    expect(cmp.newDecision.decision).toBe("DENY");
    mockCatalogue = SYN;
  });

  test("conflicting audiences on one resource:action -> every one must admit (fail closed)", async () => {
    mockCatalogue = [{ code: "DUP_A", resource: "dup", action: "read", category: "CRM", audience: "CRM" }, { code: "DUP_B", resource: "dup", action: "read", category: "CRM", audience: "BOTH" }];
    const p = await pdp.compareAudienceDecision(ctx({ resource: "dup", userType: "PORTAL", permissions: ["dup:read"] }));
    const c = await pdp.compareAudienceDecision(ctx({ resource: "dup", userType: "CRM", permissions: ["dup:read"] }));
    expect([p.newDecision.decision, p.newDecision.audience, c.newDecision.decision]).toEqual(["DENY", "BOTH+CRM", "PERMIT"]);
    mockCatalogue = SYN;
  });
});

describe("B. mode handling (P4 can never enforce)", () => {
  test.each([[undefined, "off"], ["", "off"], ["off", "off"], ["shadow", "shadow"], [" SHADOW ", "shadow"], ["enforce", "off"], ["ENFORCE", "off"], ["yes", "off"]])(
    "PDP_AUDIENCE_MODE=%p -> %s",
    (v, m) => {
      if (v === undefined) delete process.env.PDP_AUDIENCE_MODE;
      else process.env.PDP_AUDIENCE_MODE = v;
      expect(pdp.audienceMode()).toBe(m);
    },
  );

  test("enforce set by mistake: the legacy decision is returned and nothing is shadow-evaluated", async () => {
    mockCatalogue = [{ code: "AUDCRM_READ", resource: "audcrm", action: "read", category: "PORTAL", audience: "CRM" }];
    process.env.PDP_AUDIENCE_MODE = "enforce";
    const d = await pdp.applyPolicyRules(ctx({ resource: "audcrm", userType: "PORTAL", permissions: ["audcrm:read"] }));
    expect(d.decision).toBe("PERMIT"); // legacy category PORTAL == PORTAL; audience CRM would deny
    expect(shadowLines()).toHaveLength(0);
  });

  test("a failing shadow evaluation never changes or breaks the returned decision", async () => {
    mockCatalogue = [{ code: "AUDCRM_READ", resource: "audcrm", action: "read", category: "PORTAL", audience: "CRM" }];
    process.env.PDP_AUDIENCE_MODE = "shadow";
    const permissionsService = require("../services/permissionsService");
    const orig = permissionsService.getPermissionsByResource;
    let calls = 0;
    permissionsService.getPermissionsByResource = async (r) => { calls += 1; if (calls === 2) throw new Error("boom"); return orig(r); };
    const d = await pdp.applyPolicyRules(ctx({ resource: "audcrm", userType: "PORTAL", permissions: ["audcrm:read"] }));
    permissionsService.getPermissionsByResource = orig;
    expect(d.decision).toBe("PERMIT");
  });
});

describe("C. rules ahead of the resource stage are unchanged in shadow (nothing logged)", () => {
  beforeAll(() => { mockCatalogue = [{ code: "AUDCRM_READ", resource: "audcrm", action: "read", category: "PORTAL", audience: "CRM" }]; });
  test.each([
    ["ASU own tenant", ctx({ roles: ["ASU"], permissions: ["*"], resource: "audcrm", userType: "PORTAL" }), "PERMIT", "ASU_OWN_TENANT_ADMIN"],
    ["platform namespace", ctx({ resource: "platform", action: "read", permissions: ["*"] }), "DENY", "PLATFORM_PERMISSION_NOT_TENANT_EVALUABLE"],
    ["retired SU", ctx({ roles: ["SU"], resource: "audcrm" }), "DENY", "RETIRED_ROLE_REAUTH_REQUIRED"],
    ["cross-tenant", ctx({ resource: "audcrm", userTenantId: TB, permissions: ["audcrm:read"] }), "DENY", "TENANT_SCOPE_VIOLATION"],
  ])("%s", async (_n, c, decision, reason) => {
    process.env.PDP_AUDIENCE_MODE = "shadow";
    const d = await pdp.applyPolicyRules(c);
    expect(d).toMatchObject({ decision, reason });
    expect(shadowLines()).toHaveLength(0);
  });
});

describe("D. DEV snapshot: live MEMBER / NON-MEMBER / MO / REO claim sets (pinned divergence set)", () => {
  // role resource:action old -> new  (held = the role's live claims include it)
  const EXPECTED = [
    "MEMBER accounts.reports:read PERMIT->DENY", "MEMBER application:read PERMIT->DENY",
    "NON-MEMBER accounts.reports:read PERMIT->DENY", "NON-MEMBER application:create PERMIT->DENY",
    "NON-MEMBER application:delete PERMIT->DENY", "NON-MEMBER application:read PERMIT->DENY",
    "NON-MEMBER application:write PERMIT->DENY",
    ...["accounts.reports:read", "application:create", "application:delete", "application:read", "application:write", "audit:read",
      "changeOfCategory:create", "changeOfCategory:delete", "changeOfCategory:read", "changeOfCategory:write",
      "communication:create", "communication:delete", "communication:read", "communication:write", "payments:read", "payments:write",
      "profile:create", "profile:delete", "profile:read", "profile:write", "subscriptions:create", "subscriptions:delete",
      "subscriptions:read", "subscriptions:write", "tenant:read", "transferRequests:create", "transferRequests:delete",
      "transferRequests:read", "transferRequests:write"].map((ra) => `MO ${ra} DENY->PERMIT`),
    ...["changeOfCategory:create", "changeOfCategory:read", "payments:read", "profile:read", "subscriptions:read", "subscriptions:write",
      "transferRequests:create", "transferRequests:read", "transferRequests:write"].map((ra) => `REO ${ra} DENY->PERMIT`),
  ].sort();

  test("exactly the pinned divergences; every one is on a code the role already holds", async () => {
    mockCatalogue = SNAPSHOT.catalogue.filter((p) => p.isActive);
    const pairs = [...new Map(mockCatalogue.map((p) => [`${p.resource}:${p.action}`, [p.resource, p.action]])).values()];
    const got = [];
    for (const [role, def] of Object.entries(SNAPSHOT.roles)) {
      for (const [resource, action] of pairs) {
        const c = ctx({ roles: [role], permissions: def.claims, resource, action, userType: def.intendedUserType });
        const { oldDecision: o, newDecision: n, divergent } = await pdp.compareAudienceDecision(c);
        if (!divergent) continue;
        expect(def.claims).toContain(`${resource}:${action}`.toLowerCase());
        got.push(`${role} ${resource}:${action} ${o.decision}->${n.decision}`);
      }
    }
    expect(got.sort()).toEqual(EXPECTED);
  });
});
