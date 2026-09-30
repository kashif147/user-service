/**
 * Phase 1B — PDP token-verification chokepoint + cache-ordering invariant.
 *
 * Proves two things about services/policyEvaluationService:
 *
 *  1. validateToken() CRYPTOGRAPHICALLY verifies ProjectShell HS256 tokens
 *     (signature + exp + algorithm allowlist) instead of the previous
 *     unverified jwt.decode, preserving the return contract.
 *
 *  2. evaluatePolicy() (the token branch) NEVER returns a cached authorization
 *     decision before the token has been cryptographically verified, and its
 *     decision cache is keyed to the VERIFIED identity (not the old
 *     token.substring(0, 8) prefix, which is the constant "eyJhbGci" for every
 *     HS256 JWT). So a forged/other token can never inherit another identity's
 *     cached PERMIT, while the same verified identity can still reuse the cache.
 *
 * The gateway/header path (evaluatePolicyWithHeaders) is out of scope here.
 *
 * Deterministic test secrets only; no external JWKS/network. The cache is a
 * controllable in-memory mock (real get/set + the real generateKey algorithm)
 * so the security tests exercise the true production ordering rather than
 * bypassing it. The SU paths short-circuit before any DB-backed lookup
 * (isSuperUser is a pure role-code check), keeping evaluation deterministic.
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

// Must be set BEFORE requiring the service (cache reads REDIS_ENABLED at load).
process.env.REDIS_ENABLED = "false";
process.env.JWT_SECRET = "test-hs256-secret-phase1b";
process.env.NODE_ENV = "test";
delete process.env.AUTH_BYPASS_ENABLED;

// Controllable, Redis-free PDP cache. Backed by a real Map so cache HITS are
// possible (we must be able to reproduce the previous cross-token collision and
// prove the new ordering prevents it), and generateKey mirrors the real
// PolicyCache.generateKey algorithm so keys behave exactly as in production.
// Names are `mock`-prefixed so jest allows referencing them from the factory.
const mockCacheStore = new Map();
const mockCacheGet = jest.fn(async (key) =>
  mockCacheStore.has(key) ? mockCacheStore.get(key) : null
);
const mockCacheSet = jest.fn(async (key, value) => {
  mockCacheStore.set(key, value);
});
const mockHashString = (str) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
};
const mockGenerateKey = (tokenHash, resource, action, context = {}) => {
  const tenantId = (context && context.tenantId) || "default";
  const contextStr = JSON.stringify(context);
  return `${tenantId}:${tokenHash}:${resource}:${action}:${mockHashString(
    contextStr
  )}`;
};

jest.mock("../services/policyCache", () =>
  jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    get: mockCacheGet,
    set: mockCacheSet,
    clear: jest.fn(async () => mockCacheStore.clear()),
    generateKey: mockGenerateKey,
    getStats: jest.fn().mockResolvedValue({}),
  }))
);

const policyService = require("../services/policyEvaluationService");
const { validateToken, evaluatePolicy } = policyService;

const SECRET = "test-hs256-secret-phase1b";
const TENANT = "68cbf7806080b4621d469d34";
const OTHER_TENANT = "aaaaaaaaaaaaaaaaaaaaaaaa";

const basePayload = (over = {}) => ({
  sub: "user-1",
  tenantId: TENANT,
  email: "u@example.invalid",
  userType: "CRM",
  roles: ["MEMBER"],
  permissions: ["profile:read"],
  ...over,
});

const signHS = (payload, secret = SECRET, opts = {}) =>
  jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: "1h", ...opts });

// A legitimately-signed SU token for a specific identity/tenant. SU short-
// circuits to PERMIT before any DB-backed policy lookup, so these evaluations
// are deterministic and network-free.
const suToken = (sub, tenantId = TENANT) =>
  signHS(basePayload({ sub, tenantId, roles: ["SU"] }));

beforeEach(() => {
  process.env.JWT_SECRET = SECRET; // some tests mutate it
  mockCacheStore.clear();
  mockCacheGet.mockClear();
  mockCacheSet.mockClear();
});

describe("validateToken — HS256 cryptographic verification (Phase 1B)", () => {
  test("1 valid HS256 token → accepted with correct user mapping", async () => {
    const r = await validateToken(signHS(basePayload()));
    expect(r.valid).toBe(true);
    expect(r.user).toMatchObject({
      id: "user-1",
      tenantId: TENANT,
      email: "u@example.invalid",
      userType: "CRM",
      roles: ["MEMBER"],
      permissions: ["profile:read"],
    });
    expect(typeof r.expiresAt).toBe("string");
  });

  test("2 wrong-secret HS256 → rejected (INVALID_SIGNATURE)", async () => {
    const r = await validateToken(signHS(basePayload(), "the-wrong-secret"));
    expect(r.valid).toBe(false);
    expect(r.error).toBe("INVALID_SIGNATURE");
  });

  test("3 forged SU payload with invalid signature → rejected", async () => {
    const forged = signHS(
      basePayload({ roles: ["SU"], permissions: ["*"] }),
      "attacker-secret"
    );
    const r = await validateToken(forged);
    expect(r.valid).toBe(false);
    expect(r.user).toBeUndefined();
  });

  test("4 expired HS256 → rejected (TOKEN_EXPIRED)", async () => {
    const expired = signHS(basePayload(), SECRET, { expiresIn: "-10m" });
    const r = await validateToken(expired);
    expect(r.valid).toBe(false);
    expect(r.error).toBe("TOKEN_EXPIRED");
  });

  test("5 alg:none → rejected", async () => {
    const none = jwt.sign(basePayload(), "", { algorithm: "none" });
    const r = await validateToken(none);
    expect(r.valid).toBe(false);
    expect(["UNSUPPORTED_ALGORITHM", "INVALID_SIGNATURE", "MALFORMED_TOKEN"]).toContain(
      r.error
    );
  });

  test("6 RS256 token → rejected on the HS256-only path", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const rs = jwt.sign(basePayload(), privateKey, {
      algorithm: "RS256",
      expiresIn: "1h",
    });
    const r = await validateToken(rs);
    expect(r.valid).toBe(false);
    expect(["UNSUPPORTED_ALGORITHM", "INVALID_SIGNATURE"]).toContain(r.error);
  });

  test("7 malformed token → rejected", async () => {
    const r = await validateToken("not-a-jwt");
    expect(r.valid).toBe(false);
    expect(["MALFORMED_TOKEN", "INVALID_SIGNATURE"]).toContain(r.error);
  });

  test("8 missing JWT_SECRET → fail closed (JWT_SECRET_MISSING), no claim trust", async () => {
    const valid = signHS(basePayload());
    delete process.env.JWT_SECRET;
    const r = await validateToken(valid);
    expect(r.valid).toBe(false);
    expect(r.error).toBe("JWT_SECRET_MISSING");
    expect(r.user).toBeUndefined();
  });

  test("9 valid token returns the same claim mapping (roles normalized from objects)", async () => {
    const r = await validateToken(
      signHS(basePayload({ roles: [{ code: "REO" }, "MEMBER"] }))
    );
    expect(r.valid).toBe(true);
    expect(r.user.roles).toEqual(["REO", "MEMBER"]);
    expect(r.user.tenantId).toBe(TENANT);
  });
});

describe("PDP decisions via evaluatePolicy (token branch) — security proofs", () => {
  test("10 valid SU token → PERMIT (legitimate decision unchanged; pure isSuperUser)", async () => {
    const res = await evaluatePolicy({
      token: suToken("su-user"),
      resource: "role",
      action: "read",
      context: {},
    });
    expect(res.decision).toBe("PERMIT");
  });

  test("11 valid token but caller context.tenantId mismatch → DENY (TENANT_MISMATCH)", async () => {
    const res = await evaluatePolicy({
      token: suToken("su-user"),
      resource: "role",
      action: "read",
      context: { tenantId: OTHER_TENANT },
    });
    expect(res.decision).toBe("DENY");
    expect(res.reason).toBe("TENANT_MISMATCH");
  });
});

describe("PDP cache ordering & identity binding (Phase 1B invariant)", () => {
  test("A valid SU token is evaluated and its PERMIT is cached", async () => {
    const res = await evaluatePolicy({
      token: suToken("su-a", TENANT),
      resource: "role",
      action: "read",
      context: {},
    });
    expect(res.decision).toBe("PERMIT");
    expect(res.cached).not.toBe(true); // freshly computed, not a cache hit
    expect(mockCacheSet).toHaveBeenCalled();
    expect(mockCacheStore.size).toBe(1);
  });

  test("B a different forged SU token is rejected BEFORE cache and cannot receive the cached PERMIT", async () => {
    // Seed identity A's legitimate PERMIT for role:read.
    await evaluatePolicy({
      token: suToken("su-a", TENANT),
      resource: "role",
      action: "read",
      context: {},
    });
    expect(mockCacheStore.size).toBe(1);

    // Forged SU token: same identity claims + same resource/action/context,
    // but signed with the wrong secret. Under the OLD ordering this would have
    // hit the cached PERMIT via the constant "eyJhbGci" token prefix.
    const forged = signHS(
      basePayload({ sub: "su-a", tenantId: TENANT, roles: ["SU"], permissions: ["*"] }),
      "attacker-secret"
    );
    mockCacheGet.mockClear();
    const res = await evaluatePolicy({
      token: forged,
      resource: "role",
      action: "read",
      context: {},
    });

    expect(res.decision).toBe("DENY");
    expect(res.reason).toBe("INVALID_TOKEN");
    expect(res.decision).not.toBe("PERMIT");
    expect(res.cached).not.toBe(true);
    // The token failed verification, so NO authorization cache lookup happened.
    expect(mockCacheGet).not.toHaveBeenCalled();
  });

  test("C a distinct verified identity does not inherit another identity's cached decision", async () => {
    // Identity A (SU, TENANT) caches a PERMIT.
    await evaluatePolicy({
      token: suToken("su-a", TENANT),
      resource: "role",
      action: "read",
      context: {},
    });
    const aKey = mockCacheSet.mock.calls[0][0];

    // Identity B — a DIFFERENT verified identity (different user id + tenant).
    // Both are SU to keep evaluation DB-free; the invariant under test is that
    // B gets a DIFFERENT cache key and a cache MISS, so it cannot read A's entry.
    mockCacheGet.mockClear();
    const res = await evaluatePolicy({
      token: suToken("su-b", OTHER_TENANT),
      resource: "role",
      action: "read",
      context: {},
    });
    const lookedUpKeys = mockCacheGet.mock.calls.map((c) => c[0]);

    expect(lookedUpKeys.length).toBeGreaterThan(0); // B did look up the cache
    expect(lookedUpKeys).not.toContain(aKey); // ...but never at A's key
    expect(res.cached).not.toBe(true); // it was a miss → fresh evaluation
    expect(res.user.tenantId).toBe(OTHER_TENANT); // B's own identity, not A's
  });

  test("D an invalid token triggers no authorization cache lookup", async () => {
    mockCacheGet.mockClear();
    const res = await evaluatePolicy({
      token: "not-a-jwt",
      resource: "role",
      action: "read",
      context: {},
    });
    expect(res.decision).toBe("DENY");
    expect(mockCacheGet).not.toHaveBeenCalled();
  });

  test("E cache key differs across distinct verified identities", async () => {
    await evaluatePolicy({
      token: suToken("su-a", TENANT),
      resource: "role",
      action: "read",
      context: {},
    });
    await evaluatePolicy({
      token: suToken("su-b", OTHER_TENANT),
      resource: "role",
      action: "read",
      context: {},
    });
    const setKeys = mockCacheSet.mock.calls.map((c) => c[0]);
    expect(setKeys.length).toBe(2);
    expect(setKeys[0]).not.toBe(setKeys[1]);
  });

  test("F the same verified identity reuses the cache across requests with different correlationIds", async () => {
    const token = suToken("su-a", TENANT);
    const r1 = await evaluatePolicy({
      token,
      resource: "role",
      action: "read",
      context: { correlationId: "req-1" },
    });
    expect(r1.decision).toBe("PERMIT");
    expect(r1.cached).not.toBe(true); // first call computes + caches

    const r2 = await evaluatePolicy({
      token,
      resource: "role",
      action: "read",
      context: { correlationId: "req-2" }, // different per-request correlationId
    });
    expect(r2.decision).toBe("PERMIT");
    // Cache HIT despite a different correlationId → the key is bound to verified
    // identity + target, and security does NOT depend on correlationId.
    expect(r2.cached).toBe(true);
  });
});

describe("PDP cache-key includes every decision-relevant verified attribute (Phase 1B)", () => {
  // SU short-circuits to PERMIT regardless of userType/extra roles, so these
  // evaluations stay DB-free while differing only in the digested attribute.
  const suWith = (over) =>
    signHS(basePayload({ sub: "su-a", tenantId: TENANT, roles: ["SU"], ...over }));

  test("G same id/tenant/roles/permissions but different userType → different cache key", async () => {
    await evaluatePolicy({
      token: suWith({ userType: "CRM" }),
      resource: "role",
      action: "read",
      context: {},
    });
    await evaluatePolicy({
      token: suWith({ userType: "ADMIN" }),
      resource: "role",
      action: "read",
      context: {},
    });
    const keys = mockCacheSet.mock.calls.map((c) => c[0]);
    expect(keys.length).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("H same id/tenant but different verified roles → different cache key", async () => {
    await evaluatePolicy({
      token: suWith({ roles: ["SU"] }),
      resource: "role",
      action: "read",
      context: {},
    });
    await evaluatePolicy({
      token: suWith({ roles: ["SU", "GS"] }),
      resource: "role",
      action: "read",
      context: {},
    });
    const keys = mockCacheSet.mock.calls.map((c) => c[0]);
    expect(keys.length).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("I identical decision-relevant verified claims reuse the cache despite different JWT bytes / irrelevant claims", async () => {
    // Two valid HS256 tokens with IDENTICAL authorization-relevant claims
    // (same sub/id, tenantId, userType, roles, permissions) but a different
    // harmless non-authorization claim (jti). jti is NOT part of the cache key.
    const claims = {
      sub: "su-a",
      tenantId: TENANT,
      userType: "CRM",
      roles: ["SU"],
      permissions: ["profile:read"],
    };
    const tokenA = signHS({ ...claims, jti: "token-a" });
    const tokenB = signHS({ ...claims, jti: "token-b" });
    expect(tokenA).not.toBe(tokenB); // genuinely different JWT byte strings

    const r1 = await evaluatePolicy({
      token: tokenA,
      resource: "role",
      action: "read",
      context: {},
    });
    expect(r1.decision).toBe("PERMIT");
    expect(r1.cached).not.toBe(true); // fresh decision, populates the cache

    const r2 = await evaluatePolicy({
      token: tokenB,
      resource: "role",
      action: "read",
      context: {},
    });
    expect(r2.decision).toBe("PERMIT");
    // Cache HIT → reuse depends on verified decision-relevant identity state,
    // not raw JWT bytes or irrelevant claims (jti).
    expect(r2.cached).toBe(true);
  });
});
