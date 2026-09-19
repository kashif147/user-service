/**
 * controllers/azure.ad.controller.js's handleAzureADCallback - covers the state/nonce
 * plumbing and the 401-vs-500 error mapping for token-verification failures. The actual
 * cryptographic verification is covered by tests/azureAdHandler.decodeIdToken.test.js;
 * here AzureADHandler is mocked so this file only exercises the controller's own logic.
 */
jest.mock("../handlers/azure.ad.handler");
jest.mock("../helpers/jwt", () => ({
  generateToken: jest.fn().mockResolvedValue({ token: "signed.jwt.token" }),
}));
jest.mock("../helpers/tokenEncryption", () => ({
  encryptToken: jest.fn().mockReturnValue("encrypted-token"),
}));

const AzureADHandler = require("../handlers/azure.ad.handler");
const { handleAzureADCallback } = require("../controllers/azure.ad.controller");
const { rememberNonceForState } = require("../helpers/pkceStateStore");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("handleAzureADCallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("rejects with 400 when state is missing", async () => {
    const req = { body: { code: "auth-code", codeVerifier: "verifier" } };
    const res = mockRes();
    const next = jest.fn();

    await handleAzureADCallback(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(AzureADHandler.handleAzureADAuth).not.toHaveBeenCalled();
  });

  test("rejects with 400 when state is unknown/expired", async () => {
    const req = {
      body: { code: "auth-code", codeVerifier: "verifier", state: "never-issued" },
    };
    const res = mockRes();
    const next = jest.fn();

    await handleAzureADCallback(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(AzureADHandler.handleAzureADAuth).not.toHaveBeenCalled();
  });

  test("existing valid CRM login continues working: passes the recovered nonce through and returns 200", async () => {
    rememberNonceForState("state-ok", "nonce-ok");
    AzureADHandler.handleAzureADAuth.mockResolvedValueOnce({
      user: {
        _id: "user-1",
        userEmail: "staff@example.com",
        tokens: {},
        userIssuedAt: null,
        userAuthTime: null,
      },
    });

    const req = {
      body: { code: "auth-code", codeVerifier: "verifier", state: "state-ok" },
      headers: {},
    };
    const res = mockRes();
    const next = jest.fn();

    await handleAzureADCallback(req, res, next);

    expect(AzureADHandler.handleAzureADAuth).toHaveBeenCalledWith(
      "auth-code",
      "verifier",
      undefined,
      "nonce-ok",
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  test("CRM login rejects an invalid Microsoft ID token with 401, not 500", async () => {
    rememberNonceForState("state-bad-token", "nonce-bad-token");
    AzureADHandler.handleAzureADAuth.mockRejectedValueOnce(
      new Error("Azure AD token nonce mismatch"),
    );

    const req = {
      body: {
        code: "auth-code",
        codeVerifier: "verifier",
        state: "state-bad-token",
      },
      headers: {},
    };
    const res = mockRes();
    const next = jest.fn();

    await handleAzureADCallback(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  test("jose signature-verification failure is mapped to 401", async () => {
    rememberNonceForState("state-sig-fail", "nonce-sig-fail");
    const joseError = new Error("signature verification failed");
    joseError.code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
    AzureADHandler.handleAzureADAuth.mockRejectedValueOnce(joseError);

    const req = {
      body: { code: "auth-code", codeVerifier: "verifier", state: "state-sig-fail" },
      headers: {},
    };
    const res = mockRes();
    const next = jest.fn();

    await handleAzureADCallback(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });
});
