/**
 * Phase 1B — middlewares/auth.js `authenticate` verification (AUTH-A + AUTH-B).
 *
 * Proves the non-gateway paths now CRYPTOGRAPHICALLY verify ProjectShell HS256
 * tokens (was an unverified jwt.decode), the AUTH_BYPASS path can no longer
 * trust forged/unsigned claims, the gateway-header path is behaviorally
 * unchanged, and a rejected token never calls next() nor leaves a trusted
 * req.ctx/req.tenantId — closing the forged-Bearer exposure on authenticate-
 * only routes such as /api/me.
 *
 * No DB/Redis/network: the shared policy-middleware and roleHierarchyService
 * are mocked; only auth.js logic under test runs.
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const SECRET = "test-hs256-secret-auth-phase1b";
process.env.JWT_SECRET = SECRET;
process.env.NODE_ENV = "test";
delete process.env.AUTH_BYPASS_ENABLED;

// Controllable gateway validator + passthrough tenantContext guard.
const mockValidateGatewayRequest = jest.fn(() => ({ valid: true }));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: (...a) => mockValidateGatewayRequest(...a) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
// roleHierarchyService is only referenced in module.exports; stub it so require
// does not pull in DB/model code.
jest.mock("../services/roleHierarchyService", () => ({
  isSuperUser: () => false,
  isAssistantSuperUser: () => false,
  isSystemAdmin: () => false,
  getHighestRoleLevel: () => 1,
  hasMinimumRole: () => false,
}));

const { authenticate } = require("../middlewares/auth");

const TENANT = "tenant-abc-0001";
const basePayload = (over = {}) => ({
  sub: "user-1",
  tenantId: TENANT,
  email: "u@example.invalid",
  userType: "CRM",
  roles: ["REO"],
  permissions: ["profile:read"],
  ...over,
});
const signHS = (p, s = SECRET, o = {}) =>
  jwt.sign(p, s, { algorithm: "HS256", expiresIn: "1h", ...o });

const gatewayHeaders = (over = {}) => ({
  "x-jwt-verified": "true",
  "x-auth-source": "gateway",
  "x-user-id": "gw-user",
  "x-tenant-id": TENANT,
  "x-user-email": "gw@example.invalid",
  "x-user-type": "CRM",
  "x-user-roles": '["REO"]',
  "x-user-permissions": '["profile:read"]',
  ...over,
});

const run = async (headers, path = "/api/role") => {
  const req = { headers, path };
  const res = {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const next = jest.fn();
  await authenticate(req, res, next);
  return { req, res, next };
};

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  delete process.env.AUTH_BYPASS_ENABLED;
  mockValidateGatewayRequest.mockReset();
  mockValidateGatewayRequest.mockReturnValue({ valid: true });
});

describe("gateway header path (must remain unchanged)", () => {
  test("1 valid validated gateway request accepted", async () => {
    const { res, next } = await run(gatewayHeaders());
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  test("2 invalid gateway validation rejected (401), next not called", async () => {
    mockValidateGatewayRequest.mockReturnValue({ valid: false, reason: "bad-sig" });
    const { res, next } = await run(gatewayHeaders());
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  test("3 missing required gateway identity/tenant rejected (400)", async () => {
    const h = gatewayHeaders(); delete h["x-tenant-id"];
    const { res, next } = await run(h);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  test("4 gateway claim mapping unchanged", async () => {
    const { req, next } = await run(gatewayHeaders());
    expect(next).toHaveBeenCalled();
    expect(req.ctx).toEqual({ tenantId: TENANT, userId: "gw-user", roles: ["REO"], permissions: ["profile:read"] });
    expect(req.tenantId).toBe(TENANT);
    expect(req.user).toMatchObject({ id: "gw-user", tenantId: TENANT, email: "gw@example.invalid", userType: "CRM", roles: ["REO"], permissions: ["profile:read"] });
  });
});

describe("legacy Bearer path — cryptographic verification (AUTH-B)", () => {
  const bearer = (t) => ({ authorization: `Bearer ${t}` });

  test("5 valid HS256 accepted", async () => {
    const { res, next } = await run(bearer(signHS(basePayload())));
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  test("6 valid HS256 preserves existing req.user/req.ctx/tenant/roles/permissions mapping", async () => {
    const payload = basePayload({ sub: "u-9", roles: ["GS"], permissions: ["x:write"] });
    const { req } = await run(bearer(signHS(payload)));
    expect(req.ctx).toEqual({ tenantId: TENANT, userId: "u-9", roles: ["GS"], permissions: ["x:write"] });
    expect(req.tenantId).toBe(TENANT);
    expect(req.userId).toBe("u-9");
    expect(req.roles).toEqual(["GS"]);           // NOT normalized in this path (unchanged)
    expect(req.permissions).toEqual(["x:write"]);
    expect(req.user.sub).toBe("u-9");            // req.user === verified payload
  });

  test("7 wrong-secret rejected (401), no trusted ctx", async () => {
    const { req, res, next } = await run(bearer(signHS(basePayload(), "the-wrong-secret")));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(req.ctx).toBeUndefined();
    expect(req.tenantId).toBeUndefined();
  });

  test("8 forged SU/admin (wrong signature) rejected", async () => {
    const { req, res, next } = await run(bearer(signHS(basePayload({ roles: ["SU"], permissions: ["*"] }), "attacker-secret")));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(req.ctx).toBeUndefined();
  });

  test("9 expired rejected", async () => {
    const { res, next } = await run(bearer(signHS(basePayload(), SECRET, { expiresIn: "-10m" })));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  test("10 alg:none rejected", async () => {
    const none = jwt.sign(basePayload(), "", { algorithm: "none" });
    const { res, next } = await run(bearer(none));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  test("11 RS256 rejected on HS256-only path", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rs = jwt.sign(basePayload(), privateKey, { algorithm: "RS256", expiresIn: "1h" });
    const { res, next } = await run(bearer(rs));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  test("12 malformed rejected", async () => {
    const { res, next } = await run(bearer("not-a-jwt"));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  test("13 missing JWT_SECRET fails closed", async () => {
    delete process.env.JWT_SECRET;
    const { req, res, next } = await run(bearer(signHS(basePayload())));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(req.ctx).toBeUndefined();
  });

  test("14 & 15 rejected token does NOT call next() nor leave trusted ctx/tenant", async () => {
    const { req, next } = await run(bearer(signHS(basePayload(), "wrong")));
    expect(next).not.toHaveBeenCalled();
    expect(req.ctx).toBeUndefined();
    expect(req.tenantId).toBeUndefined();
    expect(req.roles).toBeUndefined();
    expect(req.permissions).toBeUndefined();
  });
});

describe("AUTH_BYPASS path (AUTH-A) — bypass skips authz, never authn", () => {
  const bearer = (t) => ({ authorization: `Bearer ${t}` });
  beforeEach(() => { process.env.AUTH_BYPASS_ENABLED = "true"; });
  afterEach(() => { delete process.env.AUTH_BYPASS_ENABLED; });

  test("16 AUTH_BYPASS + valid signed HS256 accepted", async () => {
    const { req, res, next } = await run(bearer(signHS(basePayload({ roles: ["SU"] }))), "/api/role");
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(req.ctx.tenantId).toBe(TENANT);
  });

  test("17 AUTH_BYPASS + forged token rejected", async () => {
    const { req, res, next } = await run(bearer(signHS(basePayload({ roles: ["SU"] }), "attacker-secret")), "/api/role");
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(req.ctx).toBeUndefined();
  });

  test("18 AUTH_BYPASS + expired token rejected", async () => {
    const { res, next } = await run(bearer(signHS(basePayload(), SECRET, { expiresIn: "-5m" })), "/api/role");
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  test("19 AUTH_BYPASS cannot trust unsigned/arbitrary claims (alg:none)", async () => {
    const none = jwt.sign(basePayload({ roles: ["SU"] }), "", { algorithm: "none" });
    const { req, res, next } = await run(bearer(none), "/api/role");
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(req.ctx).toBeUndefined();
  });
});

describe("/api/me forged-Bearer invariant", () => {
  test("20 forged Bearer on /api/me is rejected before establishing req.ctx", async () => {
    const forged = signHS(basePayload({ sub: "victim", roles: ["SU"] }), "attacker-secret");
    const { req, res, next } = await run({ authorization: `Bearer ${forged}` }, "/api/me");
    expect(next).not.toHaveBeenCalled();     // getMeProfile would never run
    expect(res.statusCode).toBe(401);
    expect(req.ctx).toBeUndefined();          // no trusted identity for the controller
    expect(req.tenantId).toBeUndefined();
  });
});
