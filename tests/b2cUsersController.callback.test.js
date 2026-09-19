/**
 * controllers/b2c.users.controller.js's handleMicrosoftCallback - covers the mandatory
 * state->nonce and state->policy resolution (no client-supplied policy/flow override) and
 * the 401-vs-500 error mapping. The actual cryptographic verification is covered by
 * tests/b2cUsersHandler.decodeIdToken.test.js; here B2CUsersHandler is mocked so this file
 * only exercises the controller's own logic.
 */
jest.mock("../handlers/b2c.users.handler");
jest.mock("../helpers/jwt", () => ({
  generateToken: jest.fn().mockResolvedValue({ token: "signed.jwt.token" }),
}));
jest.mock("../helpers/tokenEncryption", () => ({
  encryptToken: jest.fn().mockReturnValue("encrypted-token"),
}));

const B2CUsersHandler = require("../handlers/b2c.users.handler");
const { handleMicrosoftCallback } = require("../controllers/b2c.users.controller");
const {
  rememberStatePolicy,
  rememberNonceForState,
} = require("../helpers/pkceStateStore");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("handleMicrosoftCallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("rejects with 400 when state is missing", async () => {
    const req = { body: { code: "auth-code", codeVerifier: "verifier" } };
    const res = mockRes();
    const next = jest.fn();

    await handleMicrosoftCallback(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(B2CUsersHandler.handleB2CAuth).not.toHaveBeenCalled();
  });

  test("rejects with 400 when state has no stored nonce", async () => {
    const req = {
      body: { code: "auth-code", codeVerifier: "verifier", state: "never-issued" },
    };
    const res = mockRes();
    const next = jest.fn();

    await handleMicrosoftCallback(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(B2CUsersHandler.handleB2CAuth).not.toHaveBeenCalled();
  });

  test("rejects with 400 when state has a nonce but no stored policy (never falls back to req.body.policy/flow)", async () => {
    rememberNonceForState("state-no-policy", "nonce-no-policy");

    const req = {
      body: {
        code: "auth-code",
        codeVerifier: "verifier",
        state: "state-no-policy",
        // A client-supplied policy override must NOT be consulted at all.
        policy: "B2C_1_signin",
      },
    };
    const res = mockRes();
    const next = jest.fn();

    await handleMicrosoftCallback(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(B2CUsersHandler.handleB2CAuth).not.toHaveBeenCalled();
  });

  test("existing valid B2C portal login continues working: uses the trusted state-derived policy and nonce, returns 200", async () => {
    rememberStatePolicy("state-ok", "B2C_1_projectshell_signin");
    rememberNonceForState("state-ok", "nonce-ok");
    B2CUsersHandler.handleB2CAuth.mockResolvedValueOnce({
      user: { _id: "user-1", userEmail: "member@example.com" },
      tokens: { refresh_token: "refresh-token" },
    });

    const req = {
      body: { code: "auth-code", codeVerifier: "verifier", state: "state-ok" },
    };
    const res = mockRes();
    const next = jest.fn();

    await handleMicrosoftCallback(req, res, next);

    expect(B2CUsersHandler.handleB2CAuth).toHaveBeenCalledWith(
      "auth-code",
      "verifier",
      "B2C_1_projectshell_signin",
      "nonce-ok",
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  test("a client-supplied policy cannot override the trusted state-derived policy", async () => {
    rememberStatePolicy("state-override-attempt", "B2C_1_projectshell_signin");
    rememberNonceForState("state-override-attempt", "nonce-override-attempt");
    B2CUsersHandler.handleB2CAuth.mockResolvedValueOnce({
      user: { _id: "user-1", userEmail: "member@example.com" },
      tokens: {},
    });

    const req = {
      body: {
        code: "auth-code",
        codeVerifier: "verifier",
        state: "state-override-attempt",
        policy: "B2C_1_password_reset", // attempted override - must be ignored
      },
    };
    const res = mockRes();
    const next = jest.fn();

    await handleMicrosoftCallback(req, res, next);

    expect(B2CUsersHandler.handleB2CAuth).toHaveBeenCalledWith(
      "auth-code",
      "verifier",
      "B2C_1_projectshell_signin", // the state-derived policy, not the client-supplied one
      "nonce-override-attempt",
    );
  });

  test("B2C login rejects an invalid Microsoft ID token with 401, not 500", async () => {
    rememberStatePolicy("state-bad-token", "B2C_1_projectshell_signin");
    rememberNonceForState("state-bad-token", "nonce-bad-token");
    B2CUsersHandler.handleB2CAuth.mockRejectedValueOnce(
      new Error("B2C token nonce mismatch"),
    );

    const req = {
      body: { code: "auth-code", codeVerifier: "verifier", state: "state-bad-token" },
    };
    const res = mockRes();
    const next = jest.fn();

    await handleMicrosoftCallback(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });
});
