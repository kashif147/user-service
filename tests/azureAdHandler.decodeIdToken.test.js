/**
 * handlers/azure.ad.handler.js's decodeIdToken - the live CRM login (/auth/azure-crm)
 * ID token verification path. Uses a throwaway RSA keypair + local JWKS
 * (tests/helpers/testJwt.js) instead of a real Microsoft tenant.
 */
const TEST_TENANT_ID = "39866a06-30bc-4a89-80c6-9dd9357dd453"; // this file's own fallback default
const TEST_CLIENT_ID = "ad25f823-e2d3-43e2-bea5-a9e6c9b0dbae"; // this file's own fallback default
const EXPECTED_ISSUER = `https://login.microsoftonline.com/${TEST_TENANT_ID}/v2.0`;

jest.mock("../models/tenant.model", () => ({
  findOne: jest.fn(),
}));
jest.mock("../rabbitMQ/publishers/user.crm.publisher", () => ({
  publishCrmUserCreated: jest.fn(),
  publishCrmUserUpdated: jest.fn(),
}));

const Tenant = require("../models/tenant.model");
const AzureADHandler = require("../handlers/azure.ad.handler");
const {
  makeTestKeypairAndJwks,
  signTestJwt,
  tamperPayload,
} = require("./helpers/testJwt");

function baseClaims(overrides = {}) {
  return {
    iss: EXPECTED_ISSUER,
    aud: TEST_CLIENT_ID,
    tid: TEST_TENANT_ID,
    oid: "user-oid-1",
    email: "staff@example.com",
    name: "Staff Member",
    ...overrides,
  };
}

describe("AzureADHandler.decodeIdToken", () => {
  let privateKey;
  const expectedNonce = "expected-nonce-value";

  beforeAll(async () => {
    const kp = await makeTestKeypairAndJwks();
    privateKey = kp.privateKey;
    AzureADHandler._resetJwksForTests(kp.jwks);
  });

  afterAll(() => {
    AzureADHandler._resetJwksForTests(null);
  });

  beforeEach(() => {
    Tenant.findOne.mockReset();
  });

  test("valid token with matching nonce resolves the tenant and returns a profile", async () => {
    Tenant.findOne.mockResolvedValueOnce({
      _id: { toString: () => "tenant-mongo-id-1" },
      name: "Test Tenant",
      code: "TT",
    });

    const token = await signTestJwt(privateKey, baseClaims({ nonce: expectedNonce }));

    const profile = await AzureADHandler.decodeIdToken(token, expectedNonce);

    expect(profile.tenantId).toBe("tenant-mongo-id-1");
    expect(profile.userEmail).toBe("staff@example.com");
    expect(Tenant.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        "authenticationConnections.connectionType": "Entra ID (Azure AD)",
        "authenticationConnections.directoryId": TEST_TENANT_ID,
      }),
    );
  });

  test("missing expectedNonce is rejected before any verification is attempted", async () => {
    const token = await signTestJwt(privateKey, baseClaims());

    await expect(AzureADHandler.decodeIdToken(token, undefined)).rejects.toThrow(
      /missing expected nonce/i,
    );
    expect(Tenant.findOne).not.toHaveBeenCalled();
  });

  test("nonce mismatch (replay of a valid token against a different session) fails", async () => {
    const token = await signTestJwt(privateKey, baseClaims({ nonce: "a-different-nonce" }));

    await expect(AzureADHandler.decodeIdToken(token, expectedNonce)).rejects.toThrow(
      /nonce mismatch/i,
    );
    expect(Tenant.findOne).not.toHaveBeenCalled();
  });

  test("wrong tenant (tid claim disagrees with the pinned tenant) fails", async () => {
    // Signing with a mismatched iss would already fail jose's own issuer check; this
    // covers the case where a forged token's tid disagrees while somehow using the
    // pinned issuer string - defense in depth, not reachable via normal token issuance.
    const token = await signTestJwt(
      privateKey,
      baseClaims({ nonce: expectedNonce, tid: "11111111-1111-1111-1111-111111111111" }),
    );

    await expect(AzureADHandler.decodeIdToken(token, expectedNonce)).rejects.toThrow();
    expect(Tenant.findOne).not.toHaveBeenCalled();
  });

  test("wrong audience fails", async () => {
    const token = await signTestJwt(
      privateKey,
      baseClaims({ nonce: expectedNonce, aud: "some-other-client-id" }),
    );

    await expect(AzureADHandler.decodeIdToken(token, expectedNonce)).rejects.toThrow();
  });

  test("expired token fails", async () => {
    const token = await signTestJwt(
      privateKey,
      baseClaims({ nonce: expectedNonce }),
      { expiresInSeconds: -60 },
    );

    await expect(AzureADHandler.decodeIdToken(token, expectedNonce)).rejects.toThrow();
  });

  test("modified payload with the original signature fails", async () => {
    const token = await signTestJwt(privateKey, baseClaims({ nonce: expectedNonce }));
    const tampered = tamperPayload(token, (claims) => ({ ...claims, oid: "attacker-oid" }));

    await expect(AzureADHandler.decodeIdToken(tampered, expectedNonce)).rejects.toThrow();
  });

  test("forged signature (different keypair) fails", async () => {
    const forgedKp = await makeTestKeypairAndJwks();
    const token = await signTestJwt(
      forgedKp.privateKey,
      baseClaims({ nonce: expectedNonce }),
    );

    await expect(AzureADHandler.decodeIdToken(token, expectedNonce)).rejects.toThrow();
  });

  test("no matching Tenant document fails closed even with a valid, verified token", async () => {
    Tenant.findOne.mockResolvedValueOnce(null);
    const token = await signTestJwt(privateKey, baseClaims({ nonce: expectedNonce }));

    await expect(AzureADHandler.decodeIdToken(token, expectedNonce)).rejects.toThrow(
      /Tenant not found/i,
    );
  });
});
