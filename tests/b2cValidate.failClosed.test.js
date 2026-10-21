/**
 * Azure B2C sign-up connector (POST /api/users/validate, runs BEFORE the B2C user is created):
 * the profile-service duplicate/eligibility validation must complete, otherwise the sign-up is
 * blocked (FAIL CLOSED). Business outcomes from profile-service are passed on unchanged.
 */
const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
jest.mock("../models/tenant.model", () => ({
  find: jest.fn((q) => {
    const m = q.authenticationConnections.$elemMatch;
    const rows = m.audience === "app-A" ? [{ _id: "aaaaaaaaaaaaaaaaaaaaaaaa" }] : [];
    const chain = { select: () => chain, limit: () => chain, lean: async () => rows };
    return chain;
  }),
}));
jest.mock("axios", () => ({ post: jest.fn() }));
const axios = require("axios");
const { validateUser } = require("../controllers/user.controller");

function call(body, headers = {}) {
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      setHeader() {},
      status(code) { this.code = code; return this; },
      json(payload) { this.headersSent = true; resolve({ code: this.code, body: payload }); return this; },
    };
    validateUser({ body, headers, query: {} }, res, () => {});
  });
}
const signUp = (extra = {}) => ({ email: "new.member@example.test", client_id: "app-A", step: "PostAttributeCollection", ...extra });
const netErr = (code, message = code) => Object.assign(new Error(message), { code });
const httpErr = (status) => Object.assign(new Error(`Request failed with status code ${status}`), {
  name: "AxiosError", code: status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST", response: { status, data: {} },
});
const BLOCK = { action: "ShowBlockPage" };

beforeEach(() => { axios.post.mockReset(); jest.spyOn(console, "log").mockImplementation(() => {}); jest.spyOn(console, "warn").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe("business outcomes from profile-service are passed on unchanged", () => {
  test("valid profile -> Continue (HTTP 200)", async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { version: "1.0.0", action: "Continue" } });
    const r = await call(signUp());
    expect(r).toEqual({ code: 200, body: { version: "1.0.0", action: "Continue" } });
  });

  test("invalid / duplicate profile -> ValidationError (HTTP 400, message kept)", async () => {
    const v = { version: "1.0.0", status: 400, action: "ValidationError", userMessage: "A profile with this email already exists." };
    axios.post.mockResolvedValueOnce({ status: 200, data: v });
    const r = await call(signUp());
    expect(r).toEqual({ code: 400, body: v });
  });

  test("profile-service block decision -> ShowBlockPage passed on", async () => {
    const b = { version: "1.0.0", action: "ShowBlockPage", userMessage: "Please contact your organisation." };
    axios.post.mockResolvedValueOnce({ status: 200, data: b });
    expect(await call(signUp())).toEqual({ code: 200, body: b });
  });
});

describe("validation cannot be completed -> FAIL CLOSED (ShowBlockPage, never Continue)", () => {
  const cases = [
    ["connection refused", () => netErr("ECONNREFUSED", "connect ECONNREFUSED 172.18.0.9:4002")],
    ["connect timeout (ETIMEDOUT)", () => netErr("ETIMEDOUT")],
    ["request timeout (axios ECONNABORTED)", () => netErr("ECONNABORTED", "timeout of 15000ms exceeded")],
    ["DNS failure", () => netErr("ENOTFOUND")],
    ["connection reset", () => netErr("ECONNRESET")],
    ["profile 500", () => httpErr(500)],
    ["profile 503", () => httpErr(503)],
    ["profile 400 (e.g. wrong path)", () => httpErr(400)],
    ["profile 401", () => httpErr(401)],
    ["profile 404", () => httpErr(404)],
  ];
  for (const [label, err] of cases) {
    test(label, async () => {
      axios.post.mockRejectedValueOnce(err());
      const r = await call(signUp());
      expect(r.code).toBe(200);
      expect(r.body).toMatchObject(BLOCK);
      expect(r.body.action).not.toBe("Continue");
      expect(r.body).not.toHaveProperty("tenantId");
      expect(r.body).not.toHaveProperty("email");
    });
  }

  const malformed = [
    ["empty body", ""],
    ["HTML/string body", "<html>gateway error</html>"],
    ["null", null],
    ["array", [{ action: "Continue" }]],
    ["object without action", { version: "1.0.0" }],
    ["unknown action", { version: "1.0.0", action: "Allow" }],
    ["action wrong case", { version: "1.0.0", action: "continue" }],
  ];
  for (const [label, data] of malformed) {
    test(`malformed profile response: ${label}`, async () => {
      axios.post.mockResolvedValueOnce({ status: 200, data });
      const r = await call(signUp());
      expect(r.code).toBe(200);
      expect(r.body).toMatchObject(BLOCK);
    });
  }
});

describe("tenant is only ever the one resolved from the B2C application", () => {
  test("unknown client_id -> ShowBlockPage, profile-service never called (no cross-tenant fallback)", async () => {
    const r = await call(signUp({ client_id: "unknown-app", tenantId: A }));
    expect(r.body).toMatchObject(BLOCK);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test("tenantId in the body and spoofed headers are ignored; profile-service gets the resolved tenant as an internal call", async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { version: "1.0.0", action: "Continue" } });
    await call(signUp({ tenantId: "bbbbbbbbbbbbbbbbbbbbbbbb" }), { "x-tenant-id": "bbbbbbbbbbbbbbbbbbbbbbbb", "x-internal-request": "true" });
    const [url, , opts] = axios.post.mock.calls[0];
    expect(url).toMatch(/\/api\/profile\/validate$/);
    expect(url).not.toMatch(/\/api\/api\//);
    expect(opts.headers).toMatchObject({ "x-internal-request": "true", "x-tenant-id": A });
  });
});
