/**
 * Logging hardening (follow-up to the allow-list request logger): the B2C sign-up check, the
 * B2C callback at the root, the policy adapter and Microsoft token-exchange failures log explicit
 * safe fields only - never request bodies, headers, Basic-auth credentials, personal data,
 * profile-service responses, authorization codes, state or any part of a JWT.
 * Only axios, the connector-tenant lookup and the PDP service are mocked.
 */
jest.mock("axios", () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock("../helpers/b2cConnectorTenant", () => ({
  resolveB2CConnectorTenantId: jest.fn(async () => "68cbf7806080b4621d469d34"),
}));
const mockPdp = { impl: null };
jest.mock("../services/policyEvaluationService", () => ({
  evaluatePolicy: (...a) => mockPdp.impl(...a),
  cache: {},
}));

const axios = require("axios");
const UserController = require("../controllers/user.controller");
const { root } = require("../controllers/root.controller");
const { azureB2CBasicAuth } = require("../middlewares/basicAuth.middleware");
const { defaultPolicyAdapter } = require("../helpers/policyAdapter");
const AzureADHandler = require("../handlers/azure.ad.handler");

const PII = {
  email: "secret.person@example.org",
  givenName: "Secretgiven",
  surname: "Secretsurname",
  displayName: "Secretgiven Secretsurname",
  memberno: "SECRETMEM123",
  mobilephone: "+353 87 765 4321",
};
const BASIC_USER = "connector-user-SECRET";
const BASIC_PASS = "connector-pass-SECRET";
const BASIC = `Basic ${Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString("base64")}`;
const CODE = "SECRET-AUTH-CODE-0123456789abcdefghijklmnopqrstuvwxyz0123456789";
const STATE = "SECRET-STATE-0123456789";
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzZWNyZXQifQ.SECRET-SIGNATURE";

const logged = () =>
  [console.log, console.error, console.warn]
    .flatMap((fn) => fn.mock.calls)
    .map((args) => args.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" "))
    .join("\n");
const expectNoPersonalData = () => {
  const text = logged();
  for (const v of Object.values(PII)) expect(text).not.toContain(v);
  for (const v of [BASIC, BASIC_USER, BASIC_PASS, BASIC.slice(6)]) expect(text).not.toContain(v);
  expect(text).not.toMatch(/Request body|Request headers|authorization|extension_/i);
};

const signUpRequest = () => ({
  body: {
    email: PII.email,
    givenName: PII.givenName,
    surname: PII.surname,
    displayName: PII.displayName,
    extension_abc123_MemberNo: PII.memberno,
    extension_abc123_mobilePhone: PII.mobilephone,
    step: "PostAttributeCollection",
    client_id: "b2c-app-id",
  },
  headers: { authorization: BASIC, "content-type": "application/json", "x-forwarded-for": "10.1.2.3" },
});
const fakeRes = () => {
  const res = { headersSent: false, statusCode: 0, body: null };
  res.setHeader = jest.fn();
  res.status = jest.fn((s) => {
    res.statusCode = s;
    return res;
  });
  res.json = jest.fn((b) => {
    res.body = b;
    res.headersSent = true;
    return res;
  });
  res.redirect = jest.fn();
  res.render = jest.fn();
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("B2C sign-up check (POST /api/users/validate)", () => {
  test("success: no body, headers, Basic auth, personal data or profile-service response", async () => {
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { version: "1.0.0", action: "Continue", email: PII.email, givenName: PII.givenName, extension_x_MemberNo: PII.memberno },
    });
    const res = fakeRes();
    await UserController.validateUser(signUpRequest(), res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe("Continue"); // the response itself is unchanged
    expect(axios.post.mock.calls[0][1]).toMatchObject({ email: PII.email }); // forwarded unchanged
    expectNoPersonalData();
    // safe metadata remains
    expect(logged()).toMatch(/Profile service response:.*"status":200.*"action":"Continue".*"tenantId":"68cbf7806080b4621d469d34"/);
    expect(logged()).toMatch(/"memberno":true,"mobilephone":true/);
  });

  test("fail open (profile-service down): the Continue response with email and names is not logged", async () => {
    axios.post.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const res = fakeRes();
    await UserController.validateUser(signUpRequest(), res, jest.fn());
    expect(res.body).toMatchObject({ action: "Continue", email: PII.email });
    expectNoPersonalData();
  });

  test("profile-service error: the HTTP client error (with the forwarded body) is not dumped", async () => {
    const err = Object.assign(new Error("Request failed with status code 500"), {
      name: "AxiosError",
      code: "ERR_BAD_RESPONSE",
      config: { data: JSON.stringify(signUpRequest().body), headers: { authorization: BASIC } },
      response: { status: 500, data: { email: PII.email } },
    });
    axios.post.mockRejectedValueOnce(err);
    const res = fakeRes();
    await UserController.validateUser(signUpRequest(), res, jest.fn());
    expect(res.body.action).toBe("ShowBlockPage");
    expectNoPersonalData();
    expect(logged()).toMatch(/User Validation Error:.*"code":"ERR_BAD_RESPONSE".*"status":500/);
  });

  test("invalid phone: refused without logging the value", async () => {
    const req = signUpRequest();
    req.body.extension_abc123_mobilePhone = "bad-SECRET";
    const res = fakeRes();
    await UserController.validateUser(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(logged()).not.toContain("bad-SECRET");
    expectNoPersonalData();
  });

  test("Basic auth failure does not log the supplied username or password", () => {
    process.env.B2C_API_USERNAME = "expected-user";
    process.env.B2C_API_PASSWORD = "expected-pass";
    try {
      const res = fakeRes();
      azureB2CBasicAuth()({ headers: { authorization: BASIC } }, res, jest.fn());
      expect(res.body.action).toBe("ShowBlockPage");
      expect(logged()).toMatch(/Basic Auth failed/);
      expect(logged()).not.toMatch(/expected-user|expected-pass/);
      expectNoPersonalData();
    } finally {
      delete process.env.B2C_API_USERNAME;
      delete process.env.B2C_API_PASSWORD;
    }
  });
});

describe("B2C callback at the root (GET /)", () => {
  test("no part of the code, the state or the redirect URL is logged; the redirect is unchanged", () => {
    const res = fakeRes();
    root({ query: { code: CODE, state: STATE } }, res);
    expect(res.redirect).toHaveBeenCalledWith(`/auth/azure-portal?code=${CODE}&state=${STATE}`);
    const text = logged();
    expect(text).not.toContain(CODE.slice(0, 12));
    expect(text).not.toContain(STATE);
    expect(text).not.toMatch(/code=|state=/);
    expect(text).toMatch(/B2C callback at root/);
  });
});

describe("policy adapter", () => {
  test("no fragment of the JWT is logged; resource, action and correlation id are", async () => {
    mockPdp.impl = async () => ({ decision: "PERMIT", user: { id: "u1", tenantId: "t1" } });
    await defaultPolicyAdapter.evaluate(JWT, {
      resource: "portal",
      action: "read",
      context: { correlationId: "corr-1", email: PII.email },
    });
    const text = logged();
    expect(text).not.toMatch(/eyJ/);
    expect(text).not.toContain(PII.email);
    expect(text).toMatch(/PolicyAdapter\.evaluate:.*"resource":"portal".*"action":"read".*"correlationId":"corr-1"/);
  });
});

describe("Microsoft (Entra) token-exchange errors", () => {
  const msError = () =>
    Object.assign(new Error("Request failed with status code 400"), {
      config: { data: `client_secret=test-client-secret&code=${CODE}` },
      request: {},
      response: {
        status: 400,
        data: {
          error: "invalid_grant",
          error_description: `AADSTS50126: Error for ${PII.email}. Trace ID: t-1`,
          error_codes: [50126],
          trace_id: "trace-1",
          correlation_id: "corr-ms-1",
          timestamp: "2026-10-14 10:00:00Z",
          claims: "SECRET-CLAIMS",
        },
      },
    });
  const SAFE = { status: 400, error: "invalid_grant", errorCodes: [50126], traceId: "trace-1", correlationId: "corr-ms-1" };
  const expectOnlySafeFields = () => {
    const text = logged();
    expect(text).not.toContain(PII.email);
    expect(text).not.toMatch(/AADSTS50126:|SECRET-CLAIMS|SECRET-AUTH-CODE|test-client-secret|error_description/);
    const objects = [console.error].flatMap((fn) => fn.mock.calls).flat().filter((x) => x && typeof x === "object");
    // Every logged object is the explicit Microsoft field set, or the controller's {name, code}.
    const allowedShapes = [Object.keys(SAFE).sort().join(","), "code,name"];
    for (const o of objects) expect(allowedShapes).toContain(Object.keys(o).sort().join(","));
    expect(objects).toContainEqual(SAFE);
  };

  test("exchangeCodeForTokens logs status, error code(s) and trace/correlation ids only", async () => {
    axios.post.mockRejectedValueOnce(msError());
    await expect(AzureADHandler.exchangeCodeForTokens(CODE, "verifier")).rejects.toThrow(/invalid_grant|AADSTS/);
    expectOnlySafeFields();
  });

  test("handleAzureADAuth and the CRM callback do not log the error_description-bearing message", async () => {
    axios.post.mockRejectedValueOnce(msError());
    let thrown;
    try {
      await AzureADHandler.handleAzureADAuth(CODE, "verifier", null, "nonce");
    } catch (e) {
      thrown = e;
    }
    expect(thrown && thrown.azureError).toBeTruthy();
    const { handleAzureADCallback } = require("../controllers/azure.ad.controller");
    const store = require("../helpers/pkceStateStore");
    store.rememberNonceForState("ms-state", "n");
    jest.spyOn(AzureADHandler, "handleAzureADAuth").mockRejectedValueOnce(thrown);
    const next = jest.fn();
    await handleAzureADCallback({ body: { code: CODE, codeVerifier: "v", state: "ms-state" }, headers: {}, query: {} }, {}, next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 500 }); // client response unchanged
    expectOnlySafeFields();
  });
});
