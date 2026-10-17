/**
 * CRM Microsoft-token containment - POST /auth/refresh.
 *
 * The endpoint exchanges a stored Microsoft refresh token for a ProjectShell JWT. Only PORTAL (B2C)
 * users may use it: a CRM user's token - including one still stored by an older login, i.e. before
 * the DEV data cleanup - is refused with the same generic 401 as an unknown token, before any JWT is
 * issued. PORTAL behaviour and response shape are unchanged. No token value is logged.
 */
const mockUsers = [];
const mockQueries = [];
jest.mock("../models/user.model", () => ({
  findOne: async (q) => {
    mockQueries.push(q);
    // Emulates MongoDB matching, including a {"$ne": ...} operator smuggled in as the token.
    const want = q["tokens.refresh_token"];
    const tokenMatches = (v) => (want && typeof want === "object" && "$ne" in want ? v != null && v !== want.$ne : v === want);
    return mockUsers.find((u) => tokenMatches(u.tokens.refresh_token) && (q.isActive !== true || u.isActive === true)) || null;
  },
  findByIdAndUpdate: jest.fn(async () => null),
  updateOne: jest.fn(async () => ({ modifiedCount: 0 })),
}));
jest.mock("../helpers/jwt", () => ({ generateToken: jest.fn().mockResolvedValue({ token: "new.projectshell.jwt" }) }));

const { generateToken } = require("../helpers/jwt");
const AuthController = require("../controllers/auth.controller");

const CRM_RT = "LEGACY-CRM-MS-REFRESH-TOKEN";
const PORTAL_RT = "PORTAL-B2C-REFRESH-TOKEN";
const user = (o) => ({
  _id: o.id, userEmail: `${o.id}@x.org`, userFirstName: "F", userLastName: "L", userFullName: "F L",
  tenantId: "68cbf7806080b4621d469d34", userType: o.type, isActive: o.isActive ?? true,
  tokens: { refresh_token: o.rt, refresh_token_expires_at: o.exp ?? null },
});
async function refresh(body) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await AuthController.refreshToken({ body }, res, next);
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0], err: next.mock.calls[0]?.[0] };
}
let logs;
beforeEach(() => {
  jest.clearAllMocks();
  mockQueries.length = 0;
  mockUsers.length = 0;
  mockUsers.push(
    user({ id: "crm1", type: "CRM", rt: CRM_RT }), // legacy token still stored (no expiry, as Entra stored it)
    user({ id: "p1", type: "PORTAL", rt: PORTAL_RT, exp: Date.now() + 3600e3 }),
    user({ id: "p2", type: "PORTAL", rt: "INACTIVE-PORTAL-RT", isActive: false })
  );
  logs = [];
  for (const m of ["log", "warn", "error"]) jest.spyOn(console, m).mockImplementation((...a) => logs.push(a.map(String).join(" ")));
});
afterEach(() => jest.restoreAllMocks());

test("1/6 a CRM refresh token still stored in the DB cannot mint a ProjectShell JWT -> generic 401", async () => {
  const { err, body } = await refresh({ refreshToken: CRM_RT });
  expect(body).toBeUndefined();
  expect(err).toMatchObject({ status: 401, message: "Invalid or expired refresh token" });
  expect(generateToken).not.toHaveBeenCalled();
});

test("the CRM refusal is indistinguishable from an unknown token (no account type, user, organisation or role info)", async () => {
  const crm = (await refresh({ refreshToken: CRM_RT })).err;
  const unknown = (await refresh({ refreshToken: "NEVER-ISSUED" })).err;
  expect({ status: crm.status, message: crm.message, code: crm.code }).toEqual({ status: unknown.status, message: unknown.message, code: unknown.code });
  expect(JSON.stringify(crm)).not.toMatch(/CRM|crm1|68cbf780|role|tenant|connection/i);
});

test("2 a valid PORTAL refresh token still works, response shape unchanged", async () => {
  const { status, body } = await refresh({ refreshToken: PORTAL_RT });
  expect(status).toBe(200);
  expect(generateToken).toHaveBeenCalledTimes(1);
  expect(Object.keys(body)).toEqual(["success", "message", "data"]);
  expect(Object.keys(body.data)).toEqual(["accessToken", "refreshToken", "user", "expiresIn"]);
  expect(body.data).toMatchObject({ accessToken: "new.projectshell.jwt", refreshToken: PORTAL_RT, user: { id: "p1", userType: "PORTAL" } });
});

test("3 missing / malformed token -> existing safe failures; a query-operator object never matches a user", async () => {
  expect((await refresh({})).err).toMatchObject({ status: 400 });
  for (const bad of [{ $ne: null }, { $ne: "x" }, ["a"], 42, true]) {
    expect((await refresh({ refreshToken: bad })).err).toMatchObject({ status: 401, message: "Invalid or expired refresh token" });
  }
  expect(generateToken).not.toHaveBeenCalled();
  expect(mockQueries).toHaveLength(0); // rejected before any database query
});

test("missing / null / empty refresh token -> existing 400 'required', before any database query", async () => {
  for (const body of [{}, { refreshToken: null }, { refreshToken: "" }]) {
    expect((await refresh(body)).err).toMatchObject({ status: 400, message: "Refresh token is required" });
  }
  expect(mockQueries).toHaveLength(0);
  expect(generateToken).not.toHaveBeenCalled();
});

test("helper alone: every non-string value is refused before the query layer", async () => {
  const RefreshTokenHelper = require("../helpers/refreshToken");
  for (const bad of [{ $ne: null }, { $gt: "" }, { $regex: ".*" }, ["x"], 1, 0.5, true, false, null, undefined]) {
    await expect(RefreshTokenHelper.validateAndRefresh(bad)).rejects.toThrow();
  }
  expect(mockQueries).toHaveLength(0);
  expect(generateToken).not.toHaveBeenCalled();
});

describe("revoke (POST /auth/revoke)", () => {
  const User = require("../models/user.model");
  async function revoke(body) {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await AuthController.revokeToken({ body, ctx: {} }, res, next);
    return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0], err: next.mock.calls[0]?.[0] };
  }
  test("object / array / number / boolean -> existing safe 'not found', and MongoDB is never queried", async () => {
    for (const bad of [{ $ne: null }, { $exists: true }, ["x"], 42, true]) {
      const r = await revoke({ refreshToken: bad });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ success: true, message: "Token already revoked or not found" });
    }
    expect(User.updateOne).not.toHaveBeenCalled();
  });
  test("missing / null -> existing 400, no query", async () => {
    for (const body of [{}, { refreshToken: null }]) expect((await revoke(body)).err).toMatchObject({ status: 400 });
    expect(User.updateOne).not.toHaveBeenCalled();
  });
  test("a valid string token still goes to the (string-keyed) revoke query", async () => {
    await revoke({ refreshToken: PORTAL_RT });
    expect(User.updateOne).toHaveBeenCalledWith({ "tokens.refresh_token": PORTAL_RT }, expect.any(Object));
  });
});

test("4 inactive user: still refused (query requires isActive: true)", async () => {
  expect((await refresh({ refreshToken: "INACTIVE-PORTAL-RT" })).err).toMatchObject({ status: 401 });
  expect(mockQueries.every((q) => q.isActive === true)).toBe(true);
});

test("5 no refresh token value is ever logged (CRM refusal, PORTAL success, unknown)", async () => {
  await refresh({ refreshToken: CRM_RT });
  await refresh({ refreshToken: PORTAL_RT });
  await refresh({ refreshToken: "NEVER-ISSUED" });
  const all = logs.join("\n");
  for (const v of [CRM_RT, PORTAL_RT, "NEVER-ISSUED"]) expect(all).not.toContain(v);
});
