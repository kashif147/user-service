/**
 * Successful CRM sign-in callback (POST /auth/azure-crm) returns display-only organisation context
 * { code, name } of the authenticated session's organisation, for the CRM's remembered sign-in
 * screen. Never the internal tenant id, directory, connection, oid / tid or configuration; never from
 * the request; omitted (sign-in unaffected) when it cannot be determined safely.
 */
const TENANT_A = "68cbf7806080b4621d469d34";
const TENANT_B = "6acd6119b28a863c61361ae0";
const DIR = "39866a06-30bc-4a89-80c6-9dd9357dd453";
const OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";

const mockTenants = [];
jest.mock("../models/tenant.model", () => ({
  findOne: (q) => ({
    select: () => ({
      lean: async () => {
        const t = mockTenants.find((x) => x._id === String(q._id) && x.isActive !== false);
        return t ? JSON.parse(JSON.stringify(t)) : null;
      },
    }),
  }),
}));
jest.mock("../handlers/azure.ad.handler", () => ({ handleAzureADAuth: jest.fn() }));
jest.mock("../helpers/jwt", () => ({ generateToken: jest.fn().mockResolvedValue({ token: "signed.jwt" }) }));
jest.mock("../helpers/pkceStateStore", () => ({ takeLoginTransaction: jest.fn() }));

const AzureADHandler = require("../handlers/azure.ad.handler");
const jwtHelper = require("../helpers/jwt");
const { takeLoginTransaction } = require("../helpers/pkceStateStore");
const { handleAzureADCallback } = require("../controllers/azure.ad.controller");
const { AppError } = require("../errors/AppError");

const userOf = (tenantId, extra = {}) => ({
  _id: "u1",
  tenantId,
  userEmail: "staff@example.org",
  userMicrosoftId: OID,
  userIssuer: `https://login.microsoftonline.com/${DIR}/v2.0`,
  userType: "CRM",
  tokens: {},
  ...extra,
});
async function callback({ loginContext, user, authError } = {}) {
  takeLoginTransaction.mockReturnValue({ nonce: "n1", loginContext });
  if (authError) AzureADHandler.handleAzureADAuth.mockRejectedValue(authError);
  else AzureADHandler.handleAzureADAuth.mockResolvedValue({ user });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await handleAzureADCallback({ body: { code: "c", codeVerifier: "v", state: "s1" }, query: {}, headers: {} }, res, next);
  return { body: res.json.mock.calls[0]?.[0], status: res.status.mock.calls[0]?.[0], next };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  mockTenants.length = 0;
  mockTenants.push(
    { _id: TENANT_A, code: "MULTIAUTH", name: "Digital Informatics", isActive: true, authenticationConnections: [{ _id: "connA", directoryId: DIR }] },
    { _id: TENANT_B, code: "DEVTENANTB", name: "DEV Tenant B", isActive: true, authenticationConnections: [{ _id: "connB", directoryId: DIR }] }
  );
});
afterEach(() => jest.restoreAllMocks());

test("1/2 success returns { code, name } of the session's organisation", async () => {
  const { status, body } = await callback({ loginContext: { tenantId: TENANT_A, connectionId: "connA" }, user: userOf(TENANT_A) });
  expect(status).toBe(200);
  expect(body.organisation).toEqual({ code: "MULTIAUTH", name: "Digital Informatics" });
});

test("3-6 the organisation object holds only code + name: no tenant id, directory, connection, oid or tid", async () => {
  const { body } = await callback({ loginContext: { tenantId: TENANT_A, connectionId: "connA" }, user: userOf(TENANT_A) });
  expect(Object.keys(body.organisation).sort()).toEqual(["code", "name"]);
  const org = JSON.stringify(body.organisation);
  for (const secret of [TENANT_A, DIR, "connA", OID]) expect(org).not.toContain(secret);
});

test("DEVTENANTB session -> DEVTENANTB's own code + name", async () => {
  const { body } = await callback({ loginContext: { tenantId: TENANT_B, connectionId: "connB" }, user: userOf(TENANT_B) });
  expect(body.organisation).toEqual({ code: "DEVTENANTB", name: "DEV Tenant B" });
});

test("7 a refused verification (e.g. tid / directory mismatch) never reaches a success response", async () => {
  const { status, body, next } = await callback({
    loginContext: { tenantId: TENANT_A, connectionId: "connA" },
    authError: AppError.forbidden("You don't have access to this organisation"),
  });
  expect(status).toBeUndefined();
  expect(body).toBeUndefined();
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  expect(jwtHelper.generateToken).not.toHaveBeenCalled();
});

test("8 cross-tenant: the session's organisation is used, and a sign-in state naming another organisation fails safe (no organisation)", async () => {
  const mismatch = await callback({ loginContext: { tenantId: TENANT_A, connectionId: "connA" }, user: userOf(TENANT_B) });
  expect(mismatch.status).toBe(200);
  expect(mismatch.body).not.toHaveProperty("organisation");
  // request input cannot influence it: a body tenant / code is never read
  const legacy = await callback({ loginContext: null, user: userOf(TENANT_B) });
  expect(legacy.body.organisation).toEqual({ code: "DEVTENANTB", name: "DEV Tenant B" });
});

test("fails safe: inactive / missing organisation, malformed code or missing name -> omitted, sign-in still succeeds", async () => {
  mockTenants[0].isActive = false;
  expect((await callback({ loginContext: { tenantId: TENANT_A }, user: userOf(TENANT_A) })).body).not.toHaveProperty("organisation");
  mockTenants[0].isActive = true;
  mockTenants[0].code = "bad code!";
  expect((await callback({ loginContext: { tenantId: TENANT_A }, user: userOf(TENANT_A) })).body).not.toHaveProperty("organisation");
  mockTenants[0].code = "MULTIAUTH";
  mockTenants[0].name = "  ";
  const r = await callback({ loginContext: { tenantId: TENANT_A }, user: userOf(TENANT_A) });
  expect(r.status).toBe(200);
  expect(r.body.accessToken).toBe("signed.jwt");
  expect(r.body).not.toHaveProperty("organisation");
  expect((await callback({ loginContext: null, user: userOf("ffffffffffffffffffffffff") })).body).not.toHaveProperty("organisation");
});

test("10 the JWT / session is unchanged: generateToken gets the same user; existing response fields intact", async () => {
  const user = userOf(TENANT_A);
  const { body } = await callback({ loginContext: { tenantId: TENANT_A, connectionId: "connA" }, user });
  expect(jwtHelper.generateToken).toHaveBeenCalledWith(user);
  expect(body).toMatchObject({ success: true, message: "Azure AD authentication successful", accessToken: "signed.jwt" });
  expect(Object.keys(body).sort()).toEqual(["accessToken", "message", "organisation", "success", "user"]);
  expect(body.user).not.toHaveProperty("organisation");
});

test("9 the handler (JIT / pre-authorised rules, tid / oid checks) still receives the server-side login context unchanged", async () => {
  const loginContext = { tenantId: TENANT_A, connectionId: "connA" };
  await callback({ loginContext, user: userOf(TENANT_A) });
  expect(AzureADHandler.handleAzureADAuth).toHaveBeenCalledWith("c", "v", "n1", loginContext);
});
