/**
 * CRM Microsoft-token containment - sign-in callback (POST /auth/azure-crm) and CRM scopes.
 *
 * The callback returns only the ProjectShell JWT, the session's organisation { code, name } and a
 * minimal display user. No Microsoft token (ID / access / refresh), expiry or Microsoft identity
 * metadata (oid, sub, audience, issuer, token times / version, policy) - checked recursively.
 * CRM scopes no longer request offline_access (no Microsoft refresh token is issued); B2C unchanged.
 */
const TENANT_A = "68cbf7806080b4621d469d34";
const DIR = "39866a06-30bc-4a89-80c6-9dd9357dd453";
const OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const MS = { id: "MS-ID-TOKEN-SECRET", access: "MS-ACCESS-TOKEN-SECRET", refresh: "MS-REFRESH-TOKEN-SECRET" };

jest.mock("../models/tenant.model", () => ({
  findOne: () => ({ select: () => ({ lean: async () => ({ _id: "68cbf7806080b4621d469d34", code: "MULTIAUTH", name: "Digital Informatics", isActive: true }) }) }),
}));
jest.mock("../handlers/azure.ad.handler", () => ({ handleAzureADAuth: jest.fn() }));
jest.mock("../helpers/jwt", () => ({ generateToken: jest.fn().mockResolvedValue({ token: "signed.projectshell.jwt" }) }));
jest.mock("../helpers/pkceStateStore", () => ({ takeLoginTransaction: jest.fn() }));

const AzureADHandler = require("../handlers/azure.ad.handler");
const jwtHelper = require("../helpers/jwt");
const { takeLoginTransaction } = require("../helpers/pkceStateStore");
const { handleAzureADCallback, CRM_CALLBACK_USER_FIELDS } = require("../controllers/azure.ad.controller");

const FORBIDDEN_KEYS = [
  "tokens", "id_token", "refresh_token", "access_token", "idToken", "refreshToken", "msAccessToken",
  "id_token_expires_in", "refresh_token_expires_in", "refresh_token_expires_at",
  "userMicrosoftId", "userSubject", "userAudience", "userIssuer", "userIssuedAt", "userAuthTime",
  "userTokenVersion", "userPolicy", "userAuthProvider", "userMobilePhone", "userMemberNumber", "userLastLogin",
];
function allKeys(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); allKeys(v, out); }
  return out;
}

// A user document as the handler returns it today, including legacy stored token material.
const storedUser = () => ({
  _id: "u1",
  tenantId: TENANT_A,
  userEmail: "staff@example.org",
  userFirstName: "Staff",
  userLastName: "Member",
  userFullName: "Staff Member",
  userType: "CRM",
  userMobilePhone: "+353000",
  userMemberNumber: "M1",
  userMicrosoftId: OID,
  userAuthProvider: "azure-ad",
  userSubject: "sub-1",
  userAudience: "ad25f823-e2d3-43e2-bea5-a9e6c9b0dbae",
  userIssuer: `https://login.microsoftonline.com/${DIR}/v2.0`,
  userIssuedAt: 1700000000,
  userAuthTime: 1700000000,
  userTokenVersion: "2.0",
  userPolicy: null,
  userLastLogin: new Date(),
  tokens: { id_token: MS.id, refresh_token: MS.refresh, id_token_expires_in: 3600, refresh_token_expires_in: null },
});
async function callback(user = storedUser(), extra = {}) {
  takeLoginTransaction.mockReturnValue({ nonce: "n1", loginContext: { tenantId: TENANT_A, connectionId: "connA" } });
  // The handler also hands back the raw Microsoft token response; it must never reach the body.
  AzureADHandler.handleAzureADAuth.mockResolvedValue({ user, tokens: { id_token: MS.id, access_token: MS.access, refresh_token: MS.refresh }, ...extra });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await handleAzureADCallback({ body: { code: "c", codeVerifier: "v", state: "s1" }, query: {}, headers: {} }, res, next);
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0], next };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const m of ["log", "warn", "error"]) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("CRM callback response", () => {
  test("exact shape: success, message, ProjectShell accessToken, organisation { code, name }, minimal user", async () => {
    const { status, body } = await callback();
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["accessToken", "message", "organisation", "success", "user"]);
    expect(body.accessToken).toBe("signed.projectshell.jwt");
    expect(body.organisation).toEqual({ code: "MULTIAUTH", name: "Digital Informatics" });
    expect(body.user).toEqual({ id: "u1", userEmail: "staff@example.org", userFirstName: "Staff", userLastName: "Member", userFullName: "Staff Member", userType: "CRM" });
    expect(CRM_CALLBACK_USER_FIELDS).toEqual(["userEmail", "userFirstName", "userLastName", "userFullName", "userType"]);
  });

  test("recursively: zero Microsoft token / identity-metadata keys anywhere", async () => {
    const { body } = await callback();
    const keys = allKeys(body);
    for (const k of FORBIDDEN_KEYS) expect(keys).not.toContain(k);
  });

  test("no Microsoft token VALUE (ID, access, refresh), oid, issuer or directory anywhere in the body", async () => {
    const json = JSON.stringify((await callback()).body);
    for (const v of [MS.id, MS.access, MS.refresh, OID, DIR, "sub-1", "login.microsoftonline.com"]) expect(json).not.toContain(v);
  });

  test("logoutHint: the ID token's login_hint is returned when present, and nothing else changes", async () => {
    const { body } = await callback(storedUser(), { loginHint: "opaque-login-hint_123" });
    expect(Object.keys(body).sort()).toEqual(["accessToken", "logoutHint", "message", "organisation", "success", "user"]);
    expect(body.logoutHint).toBe("opaque-login-hint_123");
    const json = JSON.stringify(body);
    for (const v of [MS.id, MS.access, MS.refresh]) expect(json).not.toContain(v);
  });

  test("logoutHint is omitted when the handler has none", async () => {
    const { body } = await callback(storedUser(), { loginHint: null });
    expect(body).not.toHaveProperty("logoutHint");
  });

  test("ProjectShell JWT unchanged: generateToken gets the same user object", async () => {
    const user = storedUser();
    await callback(user);
    expect(jwtHelper.generateToken).toHaveBeenCalledWith(user);
  });

  test("missing display fields are null, never undefined or taken from elsewhere", async () => {
    const u = storedUser();
    delete u.userFirstName;
    const { body } = await callback(u);
    expect(body.user.userFirstName).toBeNull();
    expect(Object.keys(body.user)).toHaveLength(6);
  });
});

describe("CRM / B2C scopes", () => {
  const { getEntraCrmApp, getLegacySharedB2CApp } = require("../helpers/authAppRegistry");
  test("CRM requests openid profile email - no offline_access, so Microsoft issues no CRM refresh token", () => {
    const scopes = getEntraCrmApp().scopes.split(" ");
    expect(scopes.sort()).toEqual(["email", "openid", "profile"]);
    expect(scopes).not.toContain("offline_access");
  });
  test("B2C member-portal scopes unchanged (still offline_access for its refresh token)", () => {
    expect(getLegacySharedB2CApp().scopes).toBe("openid offline_access");
  });
  test("the CRM authorize URL and token request use the CRM scopes", () => {
    const { resolveConnectionAuthConfig } = require("../helpers/connectionAuthConfig");
    expect(typeof resolveConnectionAuthConfig).toBe("function");
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "handlers", "azure.ad.handler.js"), "utf8");
    expect(src).toMatch(/scope: authConfig\.scopes/);
  });
});
