/**
 * handlers/azure.ad.handler.js's decodeIdToken - the live CRM login (/auth/azure-crm)
 * ID token verification path. Uses a throwaway RSA keypair + local JWKS
 * (tests/helpers/testJwt.js) instead of a real Microsoft tenant.
 */
const TEST_TENANT_ID = "39866a06-30bc-4a89-80c6-9dd9357dd453"; // = tests/setupEntraEnv.js
const TEST_CLIENT_ID = "ad25f823-e2d3-43e2-bea5-a9e6c9b0dbae"; // = tests/setupEntraEnv.js
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
const { resolveConnectionAuthConfig } = require("../helpers/connectionAuthConfig");
// The configuration a sign-in verifies against (here: the CRM app's home directory).
const entraConfig = () => resolveConnectionAuthConfig(null, { connectionType: "Entra ID (Azure AD)" });
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

  test("valid token with matching nonce returns the identity profile; no tenant is looked up", async () => {
    const token = await signTestJwt(privateKey, baseClaims({ nonce: expectedNonce }));

    const profile = await AzureADHandler.decodeIdToken(token, expectedNonce, entraConfig());

    expect(profile.userEmail).toBe("staff@example.com");
    expect(profile.microsoftDirectoryId).toBe(TEST_TENANT_ID);
    // The directory only says who issued the token; the ProjectShell tenant is resolved later
    // (login context or the user's own record), never by a first-found directory lookup.
    expect(profile).not.toHaveProperty("tenantId");
    expect(Tenant.findOne).not.toHaveBeenCalled();
  });

  test("missing expectedNonce is rejected before any verification is attempted", async () => {
    const token = await signTestJwt(privateKey, baseClaims());

    await expect(AzureADHandler.decodeIdToken(token, undefined, entraConfig())).rejects.toThrow(
      /missing expected nonce/i,
    );
    expect(Tenant.findOne).not.toHaveBeenCalled();
  });

  test("nonce mismatch (replay of a valid token against a different session) fails", async () => {
    const token = await signTestJwt(privateKey, baseClaims({ nonce: "a-different-nonce" }));

    await expect(AzureADHandler.decodeIdToken(token, expectedNonce, entraConfig())).rejects.toThrow(
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

    await expect(AzureADHandler.decodeIdToken(token, expectedNonce, entraConfig())).rejects.toThrow();
    expect(Tenant.findOne).not.toHaveBeenCalled();
  });

  test("wrong audience fails", async () => {
    const token = await signTestJwt(
      privateKey,
      baseClaims({ nonce: expectedNonce, aud: "some-other-client-id" }),
    );

    await expect(AzureADHandler.decodeIdToken(token, expectedNonce, entraConfig())).rejects.toThrow();
  });

  test("expired token fails", async () => {
    const token = await signTestJwt(
      privateKey,
      baseClaims({ nonce: expectedNonce }),
      { expiresInSeconds: -60 },
    );

    await expect(AzureADHandler.decodeIdToken(token, expectedNonce, entraConfig())).rejects.toThrow();
  });

  test("modified payload with the original signature fails", async () => {
    const token = await signTestJwt(privateKey, baseClaims({ nonce: expectedNonce }));
    const tampered = tamperPayload(token, (claims) => ({ ...claims, oid: "attacker-oid" }));

    await expect(AzureADHandler.decodeIdToken(tampered, expectedNonce, entraConfig())).rejects.toThrow();
  });

  test("forged signature (different keypair) fails", async () => {
    const forgedKp = await makeTestKeypairAndJwks();
    const token = await signTestJwt(
      forgedKp.privateKey,
      baseClaims({ nonce: expectedNonce }),
    );

    await expect(AzureADHandler.decodeIdToken(token, expectedNonce, entraConfig())).rejects.toThrow();
  });

  test("a directory shared by several tenants is never resolved to a first-found tenant here", async () => {
    // Even if a directory lookup would return some tenant, decodeIdToken does not ask.
    Tenant.findOne.mockResolvedValue({ _id: { toString: () => "first-found-tenant" } });
    const token = await signTestJwt(privateKey, baseClaims({ nonce: expectedNonce }));

    const profile = await AzureADHandler.decodeIdToken(token, expectedNonce, entraConfig());

    expect(Tenant.findOne).not.toHaveBeenCalled();
    expect(JSON.stringify(profile)).not.toMatch(/first-found-tenant/);
  });

  test.each(["AZURE_AD_TENANT_ID", "AZURE_AD_CLIENT_ID"])(
    "missing %s fails closed before any verification (no built-in fallback)",
    async (name) => {
      const saved = process.env[name];
      delete process.env[name];
      try {
        // The configuration cannot be resolved, so no verification can start.
        let err;
        try {
          entraConfig();
        } catch (e) {
          err = e;
        }
        expect(err).toMatchObject({ code: "ENTRA_NOT_CONFIGURED", missing: [name] });
      } finally {
        process.env[name] = saved;
      }
    },
  );
});
