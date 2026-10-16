/**
 * Stage 5c-1: "Connect Microsoft Entra" (backend).
 *
 *  - POST /tenants/:id/auth-connections/:connectionId/connect      -> authorize URL (organizations)
 *  - POST /tenants/:id/auth-connections/:connectionId/connect/complete {code, state}
 *  - GET  /tenants/:id/auth-connections/:connectionId/status        -> derived status
 *
 * Identity, directory and administrator evidence come only from the single-use server-side state
 * and the VERIFIED Microsoft ID token (tid, oid, signed wids). Connect records a verified
 * entra-admin-sign-in DirectoryClaim and sets connectedAt / connectedBy only.
 *
 * Microsoft is simulated: ID tokens are signed with a throwaway key whose JWKS is registered for
 * the `organizations` key endpoint. Claim and tenant stores are in memory; database-level rules are
 * in tests/stage5c.entraConnect.mongo.test.js. New modules are required inside the tests so each
 * test fails on its own against older code.
 */
jest.mock("axios", () => ({ post: jest.fn(), get: jest.fn() }));

const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_B = "cccccccccccccccccccccccc";
const HOME_DIR = process.env.AZURE_AD_TENANT_ID; // tests/setupEntraEnv.js (also the DEV shared directory)
const DIR_A = "11111111-2222-3333-4444-555555555555";
const DIR_B = "22222222-3333-4444-5555-666666666666";
const CONSUMER_DIR = "9188040d-6c67-4c5b-b112-36a304b66dad";
const CLIENT_ID = process.env.AZURE_AD_CLIENT_ID;
const ENTRA = "Entra ID (Azure AD)";
const B2C = "Azure B2C";
const GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";
const APP_ADMIN = "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3";
const USER_ROLE = "b79fbf4d-3ef9-4689-8143-76b194e85509"; // default member role, not an admin role
const ADMIN_OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const ADMIN_USER = "psUserA1";
const OTHER_USER = "psUserA2";
const SECRET_CODE = "ms-auth-code-SECRET-1234567890";

// ---- in-memory tenants (Tenant.findOne(...).select().lean(), Tenant.updateOne) ----
const mockTenants = [];
const clone = (v) => JSON.parse(JSON.stringify(v));
jest.mock("../models/tenant.model", () => ({
  findOne: (q) => ({
    select: () => ({
      lean: async () => {
        const t = mockTenants.find((x) => x._id === String(q._id) && x.isActive !== false);
        return t ? clone(t) : null;
      },
    }),
  }),
  find: () => ({ select: () => ({ lean: async () => [] }) }),
  updateOne: jest.fn(async (filter, update) => {
    const t = mockTenants.find((x) => x._id === String(filter._id));
    const m = filter.authenticationConnections.$elemMatch;
    const c = t?.authenticationConnections.find(
      (x) => x._id === String(m._id) && x.connectionType === m.connectionType && x.directoryId === m.directoryId
    );
    if (!c) return { matchedCount: 0, modifiedCount: 0 };
    for (const [k, v] of Object.entries(update.$set)) c[k.replace("authenticationConnections.$.", "")] = v;
    return { matchedCount: 1, modifiedCount: 1 };
  }),
}));
jest.mock("../helpers/jwt", () => ({ generateToken: jest.fn().mockResolvedValue({ token: "signed.jwt" }) }));
// The D/E test drives the real tenant controller, whose import chain creates the Redis cache
// client (services/cacheService.js); stub it so the suite leaves no open connection.
jest.mock("../services/cacheService", () =>
  new Proxy({}, { get: (_t, k) => (k === "__esModule" || k === "then" ? undefined : jest.fn().mockResolvedValue(null)) })
);

const fs = require("fs");
const path = require("path");
const Tenant = require("../models/tenant.model");
const AzureADHandler = require("../handlers/azure.ad.handler");
const { makeTestKeypairAndJwks, signTestJwt } = require("./helpers/testJwt");

const load = {
  handler: () => require("../handlers/entraConnect.handler"),
  connect: () => require("../helpers/entraConnect"),
  service: () => require("../helpers/directoryClaimService"),
  store: () => require("../helpers/pkceStateStore"),
  resolver: () => require("../helpers/connectionAuthConfig"),
  model: () => require("../models/directoryClaim.model"),
};

// ---- in-memory DirectoryClaim store behind the real model's statics ----
const claims = [];
const matches = (c, q) => Object.entries(q).every(([k, v]) => String(c[k]) === String(v));
function stubClaims() {
  const DirectoryClaim = load.model();
  jest.spyOn(DirectoryClaim, "init").mockResolvedValue(undefined);
  jest.spyOn(DirectoryClaim, "find").mockImplementation((q) => ({ lean: async () => clone(claims.filter((c) => matches(c, q))) }));
  jest.spyOn(DirectoryClaim, "findOne").mockImplementation((q) => {
    const hit = claims.find((c) => matches(c, q));
    const doc = hit ? DirectoryClaim.hydrate(clone(hit)) : null;
    return { lean: async () => (hit ? clone(hit) : null), then: (ok, ko) => Promise.resolve(doc).then(ok, ko) };
  });
  const indexConflict = (d) =>
    d.status === "verified" &&
    !d.sharedDirectoryException &&
    claims.some((c) => c._id !== String(d._id) && c.status === "verified" && !c.sharedDirectoryException && c.directoryId === d.directoryId);
  jest.spyOn(DirectoryClaim, "create").mockImplementation(async (data) => {
    const doc = new DirectoryClaim(data);
    await doc.validate();
    if (indexConflict(doc)) throw Object.assign(new Error("E11000"), { code: 11000 });
    claims.push(clone(doc.toObject()));
    return doc;
  });
  jest.spyOn(DirectoryClaim.prototype, "save").mockImplementation(async function save() {
    await this.validate();
    if (indexConflict(this)) throw Object.assign(new Error("E11000"), { code: 11000 });
    const i = claims.findIndex((c) => c._id === String(this._id));
    claims[i] = clone(this.toObject());
    return this;
  });
  return DirectoryClaim;
}

const entraConn = (id, dir, extra = {}) => ({ _id: id, connectionType: ENTRA, directoryId: dir, isActive: false, autoProvisionUsers: false, ...extra });
const devClaim = (tenantId, connectionId) => ({
  _id: `dev-${connectionId}`,
  connectionType: ENTRA,
  directoryId: HOME_DIR,
  tenantId,
  connectionId,
  status: "verified",
  method: "dev-exception",
  sharedDirectoryException: true,
  claimedAt: "2026-10-16T13:39:21.402Z",
  claimedBy: "platform:dev-backfill",
  verifiedAt: "2026-10-16T13:39:21.402Z",
  verifiedBy: "platform:dev-backfill",
  verificationEvidence: null,
});

let kp;
const idToken = (dir, extra = {}, opts = {}) =>
  signTestJwt(
    opts.key || kp.privateKey,
    {
      iss: `https://login.microsoftonline.com/${dir}/v2.0`,
      aud: CLIENT_ID,
      tid: dir,
      oid: ADMIN_OID,
      nonce: opts.nonce,
      wids: [USER_ROLE, GLOBAL_ADMIN],
      ...extra,
    },
    opts.jwt || {}
  );
function msReturns(tokenPromiseOrFn) {
  return jest.spyOn(AzureADHandler, "exchangeCodeForTokens").mockImplementation(async (code, verifier, config) => {
    const token = typeof tokenPromiseOrFn === "function" ? await tokenPromiseOrFn(config) : await tokenPromiseOrFn;
    return { id_token: token, access_token: "ms-access-SECRET", refresh_token: "ms-refresh-SECRET", token_type: "Bearer" };
  });
}
// Like idToken, but with an explicit iat (tests/helpers/testJwt.js always issues iat = now).
async function staleIdToken(dir, nonce, ageSeconds) {
  const { SignJWT } = require("jose");
  const iat = Math.floor(Date.now() / 1000) - ageSeconds;
  return new SignJWT({ iss: `https://login.microsoftonline.com/${dir}/v2.0`, aud: CLIENT_ID, tid: dir, oid: ADMIN_OID, nonce, wids: [GLOBAL_ADMIN] })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(kp.privateKey);
}
// ID token with an absolute iat (seconds since epoch) and exp = iat + 1h.
async function idTokenAt(dir, nonce, iatSeconds) {
  const { SignJWT } = require("jose");
  return new SignJWT({ iss: `https://login.microsoftonline.com/${dir}/v2.0`, aud: CLIENT_ID, tid: dir, oid: ADMIN_OID, nonce, wids: [GLOBAL_ADMIN] })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuedAt(iatSeconds)
    .setExpirationTime(iatSeconds + 3600)
    .sign(kp.privateKey);
}
const nonceOf = (authorizationUrl) => new URL(authorizationUrl).searchParams.get("nonce");
const stateOf = (authorizationUrl) => new URL(authorizationUrl).searchParams.get("state");
const start = (over = {}) => load.handler().startConnect({ tenantId: TENANT_A, connectionId: "connA", userId: ADMIN_USER, ...over });
const complete = (over) => load.handler().completeConnect({ tenantId: TENANT_A, connectionId: "connA", userId: ADMIN_USER, code: SECRET_CODE, ...over });
async function connectWith(tokenFor, over = {}) {
  const { authorizationUrl } = await start(over.start);
  const nonce = nonceOf(authorizationUrl);
  const exchange = msReturns(() => tokenFor(nonce));
  const result = complete({ state: stateOf(authorizationUrl), ...over.complete });
  return { result, exchange, authorizationUrl };
}
const rejectsCode = async (p, code) => {
  let err = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toMatchObject({ code });
  return err;
};
const logged = () =>
  [console.log, console.info, console.warn, console.error]
    .flatMap((fn) => fn.mock.calls)
    .map((args) => args.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" "))
    .join("\n");

beforeAll(async () => {
  kp = await makeTestKeypairAndJwks();
});
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ENTRA_CRM_MULTI_DIRECTORY;
  claims.length = 0;
  mockTenants.length = 0;
  mockTenants.push(
    { _id: TENANT_A, code: "ORGA", isActive: true, authenticationConnections: [entraConn("connA", DIR_A), { _id: "b2cA", connectionType: B2C, directoryId: "x", isActive: true }] },
    { _id: TENANT_B, code: "ORGB", isActive: true, authenticationConnections: [entraConn("connB", DIR_B)] }
  );
  for (const fn of ["log", "info", "warn", "error"]) jest.spyOn(console, fn).mockImplementation(() => {});
  stubClaims();
  load.connect()._setJwksForTests(kp.jwks, load.resolver().resolveEntraConnectConfig().jwksUri);
});
afterEach(() => {
  load.connect()._setJwksForTests(null);
  jest.restoreAllMocks();
});

describe("start: organizations authority, shared app, server-side state", () => {
  test("S1 authorize URL: organizations, shared client id + registered redirect URI, openid profile email, PKCE S256", async () => {
    const { authorizationUrl } = await start();
    const u = new URL(authorizationUrl);
    expect(u.origin + u.pathname).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("redirect_uri")).toBe(process.env.AZURE_AD_REDIRECT_URI);
    expect(u.searchParams.get("scope")).toBe("openid profile email");
    expect(u.searchParams.get("scope")).not.toMatch(/offline_access/);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.has("code_verifier")).toBe(false);
    expect(authorizationUrl).not.toContain(DIR_A); // the unverified directory is not the authority
  });

  test("S2 state is server-side, typed entra-connect, bound to tenant/connection/directory/user, holds no token", async () => {
    const { authorizationUrl } = await start();
    const tx = load.store().takeConnectTransaction(stateOf(authorizationUrl));
    expect(tx).toMatchObject({ flow: "entra-connect", tenantId: TENANT_A, connectionId: "connA", directoryId: DIR_A, initiatingUserId: ADMIN_USER, nonce: nonceOf(authorizationUrl) });
    expect(tx.codeVerifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(Object.keys(tx).sort()).toEqual(["codeVerifier", "connectionId", "createdAt", "directoryId", "flow", "initiatingUserId", "nonce", "tenantId"]);
  });

  test.each([
    ["another organisation's connection id (own tenant path)", { connectionId: "connB" }, "CONNECTION_NOT_FOUND"],
    ["unknown connection", { connectionId: "nope" }, "CONNECTION_NOT_FOUND"],
    ["B2C connection", { connectionId: "b2cA" }, "NOT_ENTRA_CONNECTION"],
    ["no ProjectShell user", { userId: undefined }, "CONNECT_STATE_INVALID"],
  ])("A start refused: %s", async (_d, over, code) => {
    await rejectsCode(start(over), code);
  });

  test("A2 start refused for a non-GUID / consumer directory", async () => {
    mockTenants[0].authenticationConnections[0].directoryId = "common";
    await rejectsCode(start(), "INVALID_DIRECTORY");
    mockTenants[0].authenticationConnections[0].directoryId = CONSUMER_DIR;
    await rejectsCode(start(), "INVALID_DIRECTORY");
  });

  test("A3 routes: tenant admin for start/complete, tenant read for status, own-tenant path guard on all three", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "tenant.routes.js"), "utf8");
    for (const [route, perm] of [
      ['"/tenants/:id/auth-connections/:connectionId/connect"', '"admin"'],
      ['"/tenants/:id/auth-connections/:connectionId/connect/complete"', '"admin"'],
      ['"/tenants/:id/auth-connections/:connectionId/status"', '"read"'],
    ]) {
      const block = src.slice(src.indexOf(route), src.indexOf(");", src.indexOf(route)));
      expect(block).toMatch(/requireTenant,/);
      expect(block).toMatch(/requireTenantPathAccess\("id"\)/);
      expect(block).toContain(`defaultPolicyAdapter.middleware("tenant", ${perm})`);
    }
  });

  test("G0 start refused when another organisation already holds a verified claim", async () => {
    claims.push({ ...devClaim(TENANT_B, "connB"), _id: "c1", directoryId: DIR_A, method: "entra-admin-sign-in", sharedDirectoryException: false, verificationEvidence: { directoryUserId: ADMIN_OID, roleTemplateId: GLOBAL_ADMIN } });
    await rejectsCode(start(), "DIRECTORY_ALREADY_CLAIMED");
  });

  test("N0 start refused for the DEV shared directory (DIRECTORY_SHARED_EXCEPTION)", async () => {
    mockTenants[0].authenticationConnections[0].directoryId = HOME_DIR;
    claims.push(devClaim(TENANT_A, "connA"), devClaim(TENANT_B, "connB"));
    await rejectsCode(start(), "DIRECTORY_SHARED_EXCEPTION");
  });
});

describe("complete: state, token and administrator", () => {
  test("L1 a verified administrator creates exactly the specified claim; connectedAt/connectedBy set", async () => {
    const { result } = await connectWith((nonce) => idToken(DIR_A, {}, { nonce }));
    const out = await result;
    expect(out).toMatchObject({ status: "connected", directoryId: DIR_A, connectedBy: ADMIN_USER });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      connectionType: ENTRA,
      directoryId: DIR_A,
      tenantId: TENANT_A,
      connectionId: "connA",
      status: "verified",
      method: "entra-admin-sign-in",
      sharedDirectoryException: false,
      claimedBy: `user:${ADMIN_USER}`,
      verifiedBy: `user:${ADMIN_USER}`,
      verificationEvidence: { directoryUserId: ADMIN_OID, roleTemplateId: GLOBAL_ADMIN },
    });
    const c = mockTenants[0].authenticationConnections[0];
    expect(c.connectedBy).toBe(ADMIN_USER);
    expect(c.connectedAt).toBeInstanceOf(Date);
  });

  test("M1 Connect sets ONLY connectedAt/connectedBy: isActive, directory, provisioning and test metadata untouched", async () => {
    const before = clone(mockTenants[0].authenticationConnections[0]);
    const { result } = await connectWith((nonce) => idToken(DIR_A, {}, { nonce }));
    await result;
    const [, update] = Tenant.updateOne.mock.calls[0];
    expect(Object.keys(update.$set).sort()).toEqual(["authenticationConnections.$.connectedAt", "authenticationConnections.$.connectedBy"]);
    const after = mockTenants[0].authenticationConnections[0];
    for (const k of ["isActive", "directoryId", "autoProvisionUsers", "defaultRoleId", "connectionType"]) expect(after[k]).toEqual(before[k]);
    expect(after.lastTestedAt).toBeUndefined();
    expect(after.lastTestResult).toBeUndefined();
    expect(Tenant.updateOne.mock.calls[0][0].authenticationConnections.$elemMatch).toEqual({ _id: "connA", connectionType: ENTRA, directoryId: DIR_A });
  });

  test("L2 reconnect refreshes the own verified claim (evidence + verifiedAt) without a second claim", async () => {
    await (await connectWith((nonce) => idToken(DIR_A, {}, { nonce }))).result;
    const firstVerifiedAt = claims[0].verifiedAt;
    await new Promise((r) => setTimeout(r, 5));
    await (await connectWith((nonce) => idToken(DIR_A, { wids: [APP_ADMIN] }, { nonce }))).result;
    expect(claims).toHaveLength(1);
    expect(claims[0].verificationEvidence).toEqual({ directoryUserId: ADMIN_OID, roleTemplateId: APP_ADMIN });
    expect(new Date(claims[0].verifiedAt).getTime()).toBeGreaterThan(new Date(firstVerifiedAt).getTime());
  });

  test("L3 an own pending admin-sign-in claim is upgraded to verified", async () => {
    claims.push({ _id: "6ad22909c7256d5b449e0001", connectionType: ENTRA, directoryId: DIR_A, tenantId: TENANT_A, connectionId: "connA", status: "pending", method: "entra-admin-sign-in", sharedDirectoryException: false, claimedAt: new Date().toISOString(), claimedBy: "user:x", verifiedAt: null, verifiedBy: null, verificationEvidence: null });
    await (await connectWith((nonce) => idToken(DIR_A, {}, { nonce }))).result;
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ _id: "6ad22909c7256d5b449e0001", status: "verified", verificationEvidence: { roleTemplateId: GLOBAL_ADMIN } });
  });

  test("D/E the directory is the verified tid; body/query tid, oid, wids, directoryId, tenantId, connectionId are ignored", async () => {
    const { authorizationUrl } = await start();
    const nonce = nonceOf(authorizationUrl);
    msReturns(idToken(DIR_A, {}, { nonce }));
    const res = { success: jest.fn(), sendAppError: jest.fn(), sendInternalError: jest.fn() };
    await require("../controllers/tenant.controller").completeEntraConnect(
      {
        params: { id: TENANT_A, connectionId: "connA" },
        ctx: { userId: ADMIN_USER },
        body: { code: SECRET_CODE, state: stateOf(authorizationUrl), tid: DIR_B, directoryId: DIR_B, oid: "99999999-9999-9999-9999-999999999999", wids: [APP_ADMIN], tenantId: TENANT_B, connectionId: "connB", roleTemplateId: APP_ADMIN },
      },
      res
    );
    expect(res.sendAppError).not.toHaveBeenCalled();
    expect(res.success.mock.calls[0][0]).toMatchObject({ directoryId: DIR_A });
    expect(claims[0]).toMatchObject({ tenantId: TENANT_A, connectionId: "connA", directoryId: DIR_A, verificationEvidence: { directoryUserId: ADMIN_OID, roleTemplateId: GLOBAL_ADMIN } });
  });

  test("F a token from another directory than the configured one -> DIRECTORY_MISMATCH, nothing written", async () => {
    const { result } = await connectWith((nonce) => idToken(DIR_B, {}, { nonce }));
    await rejectsCode(result, "DIRECTORY_MISMATCH");
    expect(claims).toHaveLength(0);
    expect(Tenant.updateOne).not.toHaveBeenCalled();
    expect(mockTenants[0].authenticationConnections[0].directoryId).toBe(DIR_A);
  });

  test("G another organisation verifies the directory in between -> DIRECTORY_ALREADY_CLAIMED, no transfer", async () => {
    const { authorizationUrl } = await start();
    claims.push({ ...devClaim(TENANT_B, "connB"), _id: "cB", directoryId: DIR_A, method: "entra-admin-sign-in", sharedDirectoryException: false, verificationEvidence: { directoryUserId: ADMIN_OID, roleTemplateId: GLOBAL_ADMIN } });
    msReturns(idToken(DIR_A, {}, { nonce: nonceOf(authorizationUrl) }));
    await rejectsCode(complete({ state: stateOf(authorizationUrl) }), "DIRECTORY_ALREADY_CLAIMED");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ tenantId: TENANT_B, connectionId: "connB" });
    expect(Tenant.updateOne).not.toHaveBeenCalled();
  });

  test.each([
    ["personal-account directory", CONSUMER_DIR, "INVALID_DIRECTORY"],
    ["upper-case tid (not a normal tid)", "abcdef12-3456-7890-abcd-ef1234567890".toUpperCase(), "INVALID_DIRECTORY"],
  ])("H %s -> %s", async (_d, tid, code) => {
    const { result } = await connectWith((nonce) => idToken(tid, { iss: `https://login.microsoftonline.com/${tid}/v2.0` }, { nonce }));
    await rejectsCode(result, code);
    expect(claims).toHaveLength(0);
  });

  test.each([
    ["no wids", { wids: undefined }],
    ["empty wids", { wids: [] }],
    ["only a non-admin directory role", { wids: [USER_ROLE] }],
    ["wids not an array", { wids: GLOBAL_ADMIN }],
    ["wids with a non-GUID entry", { wids: [GLOBAL_ADMIN, "Global Administrator"] }],
    ["admin only in app roles", { wids: [USER_ROLE], roles: [GLOBAL_ADMIN, "Admin"] }],
    ["admin only in groups / scp", { wids: [USER_ROLE], groups: [GLOBAL_ADMIN], scp: "Directory.ReadWrite.All" }],
  ])("K non-administrator: %s -> NOT_DIRECTORY_ADMIN, nothing written", async (_d, extra) => {
    const { result } = await connectWith((nonce) => idToken(DIR_A, extra, { nonce }));
    await rejectsCode(result, "NOT_DIRECTORY_ADMIN");
    expect(claims).toHaveLength(0);
    expect(Tenant.updateOne).not.toHaveBeenCalled();
  });

  test.each([
    ["forged signature (another key)", async (nonce) => idToken(DIR_A, {}, { nonce, key: (await makeTestKeypairAndJwks()).privateKey })],
    ["wrong audience", (nonce) => idToken(DIR_A, { aud: "another-client" }, { nonce })],
    ["issuer of another directory", (nonce) => idToken(DIR_A, { iss: `https://login.microsoftonline.com/${DIR_B}/v2.0` }, { nonce })],
    ["issuer 'organizations'", (nonce) => idToken(DIR_A, { iss: "https://login.microsoftonline.com/organizations/v2.0" }, { nonce })],
    ["wrong nonce", () => idToken(DIR_A, {}, { nonce: "not-the-nonce" })],
    ["expired", (nonce) => idToken(DIR_A, {}, { nonce, jwt: { expiresInSeconds: -60 } })],
    ["not yet valid", (nonce) => idToken(DIR_A, { nbf: Math.floor(Date.now() / 1000) + 3600 }, { nonce })],
    ["older than 10 minutes", (nonce) => staleIdToken(DIR_A, nonce, 11 * 60)],
    ["oid not a GUID", (nonce) => idToken(DIR_A, { oid: "admin" }, { nonce })],
    ["no id_token at all", () => undefined],
  ])("K2 token check: %s -> refused, nothing written", async (_d, tokenFor) => {
    const { result } = await connectWith(tokenFor);
    await expect(result).rejects.toMatchObject({ code: expect.stringMatching(/^(TOKEN_INVALID|INVALID_DIRECTORY)$/) });
    expect(claims).toHaveLength(0);
  });

  test("K3 the Microsoft code exchange failing -> TOKEN_EXCHANGE_FAILED (no Microsoft error text surfaces)", async () => {
    const { authorizationUrl } = await start();
    jest.spyOn(AzureADHandler, "exchangeCodeForTokens").mockRejectedValue(Object.assign(new Error("AADSTS70008: secret details"), { azureError: { error: "invalid_grant" } }));
    const err = await rejectsCode(complete({ state: stateOf(authorizationUrl) }), "TOKEN_EXCHANGE_FAILED");
    expect(err.message).not.toMatch(/AADSTS|secret/);
  });
});

describe("token issue time is bound to the Connect state (clock-skew allowance, not session time)", () => {
  const nowS = () => Math.floor(Date.now() / 1000);
  const SKEW = () => require("../helpers/entraConnect").CONNECT_TOKEN_CLOCK_SKEW_SECONDS;
  const FUTURE = () => require("../helpers/entraConnect").CONNECT_TOKEN_FUTURE_SKEW_SECONDS;
  async function flowWithIat(iatFor, { advanceMs = 0 } = {}) {
    const startedAt = Date.now();
    const { authorizationUrl } = await start();
    const nonce = nonceOf(authorizationUrl);
    const createdS = Math.floor(startedAt / 1000);
    msReturns(() => idTokenAt(DIR_A, nonce, iatFor(createdS)));
    if (advanceMs) {
      jest.useFakeTimers({ doNotFake: ["setInterval", "setTimeout", "setImmediate", "nextTick", "queueMicrotask", "clearInterval", "clearTimeout"] });
      jest.setSystemTime(startedAt + advanceMs);
    }
    try {
      return await complete({ state: stateOf(authorizationUrl) }).then((v) => ({ ok: v }), (e) => ({ err: e }));
    } finally {
      jest.useRealTimers();
    }
  }

  test("named constants: 10-minute clock-skew allowance, 5-minute future skew", () => {
    expect(SKEW()).toBe(600);
    expect(FUTURE()).toBe(300);
  });

  test("A iat ~5 minutes before state creation (Microsoft back-dating) -> accepted", async () => {
    const r = await flowWithIat((c) => c - 300);
    expect(r.ok).toMatchObject({ status: "connected" });
  });

  test("B iat just inside the allowed skew before state creation -> accepted", async () => {
    const r = await flowWithIat((c) => c - SKEW() + 5);
    expect(r.ok).toMatchObject({ status: "connected" });
  });

  test("B2 9 minutes into the flow with a back-dated token -> accepted (the old now - iat <= 10 min rule would refuse)", async () => {
    const r = await flowWithIat((c) => c - 300, { advanceMs: 9 * 60 * 1000 });
    expect(r.ok).toMatchObject({ status: "connected" });
  });

  test("C iat older than state.createdAt minus the allowed skew -> TOKEN_INVALID, nothing written", async () => {
    const r = await flowWithIat((c) => c - SKEW() - 60);
    expect(r.err).toMatchObject({ code: "TOKEN_INVALID" });
    expect(claims).toHaveLength(0);
    expect(Tenant.updateOne).not.toHaveBeenCalled();
  });

  test("D the state's 10-minute expiry still ends the flow, whatever the token time", async () => {
    const r = await flowWithIat((c) => c, { advanceMs: 10 * 60 * 1000 + 1000 });
    expect(r.err).toMatchObject({ code: "CONNECT_STATE_INVALID" });
    expect(AzureADHandler.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  test("E a replayed state is refused even with a fresh token", async () => {
    const { authorizationUrl } = await start();
    const state = stateOf(authorizationUrl);
    msReturns(() => idTokenAt(DIR_A, nonceOf(authorizationUrl), nowS()));
    await complete({ state });
    await rejectsCode(complete({ state }), "CONNECT_STATE_INVALID");
  });

  test("F iat in the future beyond the allowed skew -> TOKEN_INVALID; within it -> accepted", async () => {
    expect((await flowWithIat(() => nowS() + FUTURE() + 120)).err).toMatchObject({ code: "TOKEN_INVALID" });
    expect((await flowWithIat(() => nowS() + 60)).ok).toMatchObject({ status: "connected" });
  });

  test("G nonce mismatch is still refused with a well-timed token", async () => {
    const { authorizationUrl } = await start();
    msReturns(() => idTokenAt(DIR_A, "another-nonce", nowS()));
    await rejectsCode(complete({ state: stateOf(authorizationUrl) }), "TOKEN_INVALID");
  });

  test("H a normal current token -> accepted", async () => {
    const r = await flowWithIat(() => nowS());
    expect(r.ok).toMatchObject({ status: "connected" });
  });

  test("verification without the state's createdAt fails closed", async () => {
    const { verifyConnectIdToken } = require("../helpers/entraConnect");
    const config = load.resolver().resolveEntraConnectConfig();
    const token = await idTokenAt(DIR_A, "n", nowS());
    await expect(verifyConnectIdToken(token, "n", config)).rejects.toMatchObject({ code: "TOKEN_INVALID" });
    await expect(verifyConnectIdToken(token, "n", config, { stateCreatedAt: Date.now() })).resolves.toMatchObject({ directoryId: DIR_A });
  });
});

describe("state binding, replay and expiry", () => {
  test("B/C complete refuses another user, another tenant path or another connection path", async () => {
    for (const over of [{ userId: OTHER_USER }, { tenantId: TENANT_B, connectionId: "connB" }, { connectionId: "connX" }]) {
      const { authorizationUrl } = await start();
      msReturns(idToken(DIR_A, {}, { nonce: nonceOf(authorizationUrl) }));
      await rejectsCode(complete({ state: stateOf(authorizationUrl), ...over }), "CONNECT_STATE_INVALID");
    }
    expect(claims).toHaveLength(0);
    expect(AzureADHandler.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  test("I a used state cannot be replayed (single use, also after a failure)", async () => {
    const { authorizationUrl } = await start();
    const state = stateOf(authorizationUrl);
    msReturns(idToken(DIR_A, {}, { nonce: nonceOf(authorizationUrl) }));
    await complete({ state });
    await rejectsCode(complete({ state }), "CONNECT_STATE_INVALID");
    const second = await start();
    await rejectsCode(complete({ state: stateOf(second.authorizationUrl), userId: OTHER_USER }), "CONNECT_STATE_INVALID");
    await rejectsCode(complete({ state: stateOf(second.authorizationUrl) }), "CONNECT_STATE_INVALID");
  });

  test("J an expired state (over 10 minutes) is refused", async () => {
    const realNow = Date.now;
    const { authorizationUrl } = await start();
    try {
      Date.now = () => realNow() + 10 * 60 * 1000 + 1;
      await rejectsCode(complete({ state: stateOf(authorizationUrl) }), "CONNECT_STATE_INVALID");
    } finally {
      Date.now = realNow;
    }
  });

  test("B2 a connect state cannot be consumed by sign-in, and a sign-in state cannot complete a connect", async () => {
    const store = load.store();
    const { authorizationUrl } = await start();
    const connectState = stateOf(authorizationUrl);
    expect(store.takeLoginTransaction(connectState)).toBeNull();
    expect(store.takeNonceForState(connectState)).toBeNull();
    store.rememberNonceForState("login-state-1", "n1", { tenantId: TENANT_A, connectionId: "connA" });
    await rejectsCode(complete({ state: "login-state-1" }), "CONNECT_STATE_INVALID");
    expect(store.takeLoginTransaction("login-state-1")).toMatchObject({ nonce: "n1" }); // untouched by the attempt
    // the connect state itself is still usable afterwards (the login takes did not consume it)
    msReturns(idToken(DIR_A, {}, { nonce: nonceOf(authorizationUrl) }));
    await expect(complete({ state: connectState })).resolves.toMatchObject({ status: "connected" });
  });

  test("M2 connection edited between start and complete -> CONNECTION_CHANGED, no exchange", async () => {
    const { authorizationUrl } = await start();
    mockTenants[0].authenticationConnections[0].directoryId = DIR_B;
    msReturns(idToken(DIR_B, {}, { nonce: nonceOf(authorizationUrl) }));
    await rejectsCode(complete({ state: stateOf(authorizationUrl) }), "CONNECTION_CHANGED");
    expect(AzureADHandler.exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(claims).toHaveLength(0);
  });
});

describe("DEV shared-directory exception claims", () => {
  test("N Connect for the shared DEV directory is refused and both DEV claims stay byte-identical", async () => {
    mockTenants[0].authenticationConnections[0].directoryId = HOME_DIR;
    mockTenants[1].authenticationConnections[0].directoryId = HOME_DIR;
    claims.push(devClaim(TENANT_A, "connA"), devClaim(TENANT_B, "connB"));
    const before = JSON.stringify(claims);
    await rejectsCode(start(), "DIRECTORY_SHARED_EXCEPTION");
    // even with a state obtained before the claims existed, completion refuses and changes nothing
    const saved = claims.splice(0);
    const { authorizationUrl } = await start();
    claims.push(...saved);
    msReturns(idToken(HOME_DIR, {}, { nonce: nonceOf(authorizationUrl) }));
    await rejectsCode(complete({ state: stateOf(authorizationUrl) }), "DIRECTORY_SHARED_EXCEPTION");
    expect(JSON.stringify(claims)).toBe(before);
    expect(Tenant.updateOne).not.toHaveBeenCalled();
  });
});

describe("status (derived)", () => {
  const status = (over = {}) => load.handler().getConnectionStatus({ tenantId: TENANT_A, connectionId: "connA", ...over });

  test("not_connected without a claim, and with a pending claim", async () => {
    await expect(status()).resolves.toMatchObject({ status: "not_connected", directoryId: DIR_A, sharedDirectoryException: false });
    claims.push({ _id: "p", connectionType: ENTRA, directoryId: DIR_A, tenantId: TENANT_A, connectionId: "connA", status: "pending", method: "entra-admin-sign-in", sharedDirectoryException: false });
    await expect(status()).resolves.toMatchObject({ status: "not_connected" });
  });

  test("connected after Connect with no test result; safe fields only", async () => {
    await (await connectWith((nonce) => idToken(DIR_A, {}, { nonce }))).result;
    const s = await status();
    expect(s).toMatchObject({ status: "connected", directoryId: DIR_A, connectedBy: ADMIN_USER, autoProvisionUsers: false, isActive: false, sharedDirectoryException: false });
    expect(s.connectedAt).toBeTruthy();
    expect(Object.keys(s).sort()).toEqual(["autoProvisionUsers", "connectedAt", "connectedBy", "directoryId", "isActive", "sharedDirectoryException", "status"]);
    expect(JSON.stringify(s)).not.toMatch(/appRef|clientId|scope|issuer|audience|directoryOwnership|verificationEvidence|roleTemplateId|directoryUserId/);
  });

  test("reconnect_required when the connection's directory no longer matches its claim", async () => {
    await (await connectWith((nonce) => idToken(DIR_A, {}, { nonce }))).result;
    mockTenants[0].authenticationConnections[0].directoryId = DIR_B;
    await expect(status()).resolves.toMatchObject({ status: "reconnect_required" });
  });

  test("test_failed only when a connected claim has lastTestResult.ok === false", async () => {
    await (await connectWith((nonce) => idToken(DIR_A, {}, { nonce }))).result;
    mockTenants[0].authenticationConnections[0].lastTestResult = { ok: false, code: "APP_NOT_CONSENTED" };
    await expect(status()).resolves.toMatchObject({ status: "test_failed", lastTestResult: { ok: false, code: "APP_NOT_CONSENTED" } });
    mockTenants[0].authenticationConnections[0].lastTestResult = { ok: true, code: "CONNECTED" };
    await expect(status()).resolves.toMatchObject({ status: "connected" });
  });

  test("DEV exception: connected + sharedDirectoryException while the DEV conditions hold, reconnect_required otherwise", async () => {
    mockTenants[0].authenticationConnections[0].directoryId = HOME_DIR;
    claims.push(devClaim(TENANT_A, "connA"));
    const vars = { DEPLOYMENT_ENV: "dev", ENTRA_ALLOW_SHARED_DIRECTORY: "true", ENTRA_SHARED_DIRECTORY_ALLOWLIST: HOME_DIR };
    Object.assign(process.env, vars);
    try {
      await expect(status()).resolves.toMatchObject({ status: "connected", sharedDirectoryException: true });
      delete process.env.ENTRA_ALLOW_SHARED_DIRECTORY;
      await expect(status()).resolves.toMatchObject({ status: "reconnect_required", sharedDirectoryException: true });
    } finally {
      for (const k of Object.keys(vars)) delete process.env[k];
    }
  });

  test("verificationEvidence never appears in ordinary tenant / connection responses", async () => {
    await (await connectWith((nonce) => idToken(DIR_A, {}, { nonce }))).result;
    const { toTenantView, toConnectionView } = require("../helpers/authConnectionView");
    const withEvidence = { ...mockTenants[0], authenticationConnections: [{ ...mockTenants[0].authenticationConnections[0], verificationEvidence: claims[0].verificationEvidence }] };
    expect(JSON.stringify(toTenantView(withEvidence))).not.toMatch(/verificationEvidence|roleTemplateId|directoryUserId/);
    expect(JSON.stringify(toConnectionView(withEvidence.authenticationConnections[0]))).not.toMatch(/verificationEvidence/);
  });
});

describe("secrets, switch-off and B2C", () => {
  test("no Connect token, code or verifier is persisted or logged", async () => {
    const { authorizationUrl } = await start();
    const tx = load.store().takeConnectTransaction(stateOf(authorizationUrl));
    load.store().rememberConnectTransaction(stateOf(authorizationUrl), tx); // put back unchanged
    const token = await idToken(DIR_A, {}, { nonce: nonceOf(authorizationUrl) });
    msReturns(token);
    await complete({ state: stateOf(authorizationUrl) });
    const persisted = JSON.stringify({ claims, mockTenants });
    const logs = logged();
    for (const secret of [token, SECRET_CODE, tx.codeVerifier, "ms-access-SECRET", "ms-refresh-SECRET", process.env.AZURE_AD_CLIENT_SECRET, stateOf(authorizationUrl)]) {
      if (!secret) continue;
      expect(persisted).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    expect(persisted).not.toMatch(/"wids"/);
  });

  test("O switch OFF stays OFF: Connect does not enable sign-in (foreign directory still DIRECTORY_NOT_ENABLED)", async () => {
    await (await connectWith((nonce) => idToken(DIR_A, {}, { nonce }))).result;
    expect(process.env.ENTRA_CRM_MULTI_DIRECTORY).toBeUndefined();
    let code = null;
    try {
      load.resolver().resolveConnectionAuthConfig({ ...mockTenants[0].authenticationConnections[0], isActive: true });
    } catch (e) {
      code = e.code;
    }
    expect(code).toBe("DIRECTORY_NOT_ENABLED");
  });

  test("P B2C resolution unchanged; Connect never applies to B2C", async () => {
    const b = load.resolver().resolveConnectionAuthConfig(null, { connectionType: B2C, policy: "B2C_1_signin" });
    expect(b).toMatchObject({ application: "legacySharedB2C", mode: "legacy-shared-directory" });
    await rejectsCode(start({ connectionId: "b2cA" }), "NOT_ENTRA_CONNECTION");
  });

  test("the claim model accepts evidence only on admin-sign-in claims, only the two safe keys and an allowed role", async () => {
    const DirectoryClaim = load.model();
    const base = { connectionType: ENTRA, directoryId: DIR_A, tenantId: TENANT_A, connectionId: "connA", claimedBy: "user:x", status: "verified", verifiedAt: new Date(), verifiedBy: "user:x" };
    const errs = async (d) => {
      try {
        await new DirectoryClaim(d).validate();
        return [];
      } catch (e) {
        return Object.keys(e.errors);
      }
    };
    expect(await errs({ ...base, method: "entra-admin-sign-in" })).toEqual([]); // optional on the model; Connect always writes it (L1)
    expect(await errs({ ...base, method: "platform", verificationEvidence: { directoryUserId: ADMIN_OID, roleTemplateId: GLOBAL_ADMIN } })).toContain("verificationEvidence");
    expect(await errs({ ...base, method: "entra-admin-sign-in", verificationEvidence: { directoryUserId: ADMIN_OID, roleTemplateId: USER_ROLE } })).toContain("verificationEvidence.roleTemplateId");
    // Unknown evidence keys (a wids array, a token) reject the evidence outright: never stored.
    const extra = { ...base, method: "entra-admin-sign-in", verificationEvidence: { directoryUserId: ADMIN_OID, roleTemplateId: GLOBAL_ADMIN, wids: [GLOBAL_ADMIN], idToken: "x" } };
    expect((await errs(extra)).some((k) => k.startsWith("verificationEvidence"))).toBe(true);
    expect(new DirectoryClaim(extra).toObject().verificationEvidence ?? null).toBeNull();
    expect(await errs({ ...base, method: "entra-admin-sign-in", verificationEvidence: { directoryUserId: ADMIN_OID.toUpperCase(), roleTemplateId: GLOBAL_ADMIN.toUpperCase() } })).toEqual([]);
  });
});
