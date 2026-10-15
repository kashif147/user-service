/**
 * Phase 1 hardening: the real token exchanges never log the authorization code, the PKCE
 * verifier or the request body built from them (B2C portal and Entra CRM), on success or failure.
 * Only axios is mocked.
 */
jest.mock("axios", () => ({ post: jest.fn(), get: jest.fn() }));
const axios = require("axios");
const B2CUsersHandler = require("../handlers/b2c.users.handler");
const AzureADHandler = require("../handlers/azure.ad.handler");
const { resolveConnectionAuthConfig } = require("../helpers/connectionAuthConfig");
const entraConfig = () => resolveConnectionAuthConfig(null, { connectionType: "Entra ID (Azure AD)" });

const CODE = "SECRET-AUTH-CODE-0123456789abcdefghijklmnopqrstuvwxyz0123456789";
const VERIFIER = "SECRET-PKCE-VERIFIER-0123456789abcdefghijklmnopqrstuvwxyz";
const logged = () =>
  [console.log, console.error, console.warn]
    .flatMap((fn) => fn.mock.calls)
    .map((args) => args.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" "))
    .join("\n");
const httpError = (body) =>
  Object.assign(new Error("Request failed with status code 400"), {
    config: { data: body },
    request: {},
    response: { status: 400, data: { error: "invalid_grant", error_description: "AADB2C90088 bad" } },
  });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("B2C token exchange logging", () => {
  test("success: no code, verifier, request body or token values", async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { id_token: "ID.TOKEN.VALUE", refresh_token: "REFRESH-VALUE" } });
    await B2CUsersHandler.exchangeCodeForTokens(CODE, VERIFIER, "B2C_1_signin");
    const body = axios.post.mock.calls[0][1];
    expect(body).toContain(CODE); // the request itself is unchanged
    expect(logged()).not.toMatch(/SECRET-AUTH-CODE|SECRET-PKCE-VERIFIER|ID\.TOKEN\.VALUE|REFRESH-VALUE|code_verifier/);
    expect(logged()).toMatch(/B2C token exchange/);
  });

  test("failure: status and Microsoft error code only; the error (with its request) is not logged", async () => {
    axios.post.mockRejectedValueOnce(httpError(`code=${CODE}&code_verifier=${VERIFIER}`));
    await expect(B2CUsersHandler.exchangeCodeForTokens(CODE, VERIFIER, "B2C_1_signin")).rejects.toThrow();
    expect(logged()).not.toMatch(/SECRET-AUTH-CODE|SECRET-PKCE-VERIFIER/);
    expect(logged()).toMatch(/invalid_grant/);
  });
});

describe("Entra (CRM) token exchange logging", () => {
  test("success: no code, verifier or client secret", async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { id_token: "x" } });
    await AzureADHandler.exchangeCodeForTokens(CODE, VERIFIER, entraConfig());
    expect(logged()).not.toMatch(/SECRET-AUTH-CODE|SECRET-PKCE-VERIFIER|test-client-secret/);
  });

  test("failure without a response: no request body logged", async () => {
    const e = httpError(`client_secret=test-client-secret&code=${CODE}&code_verifier=${VERIFIER}`);
    delete e.response;
    axios.post.mockRejectedValueOnce(e);
    await expect(AzureADHandler.exchangeCodeForTokens(CODE, VERIFIER, entraConfig())).rejects.toThrow();
    expect(logged()).not.toMatch(/SECRET-AUTH-CODE|SECRET-PKCE-VERIFIER|test-client-secret/);
  });
});

describe("controller catch-alls do not serialise the HTTP error", () => {
  test("CRM callback: unexpected error carrying the token request is not dumped", async () => {
    const { handleAzureADCallback } = require("../controllers/azure.ad.controller");
    const store = require("../helpers/pkceStateStore");
    store.rememberNonceForState("log-state", "n");
    const e = httpError(`client_secret=test-client-secret&code=${CODE}&code_verifier=${VERIFIER}`);
    delete e.response;
    jest.spyOn(AzureADHandler, "handleAzureADAuth").mockRejectedValueOnce(e);
    const next = jest.fn();
    await handleAzureADCallback({ body: { code: CODE, codeVerifier: VERIFIER, state: "log-state" }, headers: {}, query: {} }, {}, next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 500 });
    expect(logged()).not.toMatch(/SECRET-AUTH-CODE|SECRET-PKCE-VERIFIER|test-client-secret/);
  });

  test("B2C callback: unexpected error carrying the token request is not dumped", async () => {
    const { handleMicrosoftCallback } = require("../controllers/b2c.users.controller");
    const store = require("../helpers/pkceStateStore");
    store.rememberStatePolicy("log-b2c", "B2C_1_signin");
    store.rememberNonceForState("log-b2c", "n");
    jest.spyOn(B2CUsersHandler, "handleB2CAuth").mockRejectedValueOnce(httpError(`code=${CODE}&code_verifier=${VERIFIER}`));
    const next = jest.fn();
    await handleMicrosoftCallback({ body: { code: CODE, codeVerifier: VERIFIER, state: "log-b2c" }, headers: {} }, {}, next);
    expect(next).toHaveBeenCalled();
    expect(logged()).not.toMatch(/SECRET-AUTH-CODE|SECRET-PKCE-VERIFIER/);
  });
});
