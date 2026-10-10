/**
 * Phase 1C-2Z — middlewares/auth.js `authenticate` no longer echoes raw exception text.
 *
 * The outer catch (unexpected runtime exceptions, not normal verification failures) returned
 * `error.jwtError = error.message` to the client. It now returns a fixed 400 "Invalid token" with
 * tokenError:true and no jwtError; the full error is still logged server-side. Ordinary invalid
 * tokens keep their fixed 401 (covered in tests/auth.authenticate.test.js).
 */
const jwt = require("jsonwebtoken");

const SECRET = "test-hs256-secret-auth-1c2z";
process.env.JWT_SECRET = SECRET;
process.env.NODE_ENV = "test";
delete process.env.AUTH_BYPASS_ENABLED;

const MARK = "AUTH_INTERNAL_MARKER redis://secret-host:6379 /srv/private/auth.js";
const mockValidateGatewayRequest = jest.fn(() => ({ valid: true }));
jest.mock("@membership/policy-middleware", () => ({
  gatewaySecurity: { validateGatewayRequest: (...a) => mockValidateGatewayRequest(...a) },
  tenantContextMiddleware: () => (req, res, next) => next(),
}));
jest.mock("../services/roleHierarchyService", () => ({
  isSuperUser: () => false,
  isAssistantSuperUser: () => false,
  isSystemAdmin: () => false,
  getHighestRoleLevel: () => 1,
  hasMinimumRole: () => false,
}));

const { authenticate } = require("../middlewares/auth");

const gatewayHeaders = {
  "x-jwt-verified": "true",
  "x-auth-source": "gateway",
  "x-user-id": "gw-user",
  "x-tenant-id": "tenant-1",
  "x-user-type": "CRM",
  "x-user-roles": '["REO"]',
  "x-user-permissions": '["profile:read"]',
};

const run = async (headers) => {
  const req = { headers, path: "/api/role" };
  const res = {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const next = jest.fn();
  await authenticate(req, res, next);
  return { req, res, next };
};

let errorLogs;
beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  mockValidateGatewayRequest.mockReset();
  mockValidateGatewayRequest.mockReturnValue({ valid: true });
  errorLogs = [];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation((...a) => errorLogs.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(" ")));
});
afterEach(() => jest.restoreAllMocks());

test("unexpected exception -> 400 'Invalid token', tokenError kept, no jwtError / raw text; next not called", async () => {
  mockValidateGatewayRequest.mockImplementation(() => { throw new Error(MARK); });
  const { res, next, req } = await run(gatewayHeaders);
  expect(res.statusCode).toBe(400);
  expect(res.body).toEqual({ error: { message: "Invalid token", code: "BAD_REQUEST", status: 400, tokenError: true } });
  expect(res.body.error).not.toHaveProperty("jwtError");
  expect(JSON.stringify(res.body)).not.toMatch(/AUTH_INTERNAL_MARKER|secret-host|redis:\/\/|\/srv\/private/);
  expect(next).not.toHaveBeenCalled();
  expect(req.ctx).toBeUndefined();
});

test("full exception still logged server-side", async () => {
  mockValidateGatewayRequest.mockImplementation(() => { throw new Error(MARK); });
  await run(gatewayHeaders);
  expect(errorLogs.some((l) => l.startsWith("JWT Decode Error:") && l.includes("AUTH_INTERNAL_MARKER"))).toBe(true);
});

test("ordinary invalid Bearer token keeps its fixed 401 and never carries jwtError", async () => {
  const forged = jwt.sign({ sub: "u", tenantId: "t", roles: ["SU"] }, "wrong-secret", { algorithm: "HS256" });
  const { res, next } = await run({ authorization: `Bearer ${forged}` });
  expect(res.statusCode).toBe(401);
  expect(JSON.stringify(res.body)).not.toContain("jwtError");
  expect(next).not.toHaveBeenCalled();
});

test("valid gateway request still accepted", async () => {
  const { next, res } = await run(gatewayHeaders);
  expect(next).toHaveBeenCalled();
  expect(res.statusCode).toBeNull();
});
