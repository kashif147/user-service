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

describe("B. mode handling (P5: off | shadow | enforce; unset = off; unknown = enforce, fail closed)", () => {
  test.each([[undefined, "off"], ["", "off"], ["off", "off"], ["shadow", "shadow"], [" SHADOW ", "shadow"], ["enforce", "enforce"], ["ENFORCE", "enforce"], ["yes", "enforce"]])(
    "PDP_AUDIENCE_MODE=%p -> %s",
    (v, m) => {
      if (v === undefined) delete process.env.PDP_AUDIENCE_MODE;
      else process.env.PDP_AUDIENCE_MODE = v;
      expect(pdp.audienceMode()).toBe(m);
    },
  );

  test("enforce reads the CATALOGUE only: a stored CRM audience denies a PORTAL caller; nothing is shadow-evaluated", async () => {
    mockCatalogue = [{ code: "AUDCRM_READ", resource: "audcrm", action: "read", category: "PORTAL", audience: "CRM" }];
    process.env.PDP_AUDIENCE_MODE = "enforce";
    const d = await pdp.applyPolicyRules(ctx({ resource: "audcrm", userType: "PORTAL", permissions: ["audcrm:read"] }));
    expect(d).toMatchObject({ decision: "DENY", reason: "AUDIENCE_MISMATCH" }); // legacy category PORTAL would permit
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

describe("E. off and shadow return IDENTICAL decisions on the full DEV snapshot", () => {
  test("4 live roles x every active resource:action: applyPolicyRules off === shadow (deep equal)", async () => {
    mockCatalogue = SNAPSHOT.catalogue.filter((p) => p.isActive);
    const pairs = [...new Map(mockCatalogue.map((p) => [`${p.resource}:${p.action}`, [p.resource, p.action]])).values()];
    let compared = 0;
    for (const [role, def] of Object.entries(SNAPSHOT.roles)) {
      for (const [resource, action] of pairs) {
        const c = ctx({ roles: [role], permissions: def.claims, resource, action, userType: def.intendedUserType });
        delete process.env.PDP_AUDIENCE_MODE;
        const off = await pdp.applyPolicyRules(c);
        process.env.PDP_AUDIENCE_MODE = "shadow";
        const sh = await pdp.applyPolicyRules(c);
        expect([role, resource, action, sh]).toEqual([role, resource, action, off]);
        compared += 1;
      }
    }
    expect(compared).toBe(4 * pairs.length);
    expect(shadowLines()).toHaveLength(45); // the pinned divergences, logged - and nothing returned differently
  });

  test("enforce on the NOT back-filled snapshot never permits more than legacy: unclassified rows deny (map not used)", async () => {
    mockCatalogue = SNAPSHOT.catalogue.filter((p) => p.isActive);
    pdp.resetAudienceShadowStats();
    process.env.PDP_AUDIENCE_MODE = "enforce";
    const pairs = [...new Map(mockCatalogue.map((p) => [`${p.resource}:${p.action}`, [p.resource, p.action]])).values()];
    for (const [role, def] of Object.entries(SNAPSHOT.roles)) {
      for (const [resource, action] of pairs) {
        const c = ctx({ roles: [role], permissions: def.claims, resource, action, userType: def.intendedUserType });
        const enforced = await pdp.applyPolicyRules(c);
        if (enforced.decision !== "PERMIT") continue;
        // Only rows whose STORED audience is typed (the 9 P1 rows) can permit; never through the committed map.
        const rows = mockCatalogue.filter((p) => p.resource === resource && p.action === action);
        expect([role, resource, action, rows.every((r) => r.audience && r.audience !== "LEGACY")]).toEqual([role, resource, action, true]);
      }
    }
    expect(pdp.getAudienceShadowStats().evaluated).toBe(0);
  });
});

describe("F. aliases (several codes for one resource:action) get one consistent audience", () => {
  test("live alias accounts.reports:read (ACCOUNTS.REPORTS_READ + ACCOUNTS_REPORTS): same audience whichever code is held", async () => {
    mockCatalogue = SNAPSHOT.catalogue.filter((p) => p.isActive && p.resource === "accounts.reports");
    expect(mockCatalogue.map((p) => p.code).sort()).toEqual(["ACCOUNTS.REPORTS_READ", "ACCOUNTS_REPORTS"]);
    // Tokens carry resource:action, not the code, so both aliases yield the same claim and the same decision.
    const portal = await pdp.compareAudienceDecision(ctx({ resource: "accounts.reports", userType: "PORTAL", permissions: ["accounts.reports:read"] }));
    const crm = await pdp.compareAudienceDecision(ctx({ resource: "accounts.reports", userType: "CRM", permissions: ["accounts.reports:read"] }));
    expect([portal.newDecision.decision, portal.newDecision.audience, crm.newDecision.decision]).toEqual(["DENY", "CRM", "PERMIT"]);
  });

  test("an alias missing from the map does not open a gap: the mapped alias's audience governs the resource:action", async () => {
    mockCatalogue = [
      { code: "PROFILE_READ", resource: "profile", action: "read", category: "PROFILE" }, // map: CRM
      { code: "PROFILE_READ_LEGACY_ALIAS", resource: "profile", action: "read", category: "PORTAL" }, // unmapped
    ];
    const cmp = await pdp.compareAudienceDecision(ctx({ resource: "profile", userType: "PORTAL", permissions: ["profile:read"] }));
    expect(cmp.oldDecision.decision).toBe("PERMIT"); // legacy: the PORTAL-category alias lets a portal token through
    expect(cmp.newDecision).toMatchObject({ decision: "DENY", reason: "AUDIENCE_MISMATCH", audience: "CRM", audienceSource: "map" });
  });

  test("stored audience on one alias + map on another: both apply (every audience must admit)", async () => {
    mockCatalogue = [
      { code: "LOOKUP_READ", resource: "lookup", action: "read", category: "GENERAL" }, // map: BOTH
      { code: "LOOKUP_READ_X", resource: "lookup", action: "read", category: "GENERAL", audience: "CRM" }, // stored
    ];
    const p = await pdp.compareAudienceDecision(ctx({ resource: "lookup", userType: "PORTAL", permissions: ["lookup:read"] }));
    expect(p.newDecision).toMatchObject({ decision: "DENY", audience: "BOTH+CRM", audienceSource: "map+stored" });
  });
});

describe("G. shadow failures and latency are measured (failures are swallowed, the pass is awaited)", () => {
  const errorLines = () => warnSpy.mock.calls.filter((c) => c[0] === "[PDP] audience shadow error").map((c) => JSON.parse(c[1]));
  const statsLines = () => warnSpy.mock.calls.filter((c) => c[0] === "[PDP] audience shadow stats").map((c) => JSON.parse(c[1]));
  beforeEach(() => {
    mockCatalogue = [{ code: "AUDCRM_READ", resource: "audcrm", action: "read", category: "PORTAL", audience: "CRM" }];
    pdp.resetAudienceShadowStats();
    process.env.PDP_AUDIENCE_MODE = "shadow";
  });

  test("an audience-pass fault (surfacing as RESOURCE_EVALUATION_ERROR) is a counted FAILURE, not a divergence", async () => {
    const permissionsService = require("../services/permissionsService");
    const orig = permissionsService.getPermissionsByResource;
    let calls = 0;
    permissionsService.getPermissionsByResource = async (r) => { calls += 1; if (calls === 2) throw new Error("boom"); return orig(r); };
    const d = await pdp.applyPolicyRules(ctx({ resource: "audcrm", userType: "PORTAL", permissions: ["audcrm:read"] }));
    permissionsService.getPermissionsByResource = orig;
    expect(d.decision).toBe("PERMIT");
    expect(shadowLines()).toHaveLength(0);
    expect(errorLines()).toEqual([expect.objectContaining({ event: "pdp.audience.shadow.error", kind: "evaluation_error", resource: "audcrm", action: "read", failedSoFar: 1 })]);
    expect(pdp.getAudienceShadowStats()).toMatchObject({ evaluated: 1, failed: 1, divergent: 0 });
  });

  test("an exception thrown in the shadow pass is counted and logged; the decision is unaffected", async () => {
    const roleHierarchy = require("../services/roleHierarchyService");
    const orig = roleHierarchy.isTenantAdmin;
    let calls = 0;
    roleHierarchy.isTenantAdmin = (r) => { calls += 1; if (calls === 2) throw new TypeError("x"); return orig(r); };
    const d = await pdp.applyPolicyRules(ctx({ resource: "audcrm", userType: "PORTAL", permissions: ["audcrm:read"] }));
    roleHierarchy.isTenantAdmin = orig;
    expect(d.decision).toBe("PERMIT");
    expect(errorLines()).toEqual([expect.objectContaining({ kind: "exception", errorName: "TypeError" })]);
    expect(pdp.getAudienceShadowStats()).toMatchObject({ evaluated: 1, failed: 1 });
  });

  test("error lines are rate-limited after 20, the count keeps going", async () => {
    const roleHierarchy = require("../services/roleHierarchyService");
    const orig = roleHierarchy.isTenantAdmin;
    let calls = 0;
    roleHierarchy.isTenantAdmin = (r) => { calls += 1; if (calls % 2 === 0) throw new Error("x"); return orig(r); };
    for (let i = 0; i < 30; i += 1) await pdp.applyPolicyRules(ctx({ resource: "audcrm", userType: "PORTAL", permissions: ["audcrm:read"] }));
    roleHierarchy.isTenantAdmin = orig;
    expect(errorLines()).toHaveLength(20);
    expect(pdp.getAudienceShadowStats().failed).toBe(30);
  });

  test("latency of the shadow pass is recorded per evaluation; a stats line every 200 evaluations", async () => {
    for (let i = 0; i < 200; i += 1) await pdp.applyPolicyRules(ctx({ resource: "audcrm", userType: "CRM", permissions: ["audcrm:read"] }));
    const s = pdp.getAudienceShadowStats();
    expect(s.evaluated).toBe(200);
    expect(Object.values(s.msBuckets).reduce((a, b) => a + b, 0)).toBe(200);
    expect(s.msMax).toBeGreaterThanOrEqual(0);
    expect(s.msAvg).toBeGreaterThanOrEqual(0);
    expect(s.divergent).toBe(200); // CRM caller on a PORTAL-category / CRM-audience row: legacy DENY, proposed PERMIT
    const lines = statsLines();
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]).sort()).toEqual(["divergent", "evaluated", "event", "failed", "msAvg", "msBuckets", "msMax", "msTotal", "since"]);
  });

  test("off mode: no shadow work, no stats", async () => {
    delete process.env.PDP_AUDIENCE_MODE;
    await pdp.applyPolicyRules(ctx({ resource: "audcrm", userType: "CRM", permissions: ["audcrm:read"] }));
    expect(pdp.getAudienceShadowStats().evaluated).toBe(0);
  });
});
