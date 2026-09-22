/**
 * handlers/b2c.users.handler.js's decodeIdToken - the live Portal login
 * (/auth/azure-portal) ID token verification path. Uses a throwaway RSA keypair + local
 * JWKS (tests/helpers/testJwt.js) instead of a real Microsoft B2C tenant.
 */
process.env.MS_B2C_DIRECTORY_ID = "test-b2c-directory-id";
// b2cPolicy.js's fallback default - deliberately mixed-case here to match how it's
// actually spelled in code/config, distinct from ISSUER_TENANT_HOST below.
const TEST_TENANT_NAME = "projectshellAB2C";
// Azure B2C always normalizes the b2clogin.com tenant subdomain to lowercase in the
// `iss` claim it issues, regardless of MS_TENANT_NAME's casing - a real token's iss looks
// like this, never like TEST_TENANT_NAME's own casing. getTenantName() in b2cPolicy.js
// lowercases for exactly this reason; these tests build tokens the way Microsoft actually
// does, not the way the tenant name happens to be spelled.
const ISSUER_TENANT_HOST = TEST_TENANT_NAME.toLowerCase();
const TEST_CLIENT_ID = "e3688a2f-3956-42f9-8c98-6fea7a60a5b4"; // this file's own fallback default
const TEST_POLICY = "B2C_1_projectshell_signin"; // getDefaultPolicy()'s fallback default
const EXPECTED_ISSUER = `https://${ISSUER_TENANT_HOST}.b2clogin.com/${process.env.MS_B2C_DIRECTORY_ID}/v2.0/`;

jest.mock("../models/tenant.model", () => ({
  findOne: jest.fn(),
}));
jest.mock("../rabbitMQ/publishers/user.portal.publisher", () => ({
  publishPortalUserCreated: jest.fn(),
  publishPortalUserUpdated: jest.fn(),
}));
jest.mock("../helpers/portalRoleSync", () => ({
  syncPortalUserRolesFromMembership: jest.fn(),
}));

const Tenant = require("../models/tenant.model");
const B2CUsersHandler = require("../handlers/b2c.users.handler");
const {
  makeTestKeypairAndJwks,
  signTestJwt,
  tamperPayload,
} = require("./helpers/testJwt");

function baseClaims(overrides = {}) {
  return {
    iss: EXPECTED_ISSUER,
    aud: TEST_CLIENT_ID,
    tfp: TEST_POLICY,
    oid: "portal-user-oid-1",
    emails: ["member@example.com"],
    given_name: "Member",
    family_name: "One",
    ...overrides,
  };
}

describe("B2CUsersHandler.decodeIdToken", () => {
  let privateKey;
  const expectedNonce = "expected-b2c-nonce";

  beforeAll(async () => {
    const kp = await makeTestKeypairAndJwks();
    privateKey = kp.privateKey;
    B2CUsersHandler._resetJwksForTests(TEST_POLICY, kp.jwks);
  });

  afterAll(() => {
    B2CUsersHandler._resetJwksForTests(TEST_POLICY, null);
  });

  beforeEach(() => {
    Tenant.findOne.mockReset();
  });

  test("valid token, matching policy and nonce, resolves the tenant", async () => {
    Tenant.findOne.mockResolvedValueOnce({
      _id: { toString: () => "tenant-mongo-id-b2c" },
      name: "Test Tenant",
      code: "TT",
    });

    const token = await signTestJwt(privateKey, baseClaims({ nonce: expectedNonce }));

    const profile = await B2CUsersHandler.decodeIdToken(token, TEST_POLICY, expectedNonce);

    expect(profile.tenantId).toBe("tenant-mongo-id-b2c");
    expect(profile.userEmail).toBe("member@example.com");
    expect(Tenant.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        "authenticationConnections.connectionType": "Azure B2C",
        "authenticationConnections.directoryId": process.env.MS_B2C_DIRECTORY_ID,
      }),
    );
  });

  test("missing expectedNonce is rejected before any verification is attempted", async () => {
    const token = await signTestJwt(privateKey, baseClaims());

    await expect(
      B2CUsersHandler.decodeIdToken(token, TEST_POLICY, undefined),
    ).rejects.toThrow(/missing expected nonce/i);
    expect(Tenant.findOne).not.toHaveBeenCalled();
  });

  test("nonce mismatch fails", async () => {
    const token = await signTestJwt(privateKey, baseClaims({ nonce: "wrong-nonce" }));

    await expect(
      B2CUsersHandler.decodeIdToken(token, TEST_POLICY, expectedNonce),
    ).rejects.toThrow(/nonce mismatch/i);
  });

  test("token issued under a different policy than the login transaction fails", async () => {
    const token = await signTestJwt(
      privateKey,
      baseClaims({ nonce: expectedNonce, tfp: "B2C_1_password_reset" }),
    );

    await expect(
      B2CUsersHandler.decodeIdToken(token, TEST_POLICY, expectedNonce),
    ).rejects.toThrow(/policy/i);
  });

  test("policy not in the allow-list is rejected before verification", async () => {
    const token = await signTestJwt(privateKey, baseClaims({ nonce: expectedNonce }));

    await expect(
      B2CUsersHandler.decodeIdToken(token, "B2C_1_not_a_real_policy", expectedNonce),
    ).rejects.toThrow(/policy not allowed/i);
  });

  test("wrong issuer (different B2C tenant) fails", async () => {
    const token = await signTestJwt(
      privateKey,
      baseClaims({
        nonce: expectedNonce,
        iss: `https://${ISSUER_TENANT_HOST}.b2clogin.com/some-other-directory-id/v2.0/`,
      }),
    );

    await expect(
      B2CUsersHandler.decodeIdToken(token, TEST_POLICY, expectedNonce),
    ).rejects.toThrow();
  });

  // Regression test for the real production failure: MS_TENANT_NAME (or its unset
  // fallback, "projectshellAB2C") is mixed-case, but Azure B2C always issues `iss` with
  // the tenant subdomain lowercased - a real login was rejected with
  // ERR_JWT_CLAIM_VALIDATION_FAILED on `iss` until getTenantName() started lowercasing.
  test("real B2C tokens (lowercased issuer host) validate against a mixed-case configured tenant name", async () => {
    expect(TEST_TENANT_NAME).not.toBe(ISSUER_TENANT_HOST); // sanity: the two truly differ in casing
    Tenant.findOne.mockResolvedValueOnce({
      _id: { toString: () => "tenant-mongo-id-b2c" },
      name: "Test Tenant",
      code: "TT",
    });

    const token = await signTestJwt(
      privateKey,
      baseClaims({
        nonce: expectedNonce,
        iss: `https://${ISSUER_TENANT_HOST}.b2clogin.com/${process.env.MS_B2C_DIRECTORY_ID}/v2.0/`,
      }),
    );

    const profile = await B2CUsersHandler.decodeIdToken(token, TEST_POLICY, expectedNonce);
    expect(profile.tenantId).toBe("tenant-mongo-id-b2c");
  });

  test("wrong audience fails", async () => {
    const token = await signTestJwt(
      privateKey,
      baseClaims({ nonce: expectedNonce, aud: "some-other-client-id" }),
    );

    await expect(
      B2CUsersHandler.decodeIdToken(token, TEST_POLICY, expectedNonce),
    ).rejects.toThrow();
  });

  test("expired token fails", async () => {
    const token = await signTestJwt(
      privateKey,
      baseClaims({ nonce: expectedNonce }),
      { expiresInSeconds: -60 },
    );

    await expect(
      B2CUsersHandler.decodeIdToken(token, TEST_POLICY, expectedNonce),
    ).rejects.toThrow();
  });

  test("modified payload with the original signature fails", async () => {
    const token = await signTestJwt(privateKey, baseClaims({ nonce: expectedNonce }));
    const tampered = tamperPayload(token, (claims) => ({
      ...claims,
      emails: ["attacker@example.com"],
    }));

    await expect(
      B2CUsersHandler.decodeIdToken(tampered, TEST_POLICY, expectedNonce),
    ).rejects.toThrow();
  });

  test("forged signature (different keypair) fails", async () => {
    const forgedKp = await makeTestKeypairAndJwks();
    const token = await signTestJwt(
      forgedKp.privateKey,
      baseClaims({ nonce: expectedNonce }),
    );

    await expect(
      B2CUsersHandler.decodeIdToken(token, TEST_POLICY, expectedNonce),
    ).rejects.toThrow();
  });
});
