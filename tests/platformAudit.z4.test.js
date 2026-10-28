/**
 * Phase B / Z4 - durable platform-auth audit events (services/platformAuditService.js).
 *
 *  - CRM sign-in that resolves to a REAL principal (issued / disabled / identity_mismatch) -> one
 *    platform.claim.decision.v1; an ordinary sign-in (not_principal) and mode off -> none.
 *  - Enforced platform authorization (route-enforce guard): allow and 403 deny -> one platform.authz.decision.v1;
 *    401 -> none; shadow observers -> none.
 *  - Context: actorScope platform, actorTenantId null, targetTenantId null, loginTenantId = trusted request tenant;
 *    the envelope tenant is that trusted tenant - never a body / query / header value, never a placeholder.
 *  - Payload never carries a token, oid, issuer or email. A publish failure never changes the response.
 */
const mockPublished = [];
const mockPublishImpl = { fn: async () => true };
jest.mock("../rabbitMQ", () => ({
  publishDomainEvent: (...a) => (mockPublished.push(a), mockPublishImpl.fn(...a)),
}));

jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: () => ({ valid: true }) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../services/roleHierarchyService", () => ({
  isSuperUser: () => false,
  isAssistantSuperUser: () => false,
  isSystemAdmin: () => false,
  getHighestRoleLevel: () => 1,
  hasMinimumRole: () => false,
}));

const jwt = require("jsonwebtoken");
const PlatformPrincipal = require("../models/platformPrincipal.model");
const User = require("../models/user.model");
const { resolvePlatformClaim } = require("../services/platformClaimService");
const { requirePlatformPermission, observePlatformPermission } = require("../middlewares/requirePlatformPermission");
const { EVENTS } = require("../services/platformAuditService");

const DIR = "39866a06-30bc-4a89-80c6-9dd9357dd453";
const ISSUER = `https://login.microsoftonline.com/${DIR}/v2.0`;
const OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const PID = "6a0000000000000000000a04";
const A = "68cbf7806080b4621d469d34";
const B = "6acd6119b28a863c61361ae0";
const USER = "6a00000000000000000000c4";
const SECRET = "unit-test-only-secret-z4";
const flush = () => new Promise((r) => setImmediate(r));
const PLATFORM_CTX = { actorScope: "platform", actorTenantId: null, targetTenantId: null, loginTenantId: A };

const principal = (o = {}) => ({ _id: PID, issuer: ISSUER, oid: OID, tid: DIR, status: "active", revision: 2, permissions: ["platform:cache:admin"], ...o });
const crmUser = (o = {}) => ({ _id: USER, tenantId: A, userEmail: "platform@example.org", userType: "CRM", userMicrosoftId: OID, userIssuer: ISSUER, isActive: true, ...o });
const lookup = (method, value) =>
  jest.spyOn(method === "findOne" ? PlatformPrincipal : PlatformPrincipal, method).mockImplementation(() => ({ select: () => ({ lean: async () => value }) }));

beforeEach(() => {
  mockPublished.length = 0;
  mockPublishImpl.fn = async () => true;
  process.env.JWT_SECRET = SECRET;
  for (const m of ["info", "warn", "log", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.PLATFORM_AUTH_MODE;
  delete process.env.JWT_SECRET;
});

const noSecrets = (o) => {
  const s = JSON.stringify(o);
  expect(s).not.toContain(OID);
  expect(s).not.toContain(ISSUER);
  expect(s).not.toContain("@");
  expect(s).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
};

describe("claim decisions at CRM sign-in", () => {
  const signIn = (p, user = crmUser()) => {
    lookup("findOne", p);
    return resolvePlatformClaim({ verifiedIdentity: { issuer: ISSUER, oid: OID, tid: DIR, amr: ["pwd", "mfa"] }, user });
  };

  test("issued -> one platform.claim.decision.v1 with platform context owned by the sign-in tenant", async () => {
    process.env.PLATFORM_AUTH_MODE = "shadow";
    const out = await signIn(principal());
    await flush();
    expect(out.decision).toBe("issued");
    expect(mockPublished).toHaveLength(1);
    const [type, data, meta] = mockPublished[0];
    expect(type).toBe(EVENTS.PLATFORM_CLAIM_DECISION);
    expect(meta.tenantId).toBe(A);
    expect(meta.auditContext).toEqual(PLATFORM_CTX);
    expect(data).toEqual({ decision: "issued", mode: "shadow", principalId: PID, actorUserId: USER, currentRev: 2, permissionCount: 1, mfa: "yes" });
    noSecrets(mockPublished);
  });
  test.each([
    ["disabled", principal({ status: "disabled" })],
    ["identity_mismatch", principal({ tid: "11111111-2222-3333-4444-555555555555" })],
  ])("%s (a real principal refused) -> audited", async (decision, p) => {
    process.env.PLATFORM_AUTH_MODE = "shadow";
    expect((await signIn(p)).decision).toBe(decision);
    await flush();
    expect(mockPublished.map((x) => x[1].decision)).toEqual([decision]);
  });
  test("ordinary sign-in (not_principal) and mode off -> no audit event", async () => {
    process.env.PLATFORM_AUTH_MODE = "shadow";
    await signIn(null);
    delete process.env.PLATFORM_AUTH_MODE;
    await signIn(principal());
    await flush();
    expect(mockPublished).toHaveLength(0);
  });
  test("a user without a valid internal tenant -> skipped, never a fabricated tenant", async () => {
    process.env.PLATFORM_AUTH_MODE = "shadow";
    await signIn(principal(), crmUser({ tenantId: "unknown" }));
    await flush();
    expect(mockPublished).toHaveLength(0);
  });
  test("a publish failure never changes the sign-in result", async () => {
    process.env.PLATFORM_AUTH_MODE = "shadow";
    mockPublishImpl.fn = async () => { throw new Error("broker down"); };
    const out = await signIn(principal());
    await flush();
    expect(out.claim).toEqual({ v: 1, pid: PID, rev: 2 });
  });
});

describe("enforced platform authorization (route-enforce guard)", () => {
  const sign = (o = {}) => jwt.sign({ id: USER, sub: USER, tenantId: A, plat: { v: 1, pid: PID, rev: 2 }, ...o }, SECRET, { algorithm: "HS256", expiresIn: "5m" });
  const run = async (mw, { token = sign(), ctx = { userId: USER, tenantId: A }, extraHeaders = {}, query = {}, body = {} } = {}) => {
    lookup("findById", principal());
    jest.spyOn(User, "findOne").mockImplementation(() => ({ select: () => ({ lean: async () => crmUser() }) }));
    const req = { method: "GET", baseUrl: "/api", route: { path: "/platform/authz-probe/:permission" }, headers: { authorization: token ? `Bearer ${token}` : undefined, ...extraHeaders }, query, body, ctx };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    await flush();
    return { res, nextCalled, req };
  };

  test("allow -> one platform.authz.decision.v1 (allowed true), platform context, tenant from trusted ctx", async () => {
    process.env.PLATFORM_AUTH_MODE = "shadow";
    const { nextCalled } = await run(requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }));
    expect(nextCalled).toBe(true);
    expect(mockPublished).toHaveLength(1);
    const [type, data, meta] = mockPublished[0];
    expect(type).toBe(EVENTS.PLATFORM_AUTHZ_DECISION);
    expect(meta).toMatchObject({ tenantId: A, auditContext: PLATFORM_CTX });
    expect(data).toMatchObject({ allowed: true, reason: "allowed", permission: "platform:cache:admin", principalId: PID, actorUserId: USER, tokenRev: 2, currentRev: 2, route: "GET /api/platform/authz-probe/:permission" });
    noSecrets(mockPublished);
  });
  test("403 deny (permission not held) -> audited with allowed false", async () => {
    process.env.PLATFORM_AUTH_MODE = "shadow";
    const { res } = await run(requirePlatformPermission("platform:tenant:create", { mode: "route-enforce" }));
    expect(res.statusCode).toBe(403);
    expect(mockPublished.map((x) => [x[1].allowed, x[1].reason])).toEqual([[false, "permission_missing"]]);
  });
  test("401 (no / invalid token) -> not audited", async () => {
    process.env.PLATFORM_AUTH_MODE = "shadow";
    const { res } = await run(requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }), { token: null });
    expect(res.statusCode).toBe(401);
    expect(mockPublished).toHaveLength(0);
  });
  test("body / query / x-tenant headers can never become the audit owner or target", async () => {
    process.env.PLATFORM_AUTH_MODE = "shadow";
    await run(requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }), {
      extraHeaders: { "x-tenant-id": B, "x-target-tenant-id": B }, query: { tenantId: B, targetTenantId: B }, body: { tenantId: B, auditContext: { actorScope: "tenant", targetTenantId: B } },
    });
    expect(mockPublished).toHaveLength(1);
    expect(mockPublished[0][2]).toMatchObject({ tenantId: A, auditContext: PLATFORM_CTX });
    expect(JSON.stringify(mockPublished)).not.toContain(B);
  });
  test("shadow observers never publish (log-only by design)", async () => {
    process.env.PLATFORM_AUTH_MODE = "shadow";
    const { nextCalled } = await run(observePlatformPermission("platform:cache:admin"));
    expect(nextCalled).toBe(true);
    expect(mockPublished).toHaveLength(0);
  });
  test("a publish failure never changes the authorization response", async () => {
    process.env.PLATFORM_AUTH_MODE = "shadow";
    mockPublishImpl.fn = async () => { throw new Error("broker down"); };
    const allow = await run(requirePlatformPermission("platform:cache:admin", { mode: "route-enforce" }));
    const deny = await run(requirePlatformPermission("platform:tenant:create", { mode: "route-enforce" }));
    expect([allow.nextCalled, deny.res.statusCode]).toEqual([true, 403]);
  });
});
