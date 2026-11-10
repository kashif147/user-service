/**
 * P7 sign-in and refresh refusal for an invalid STORED user type (ROLE_CLASS_MODE=enforce), at the
 * controller level: Entra (azure.ad.controller), B2C (b2c.users.controller) and /auth/refresh
 * (auth.controller -> helpers/refreshToken). Users are real hydrated Mongoose documents, so a stored
 * record without userType reads PORTAL through the schema default exactly as in production.
 *
 *  - enforce: missing / unknown stored type -> next(AppError 403 USER_TYPE_INVALID), no JWT signed,
 *    no response body with a token.
 *  - off / shadow: today's 200 with a token.
 *
 * Which guard fires first in production (the 403 here is defence in depth on the sign-in paths):
 *  - Entra: azure.ad.handler refuses any existing user not stored CRM (USER_TYPE_MISMATCH) before
 *    issuance; a missing stored type hydrates PORTAL and is refused there.
 *  - B2C: b2c.users.handler refuses a non-PORTAL type (403 PORTAL_SIGN_IN_DENIED) and writes
 *    userType PORTAL on every sign-in (findOneAndUpdate new:true), so a missing type is repaired
 *    before issuance.
 *  - Refresh: a plain read, no write; an unknown type is refused by the PORTAL-only rule (401, today),
 *    a missing type hydrates PORTAL and reaches issuance -> 403 here. The one live path.
 */
jest.mock("../helpers/pkceStateStore", () => ({
  takeNonceForState: jest.fn(() => "nonce-1"),
  takePolicyForState: jest.fn(() => "B2C_1_test"),
  takeLoginTransaction: jest.fn(() => ({ nonce: "nonce-1", loginContext: {} })),
}));
jest.mock("../handlers/b2c.users.handler", () => ({ handleB2CAuth: jest.fn() }));
jest.mock("../handlers/azure.ad.handler", () => ({ handleAzureADAuth: jest.fn() }));
jest.mock("../services/platformClaimService", () => ({ resolvePlatformClaim: jest.fn(async () => ({ claim: null })) }));
jest.mock("../helpers/loginOrganisationDisplay", () => ({ loginOrganisationDisplay: jest.fn(async () => null) }));

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/user.model");
const RoleHandler = require("../handlers/role.handler");
const B2CUsersHandler = require("../handlers/b2c.users.handler");
const AzureADHandler = require("../handlers/azure.ad.handler");
const b2cController = require("../controllers/b2c.users.controller");
const azureController = require("../controllers/azure.ad.controller");
const AuthController = require("../controllers/auth.controller");
const { AppError } = require("../errors/AppError");

const A = "68cbf7806080b4621d469d34";
const savedMode = process.env.ROLE_CLASS_MODE;
const setMode = (m) => { if (m === undefined) delete process.env.ROLE_CLASS_MODE; else process.env.ROLE_CLASS_MODE = m; };

/** A user as it comes back from MongoDB; `userType` absent from the stored record when undefined. */
function storedUser(userType) {
  const raw = { _id: new mongoose.Types.ObjectId(), tenantId: A, userEmail: "u@example.test", isActive: true, roles: [], tokens: { refresh_token: "rt-1" } };
  if (userType !== undefined) raw.userType = userType;
  return User.hydrate(raw);
}

function call(handler, body) {
  const res = { statusCode: null, body: null };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  const next = jest.fn();
  return handler({ body, query: {}, headers: {} }, res, next).then(() => ({ res, next }));
}

const PATHS = {
  entra: {
    run: (user) => { AzureADHandler.handleAzureADAuth.mockResolvedValue({ user, verifiedIdentity: {}, loginHint: null }); return call(azureController.handleAzureADCallback, { code: "c", codeVerifier: "v", state: "s" }); },
    token: (res) => res.body.accessToken,
  },
  b2c: {
    run: (user) => { B2CUsersHandler.handleB2CAuth.mockResolvedValue({ user, tokens: { refresh_token: "rt-1" } }); return call(b2cController.handleMicrosoftCallback, { code: "c", codeVerifier: "v", state: "s" }); },
    token: (res) => res.body.accessToken,
  },
  refresh: {
    run: (user) => { jest.spyOn(User, "findOne").mockResolvedValue(user); return call(AuthController.refreshToken, { refreshToken: "rt-1" }); },
    token: (res) => res.body.data.accessToken,
  },
};

let sign;
beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "p7-test-only-secret";
  process.env.JWT_EXPIRY = process.env.JWT_EXPIRY || "1h";
});
beforeEach(() => {
  for (const m of ["log", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
  jest.spyOn(RoleHandler, "getUserRoles").mockResolvedValue([]);
  jest.spyOn(RoleHandler, "getUserPermissions").mockResolvedValue([]);
  jest.spyOn(RoleHandler, "permissionsForRoles").mockResolvedValue([]);
  sign = jest.spyOn(jwt, "sign");
});
afterEach(() => {
  jest.restoreAllMocks();
  setMode(savedMode);
});

function expectRefused({ res, next }) {
  expect(next).toHaveBeenCalledTimes(1);
  const err = next.mock.calls[0][0];
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ name: "AppError", status: 403, code: "USER_TYPE_INVALID", message: "Sign-in is not available for this account" });
  expect(res.json).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
}

describe.each(Object.keys(PATHS))("%s", (path) => {
  const P = PATHS[path];

  test("the stored record really has no userType while the document reads PORTAL (schema default)", () => {
    const u = storedUser(undefined);
    expect(u.userType).toBe("PORTAL");
    expect(u.$isDefault("userType")).toBe(true);
  });

  test("enforce + missing stored userType: 403 USER_TYPE_INVALID, no token", async () => {
    setMode("enforce");
    expectRefused(await P.run(storedUser(undefined)));
  });

  test.each([["off"], ["shadow"], [undefined]])("%s + missing stored userType: today's 200 with a token", async (m) => {
    setMode(m);
    const { res, next } = await P.run(storedUser(undefined));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(jwt.decode(P.token(res))).toMatchObject({ userType: "PORTAL", tenantId: A });
  });

  test("enforce + a valid stored type for this path: 200 with a token", async () => {
    setMode("enforce");
    const { res, next } = await P.run(storedUser(path === "entra" ? "CRM" : "PORTAL"));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(typeof P.token(res)).toBe("string");
  });
});

describe("unknown stored userType", () => {
  test.each([["entra"], ["b2c"]])("%s (handler mocked to let it through): enforce 403 USER_TYPE_INVALID, no token", async (path) => {
    setMode("enforce");
    expectRefused(await PATHS[path].run(storedUser("ADMIN")));
  });

  test.each([["off"], ["shadow"], ["enforce"]])("refresh, %s: refused before issuance by today's PORTAL-only rule (401), no token", async (m) => {
    setMode(m);
    const { res, next } = await PATHS.refresh.run(storedUser("ADMIN"));
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(res.json).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });
});

test("the app error handler returns an AppError as its own status and code (by name)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "app.js"), "utf8");
  expect(src).toMatch(/if \(err\.name === "AppError"\) \{\s*return res\.status\(err\.status\)\.json\(\{\s*success: false,\s*error: \{\s*message: err\.message,\s*code: err\.code,/);
});
