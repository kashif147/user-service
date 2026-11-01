/**
 * Phase B / Z9 - the legacy tenant SU is retired; ASU is the highest tenant role (owner decision 2026-10-31).
 *
 * ASU authority is an explicit OWN-TENANT administrative rule (services/policyEvaluationService.js Rule 1),
 * evaluated in this order:
 *   authentication + trusted internal tenant (callers) -> Rule 0 platform namespace (always DENY in the tenant
 *   PDP) -> Rule 0b retired SU token (DENY) -> tenant boundary (request tenant == actor's own tenant) -> ASU.
 * It never overrides the stronger guards: PlatformPrincipal / platform:*, the cross-tenant boundary, the A14
 * GLOBAL_DATA_FROZEN freeze, tenant and User ownership immutability, identity binding. "*" is never stored on
 * ASU; the token shows ASU as the TENANT wildcard (computed). PlatformPrincipal stays completely separate.
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const CATALOGUE = [
  { code: "CRMONLY_READ", resource: "crmonly", action: "read", category: "CRM" },
  { code: "PORTALONLY_READ", resource: "portalonly", action: "read", category: "PORTAL" },
  { code: "LOOKUP_READ", resource: "lookup", action: "read", category: "CRM" },
  { code: "PAYMENTS_WRITE", resource: "payments", action: "write", category: "CRM" },
  { code: "TENANT_WRITE", resource: "tenant", action: "write", category: "CRM" },
];
jest.mock("../services/roleHierarchyService", () => ({
  isTenantAdmin: (roles) => Array.isArray(roles) && roles.some((r) => String(typeof r === "string" ? r : r && r.code).trim().toUpperCase() === "ASU"),
  isAssistantSuperUser: () => false,
  isSystemAdmin: () => false,
  getHighestRoleLevel: async () => 1,
  hasMinimumRole: async () => false,
}));
jest.mock("../services/permissionsService", () => ({
  getAllPermissions: async () => CATALOGUE,
  getPermissionsByResource: async (r) => CATALOGUE.filter((p) => p.resource.toLowerCase() === String(r).toLowerCase()),
}));
jest.mock("../services/policyCache", () =>
  function () {
    return { initialize: async () => {}, get: async () => null, set: async () => {}, getStats: async () => ({}) };
  }
);
const mockEvaluatePlatform = jest.fn();
jest.mock("../services/platformAuthorizationService", () => {
  const actual = jest.requireActual("../services/platformAuthorizationService");
  return { ...actual, evaluatePlatformPermission: (...a) => mockEvaluatePlatform(...a) };
});
jest.mock("../services/platformAuditService", () => ({ auditAuthzDecision: () => {}, auditTenantRoleMigration: async () => true }));

const { applyPolicyRules } = require("../services/policyEvaluationService");
const { requirePlatformPermission } = require("../middlewares/requirePlatformPermission");
const { REASONS } = require("../services/platformAuthorizationService");

const TA = "68cbf7806080b4621d469d34"; // own tenant
const TB = "6acd6119b28a863c61361ae0"; // another tenant
const ctx = (o = {}) => ({ roles: ["ASU"], permissions: [], resource: "crmonly", action: "read", tenantId: TA, userTenantId: TA, userType: "CRM", ...o });
const ROOT = path.join(__dirname, "..");

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockEvaluatePlatform.mockReset();
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.GLOBAL_DATA_WRITES;
  delete process.env.PLATFORM_AUTH_MODE;
});

describe("decision order (owner-required regression)", () => {
  test("ASU + own tenant + platform permission -> DENY (only a PlatformPrincipal with the exact permission)", async () => {
    for (const [resource, action] of [["platform", "tenant:read:any"], ["platform", "cache:admin"], ["platform:tenant", "read:any"]]) {
      expect(await applyPolicyRules(ctx({ resource, action, permissions: ["*"] }))).toMatchObject({ decision: "DENY", reason: "PLATFORM_PERMISSION_NOT_TENANT_EVALUABLE" });
    }
  });

  test("ASU + another tenant + ordinary tenant action -> DENY TENANT_SCOPE_VIOLATION (even with \"*\")", async () => {
    for (const permissions of [[], ["*"], ["crmonly:read"]]) {
      expect(await applyPolicyRules(ctx({ tenantId: TB, permissions }))).toMatchObject({ decision: "DENY", reason: "TENANT_SCOPE_VIOLATION" });
    }
  });

  test("ASU without a trusted tenant on either side -> DENY MISSING_TENANT_CONTEXT", async () => {
    expect(await applyPolicyRules(ctx({ tenantId: null }))).toMatchObject({ decision: "DENY", reason: "MISSING_TENANT_CONTEXT" });
    expect(await applyPolicyRules(ctx({ userTenantId: null }))).toMatchObject({ decision: "DENY", reason: "MISSING_TENANT_CONTEXT" });
  });

  test("ASU + own tenant + frozen global-data write -> 423 GLOBAL_DATA_FROZEN (authority first, then the freeze)", async () => {
    process.env.PLATFORM_AUTH_MODE = "shadow"; // DEV's global mode; these routes enforce regardless (route-enforce)
    // A tenant actor carries no platform claim: the platform evaluator answers NO_PLAT.
    mockEvaluatePlatform.mockResolvedValue({ allowed: false, status: 403, reason: REASONS.NO_PLAT, pid: null, tokenRev: null, currentRev: null, revMatch: null });
    const run = async () => {
      const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, setHeader() {} };
      const next = jest.fn();
      await requirePlatformPermission("platform:reference-data:manage", { mode: "route-enforce", freeze: "lookup" })(
        { method: "POST", originalUrl: "/api/lookup", headers: { authorization: "Bearer x" }, ctx: { tenantId: TA, userId: "u1", roles: ["ASU"], permissions: ["*"] } },
        res,
        next
      );
      return { status: res.statusCode, next: next.mock.calls.length };
    };
    expect(await run()).toEqual({ status: 423, next: 0 });
    process.env.GLOBAL_DATA_WRITES = "open"; // ops rollback switch never lets a tenant actor (ASU) through
    expect(await run()).toEqual({ status: 403, next: 0 });
  });

  test("a stale token still carrying the retired SU role -> DENY RETIRED_ROLE_REAUTH_REQUIRED (no tenant wildcard either)", async () => {
    for (const roles of [["SU"], [{ code: "SU" }], [" su "], ["SU", "ASU"]]) {
      expect(await applyPolicyRules(ctx({ roles, permissions: ["*"] }))).toMatchObject({ decision: "DENY", reason: "RETIRED_ROLE_REAUTH_REQUIRED" });
    }
  });
});

describe("former SU keeps its own-tenant capability as ASU", () => {
  // role management, lookups, payments, issues, settings, Year-End Renewal (subscriptions) - including resources
  // with no catalogue entry or a non-CRM category, which the retired SU rule also passed.
  test.each([
    ["role", "admin"], ["role", "write"], ["lookup", "read"], ["lookuptype", "read"], ["payments", "write"],
    ["issues", "write"], ["complaints", "read"], ["tenant", "write"], ["tenant", "delete"], ["subscriptions", "write"],
    ["renewalbatch", "create"], ["portalonly", "read"], ["notyetcatalogued", "read"],
  ])("ASU own tenant: %s:%s -> PERMIT ASU_OWN_TENANT_ADMIN", async (resource, action) => {
    expect(await applyPolicyRules(ctx({ resource, action }))).toMatchObject({ decision: "PERMIT", reason: "ASU_OWN_TENANT_ADMIN" });
  });
});

describe("ordinary role permission evaluation unchanged", () => {
  test("a non-admin role is permission-evaluated: exact permission PERMIT, missing DENY, unknown resource DENY", async () => {
    expect(await applyPolicyRules(ctx({ roles: ["MO"], resource: "lookup", permissions: ["lookup:read"] }))).toMatchObject({ decision: "PERMIT", reason: "POLICY_SATISFIED" });
    expect((await applyPolicyRules(ctx({ roles: ["MO"], resource: "lookup", permissions: [] }))).decision).toBe("DENY");
    expect(await applyPolicyRules(ctx({ roles: ["MO"], resource: "notyetcatalogued", permissions: ["*"] }))).toMatchObject({ decision: "DENY", reason: "UNKNOWN_RESOURCE" });
    expect(await applyPolicyRules(ctx({ roles: ["MO"], resource: "portalonly", permissions: ["portalonly:read"] }))).toMatchObject({ decision: "DENY", reason: "INVALID_USER_TYPE" });
  });
});

describe("ownership guards are role-independent (ASU cannot mutate tenant / User ownership)", () => {
  beforeAll(() => mongoose.set("bufferCommands", false));
  test("User.tenantId (Z7) and ProductType.tenantId (A15) reject reassignment whatever the caller's role", async () => {
    const User = require("../models/user.model");
    const ProductType = require("../models/productType.model");
    const id = new mongoose.Types.ObjectId();
    await expect(User.updateOne({ _id: id, tenantId: TA }, { $set: { tenantId: TB } })).rejects.toMatchObject({ status: 409 });
    await expect(ProductType.updateOne({ _id: id, tenantId: TA }, { $set: { tenantId: TB } })).rejects.toMatchObject({ status: 409 });
  });
});

describe("migration script scripts/migrate-su-to-asu.js (static)", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "migrate-su-to-asu.js"), "utf8");
  test("dry run by default; --execute requires a backup file, an operator label and an approval reference", () => {
    expect(src).toMatch(/execute: false/);
    expect(src).toMatch(/--execute requires --backup, --by and --approval/);
  });
  test("never stores \"*\" or a platform / reserved permission on ASU; ASU entries are only ever added", () => {
    expect(src).toMatch(/const notGrantable = \(c\) => c === TENANT_WILDCARD \|\| c === "\*" \|\| isPlatformNamespace\(c\) \|\| isLegacyReservedPermission\(c\)/);
    expect(src).toMatch(/\$addToSet: \{ permissions: \{ \$each: toAdd \} \}/);
    expect(src).not.toMatch(/\$pull: \{ permissions/);
  });
  test("every write is tenant-qualified; SU is deleted only when no user of the tenant still holds it; >1 ASU blocks", () => {
    expect(src).toMatch(/User\.updateMany\(\{ tenantId: tid, roles: \{ \$in: suIds \} \}, \{ \$addToSet: \{ roles: asuId \} \}\)/);
    expect(src).toMatch(/User\.updateMany\(\{ tenantId: tid, roles: \{ \$in: suIds \} \}, \{ \$pull: \{ roles: \{ \$in: suIds \} \} \}\)/);
    expect(src).toMatch(/if \(stillSU === 0\) retired = \(await Role\.deleteMany\(\{ _id: \{ \$in: suIds \}, tenantId: tid, code: "SU" \}\)\)/);
    expect(src).toMatch(/asu\.length > 1\) return \{ tenant: tenant\.code, outcome: "blocked", reason: "multiple_asu_roles" \}/);
    expect(src).toMatch(/connection_default_role_is_su/);
    // ASU is only ever looked up / created / updated in the tenant itself
    for (const m of src.matchAll(/tenantId: ([A-Za-z_.]+), code: "ASU"/g)) expect(m[1]).toBe("tid");
    expect([...src.matchAll(/tenantId: ([A-Za-z_.]+), code: "ASU"/g)].length).toBeGreaterThanOrEqual(2);
  });
  test("each changed tenant is audited by the system actor (tenant-owned record, counts only)", () => {
    expect(src).toMatch(/auditTenantRoleMigration\(\{/);
    const audit = fs.readFileSync(path.join(ROOT, "services", "platformAuditService.js"), "utf8");
    expect(audit).toMatch(/const ROLE_MIGRATION_ACTOR = "platform:migration";/);
    expect(audit).toMatch(/auditContext: \{ actorScope: "system", actorTenantId: null, targetTenantId: target \}/);
  });
});

describe("source guard: no runtime SU authority can come back", () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!["node_modules", "tests", ".git", "coverage", "logs", "examples", "sdks"].includes(e.name)) walk(rel);
      } else if (e.name.endsWith(".js")) files.push(rel);
    }
  })("");
  const src = Object.fromEntries(files.map((f) => [f, strip(fs.readFileSync(path.join(ROOT, f), "utf8"))]));

  // Allowed SU literals: the retirement itself (retired-role refusal, reserved codes, "never assign SU", never
  // clone SU), the migration + its audit record, read-only diagnostics, and the unmounted legacy router.
  const ALLOW = new Set([
    "services/policyEvaluationService.js", // RETIRED_ROLE_CODES (refusal only)
    "handlers/role.handler.js", // RESERVED_ROLE_CODES + "the retired SU role cannot be assigned"
    "handlers/tenant.handler.js", // provisioning clone excludes SU
    "services/platformAuditService.js", // migration audit record fromRole: "SU"
    "scripts/migrate-su-to-asu.js",
    "scripts/get-system-users.js", // read-only diagnostics
    "scripts/get-system-emails.js",
    "scripts/add-communication-permissions.js", // read-only SU verification log
    "scripts/add-category-to-roles.js", // category label map only
    "routes/role-policy.routes.js", // never mounted (routes/index.js)
    "constants/retiredRoleCodes.js", // P5: the tenant-roles manifest / ensureTenantRoles REFUSAL list (never a grant)
  ]);

  test("the walk covers runtime code and scripts", () => {
    expect(files).toEqual(expect.arrayContaining(["services/policyEvaluationService.js", "middlewares/auth.js", "routes/policy.routes.js"]));
    expect(files.some((f) => f.startsWith("scripts/"))).toBe(true);
  });

  test('no SU role literal outside the allow-list (no SU bypass / default / provisioning / platform authority)', () => {
    const hits = Object.entries(src)
      .filter(([f]) => !ALLOW.has(f))
      .flatMap(([f, s]) => [...s.matchAll(/["'`]SU["'`]|\bSU\s*:/g)].map((m) => `${f}: ${m[0]}`));
    expect(hits).toEqual([]);
  });

  test("no isSuperUser / requireSuperUser / hasSuperUserRole helper anywhere at runtime", () => {
    const hits = Object.entries(src).flatMap(([f, s]) => [...s.matchAll(/\b(isSuperUser|requireSuperUser|hasSuperUserRole|isSuperUserActor)\b/g)].map((m) => `${f}: ${m[0]}`));
    expect(hits).toEqual([]);
  });

  test("the policy engine refuses SU and only ever PERMITs ASU inside its own tenant, after the platform-namespace rule", () => {
    const pe = src["services/policyEvaluationService.js"];
    expect((pe.match(/["'`]SU["'`]/g) || []).length).toBe(1); // RETIRED_ROLE_CODES only
    const rule0 = pe.indexOf("PLATFORM_PERMISSION_NOT_TENANT_EVALUABLE");
    const retired = pe.indexOf('reason: "RETIRED_ROLE_REAUTH_REQUIRED"');
    const boundary = pe.indexOf("String(tenantId) !== String(context.userTenantId)");
    const asu = pe.indexOf('reason: "ASU_OWN_TENANT_ADMIN"');
    expect(rule0).toBeGreaterThan(0);
    expect(rule0).toBeLessThan(retired);
    expect(retired).toBeLessThan(boundary);
    expect(boundary).toBeLessThan(asu);
  });

  test("no seed / template / provisioning path creates SU; the fallback hierarchy has no SU", () => {
    for (const f of ["scripts/migrate-constants-to-db.js", "scripts/migrate-constants-to-staging.js", "services/roleHierarchyService.js"]) {
      expect({ f, su: /["'`]SU["'`]|\bSU\s*:/.test(src[f]) }).toEqual({ f, su: false });
    }
    expect(src["handlers/tenant.handler.js"]).toMatch(/code: \{ \$ne: "SU" \}/);
  });

  test("the unmounted legacy router stays unmounted", () => {
    expect(src["routes/index.js"]).not.toMatch(/role-policy\.routes/);
  });

  test("security controls exempt no role (rate limits / server-side role validation)", () => {
    expect(src["middlewares/security.mw.js"]).not.toMatch(/roles\?\.includes\(/);
  });

  test("no platform permission can come from a tenant role; ASU summary is tenant-scoped", () => {
    const pe = src["services/policyEvaluationService.js"];
    expect((pe.match(/isTenantAdmin\(roles\) && !isPlatformNamespace\(String\(resource \|\| ""\)\)/g) || []).length).toBe(2);
    expect((pe.match(/scope: "tenant"/g) || []).length).toBe(2);
  });
});
