/**
 * Crypto matrix for POST /api/internal/verify-ms-token - the endpoint verify_jwt.lua's
 * RS256 branch delegates to instead of hand-rolling JWKS verification in Lua. Uses a
 * throwaway RSA keypair + local JWKS (tests/helpers/testJwt.js) so this runs without any
 * network access to a real Microsoft tenant.
 */
const TEST_TENANT_ID = "39866a06-30bc-4a89-80c6-9dd9357dd453"; // matches this repo's fallback default
const TEST_APP_ID = "ad25f823-e2d3-43e2-bea5-a9e6c9b0dbae"; // matches this repo's fallback default
const EXPECTED_ISSUER = `https://login.microsoftonline.com/${TEST_TENANT_ID}/v2.0`;
const EXPECTED_AUDIENCE = `api://${TEST_APP_ID}`;

process.env.AZURE_AD_TENANT_ID = TEST_TENANT_ID;
process.env.BACKEND_API_APP_ID = TEST_APP_ID;
process.env.GATEWAY_VERIFY_SECRET = "test-gateway-verify-secret";

const {
  verifyMsToken,
  requireInternalSecret,
  _resetJwksForTests,
} = require("../controllers/internalMsTokenVerification.controller");
const {
  makeTestKeypairAndJwks,
  signTestJwt,
  makeUnsignedJwt,
  tamperPayload,
} = require("./helpers/testJwt");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function baseClaims(overrides = {}) {
  return {
    iss: EXPECTED_ISSUER,
    aud: EXPECTED_AUDIENCE,
    tid: TEST_TENANT_ID,
    oid: "00000000-0000-0000-0000-000000000001",
    sub: "test-subject",
    preferred_username: "user@example.com",
    ...overrides,
  };
}

describe("POST /api/internal/verify-ms-token - crypto matrix", () => {
  let privateKey;

  beforeAll(async () => {
    const kp = await makeTestKeypairAndJwks();
    privateKey = kp.privateKey;
    _resetJwksForTests(kp.jwks);
  });

  afterAll(() => {
    _resetJwksForTests(null);
  });

  test("valid, correctly-signed token succeeds", async () => {
    const token = await signTestJwt(privateKey, baseClaims());
    const req = { body: { token }, headers: {} };
    const res = mockRes();

    await verifyMsToken(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.verified).toBe(true);
    expect(payload.tid).toBe(TEST_TENANT_ID);
    expect(payload.oid).toBe("00000000-0000-0000-0000-000000000001");
  });

  test("forged token (real structure, wrong/unknown signing key) fails", async () => {
    // Sign with a completely different keypair than the one the verifier trusts.
    const forgedKp = await makeTestKeypairAndJwks();
    const token = await signTestJwt(forgedKp.privateKey, baseClaims());

    const req = { body: { token }, headers: {} };
    const res = mockRes();

    await verifyMsToken(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].verified).toBe(false);
  });

  test("unsigned token (alg: none) fails", async () => {
    const token = makeUnsignedJwt(baseClaims());
    const req = { body: { token }, headers: {} };
    const res = mockRes();

    await verifyMsToken(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("modified payload with original signature fails", async () => {
    const token = await signTestJwt(privateKey, baseClaims());
    const tampered = tamperPayload(token, (claims) => ({
      ...claims,
      oid: "attacker-controlled-oid",
      roles: ["SU"],
    }));

    const req = { body: { token: tampered }, headers: {} };
    const res = mockRes();

    await verifyMsToken(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("wrong issuer fails", async () => {
    const token = await signTestJwt(
      privateKey,
      baseClaims({ iss: "https://login.microsoftonline.com/some-other-tenant/v2.0" }),
    );
    const req = { body: { token }, headers: {} };
    const res = mockRes();

    await verifyMsToken(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("wrong audience fails", async () => {
    const token = await signTestJwt(privateKey, baseClaims({ aud: "api://some-other-app" }));
    const req = { body: { token }, headers: {} };
    const res = mockRes();

    await verifyMsToken(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("wrong tenant (tid mismatch, issuer otherwise unchanged) fails", async () => {
    // iss stays correct (so it passes jose's issuer check) but tid claim itself disagrees -
    // exercises the explicit defense-in-depth tid check.
    const token = await signTestJwt(
      privateKey,
      baseClaims({ tid: "11111111-1111-1111-1111-111111111111" }),
    );
    const req = { body: { token }, headers: {} };
    const res = mockRes();

    await verifyMsToken(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("expired token fails", async () => {
    const token = await signTestJwt(privateKey, baseClaims(), { expiresInSeconds: -60 });
    const req = { body: { token }, headers: {} };
    const res = mockRes();

    await verifyMsToken(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("future nbf (not yet valid) token fails", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signTestJwt(privateKey, baseClaims({ nbf: now + 3600 }));
    const req = { body: { token }, headers: {} };
    const res = mockRes();

    await verifyMsToken(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("unsupported algorithm (HS256) fails even with a technically valid signature", async () => {
    // jose's own jwt/sign helper for HMAC would require a shared secret; simplest here is
    // to hand-craft a structurally valid HS256 token and confirm the RS256-only verifier
    // rejects it purely on algorithm, before any signature check could matter.
    const crypto = require("crypto");
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    );
    const payload = Buffer.from(JSON.stringify(baseClaims())).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const sig = crypto
      .createHmac("sha256", "arbitrary-secret")
      .update(signingInput)
      .digest("base64url");
    const token = `${signingInput}.${sig}`;

    const req = { body: { token }, headers: {} };
    const res = mockRes();

    await verifyMsToken(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("missing token fails with 400", async () => {
    const req = { body: {}, headers: {} };
    const res = mockRes();

    await verifyMsToken(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("does not leak the raw error message or token back to the caller", async () => {
    const token = await signTestJwt(privateKey, baseClaims(), { expiresInSeconds: -60 });
    const req = { body: { token }, headers: {} };
    const res = mockRes();

    await verifyMsToken(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe("Token verification failed");
    expect(JSON.stringify(body)).not.toContain(token);
  });
});

describe("requireInternalSecret middleware", () => {
  const OLD_SECRET = process.env.GATEWAY_VERIFY_SECRET;

  afterEach(() => {
    process.env.GATEWAY_VERIFY_SECRET = OLD_SECRET;
  });

  test("rejects when GATEWAY_VERIFY_SECRET is unset", () => {
    delete process.env.GATEWAY_VERIFY_SECRET;
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    requireInternalSecret(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test("rejects a missing/mismatched x-service-secret header", () => {
    process.env.GATEWAY_VERIFY_SECRET = "real-secret";
    const req = { headers: { "x-service-secret": "wrong-secret" } };
    const res = mockRes();
    const next = jest.fn();

    requireInternalSecret(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test("passes through with the correct shared secret", () => {
    process.env.GATEWAY_VERIFY_SECRET = "real-secret";
    const req = { headers: { "x-service-secret": "real-secret" } };
    const res = mockRes();
    const next = jest.fn();

    requireInternalSecret(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
