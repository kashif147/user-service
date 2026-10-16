/**
 * Stage 5c-2: "Test Connection" (backend).
 *
 *  POST /tenants/:id/auth-connections/:connectionId/test -> { ok, code, testedAt }
 *
 * A configuration / connectivity health check of an Entra connection that holds a valid verified
 * DirectoryClaim: (A) the directory's OpenID metadata resolves with the expected issuer and
 * endpoints, (B) the shared CRM application obtains a client-credentials token in that directory
 * for ITSELF ("{clientId}/.default": no Microsoft Graph, no permissions, no directory data). The
 * token is only checked for presence and discarded. Only lastTestedAt / lastTestResult {ok, code}
 * are written, scoped to tenant + connection + directory.
 *
 * Microsoft is simulated through the mocked axios get/post. Tenant and claim stores are in memory;
 * the real-database write scope is in tests/stage5c2.testConnection.mongo.test.js and the route
 * chain in tests/stage5c2.testConnection.routes.test.js. New modules are required inside the tests
 * so each test fails on its own against older code.
 */
jest.mock("axios", () => ({ post: jest.fn(), get: jest.fn() }));

const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_B = "cccccccccccccccccccccccc";
const HOME_DIR = process.env.AZURE_AD_TENANT_ID; // tests/setupEntraEnv.js (also the DEV shared directory)
const DIR_A = "11111111-2222-3333-4444-555555555555";
const DIR_B = "22222222-3333-4444-5555-666666666666";
const CLIENT_ID = process.env.AZURE_AD_CLIENT_ID;
const ENTRA = "Entra ID (Azure AD)";
const B2C = "Azure B2C";
const GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";
const ADMIN_OID = "aaaa1111-bbbb-2222-cccc-3333dddd4444";
const MS_ACCESS_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.ms-client-credentials-SECRET.sig";
const MS_ERROR_TEXT = "AADSTS7000215: Invalid client secret provided. Trace ID: 0000-SECRET-TRACE";
const DEV_VARS = { DEPLOYMENT_ENV: "dev", ENTRA_ALLOW_SHARED_DIRECTORY: "true", ENTRA_SHARED_DIRECTORY_ALLOWLIST: HOME_DIR };

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
jest.mock("../services/cacheService", () =>
  new Proxy({}, { get: (_t, k) => (k === "__esModule" || k === "then" ? undefined : jest.fn().mockResolvedValue(null)) })
);

const axios = require("axios");
const Tenant = require("../models/tenant.model");

const load = {
  handler: () => require("../handlers/entraConnect.handler"),
  probe: () => require("../helpers/entraConnectionTest"),
  model: () => require("../models/directoryClaim.model"),
  controller: () => require("../controllers/tenant.controller"),
};

// ---- in-memory DirectoryClaim store (read-only here: Test Connection never writes a claim) ----
const claims = [];
const matches = (c, q) => Object.entries(q).every(([k, v]) => String(c[k]) === String(v));
function stubClaims() {
  const DirectoryClaim = load.model();
  const write = jest.fn(() => {
    throw new Error("Test Connection must not write a DirectoryClaim");
  });
  jest.spyOn(DirectoryClaim, "find").mockImplementation((q) => ({ lean: async () => clone(claims.filter((c) => matches(c, q))) }));
  jest.spyOn(DirectoryClaim, "findOne").mockImplementation((q) => ({ lean: async () => clone(claims.find((c) => matches(c, q)) || null) }));
  for (const m of ["create", "updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "replaceOne"]) {
    jest.spyOn(DirectoryClaim, m).mockImplementation(write);
  }
  jest.spyOn(DirectoryClaim.prototype, "save").mockImplementation(write);
  return write;
}

const entraConn = (id, dir, extra = {}) => ({
  _id: id,
  connectionType: ENTRA,
  directoryId: dir,
  isActive: false,
  autoProvisionUsers: true,
  defaultRoleId: "role0000000000000000000a",
  ...extra,
});
const adminClaim = (tenantId, connectionId, dir, extra = {}) => ({
  _id: `claim-${connectionId}`,
  connectionType: ENTRA,
  directoryId: dir,
  tenantId,
  connectionId,
  status: "verified",
  method: "entra-admin-sign-in",
  sharedDirectoryException: false,
  claimedAt: "2026-10-16T10:00:00.000Z",
  claimedBy: "user:psUserA1",
  verifiedAt: "2026-10-16T10:00:00.000Z",
  verifiedBy: "user:psUserA1",
  verificationEvidence: { directoryUserId: ADMIN_OID, roleTemplateId: GLOBAL_ADMIN },
  ...extra,
});
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

// ---- simulated Microsoft ----
const metadata = (dir, over = {}) => ({
  issuer: `https://login.microsoftonline.com/${dir}/v2.0`,
  authorization_endpoint: `https://login.microsoftonline.com/${dir}/oauth2/v2.0/authorize`,
  token_endpoint: `https://login.microsoftonline.com/${dir}/oauth2/v2.0/token`,
  jwks_uri: `https://login.microsoftonline.com/${dir}/discovery/v2.0/keys`,
  ...over,
});
const tokenOk = () => ({ status: 200, data: { token_type: "Bearer", expires_in: 3599, access_token: MS_ACCESS_TOKEN } });
const msError = (status, error, codes) => ({
  status,
  data: { error, error_description: MS_ERROR_TEXT, error_codes: codes, trace_id: "trace-SECRET", correlation_id: "corr-SECRET" },
});
/** Microsoft answers: metadata (status/data or throw) then token (status/data or throw). */
function microsoft({ meta, token } = {}) {
  axios.get.mockImplementation(async (url) => {
    if (meta instanceof Error) throw meta;
    const dir = url.split("/")[3];
    return meta || { status: 200, data: metadata(dir) };
  });
  axios.post.mockImplementation(async () => {
    if (token instanceof Error) throw token;
    return token || tokenOk();
  });
}
const networkError = (code) => Object.assign(new Error(`network ${code}`), { code, config: { data: `client_secret=${process.env.AZURE_AD_CLIENT_SECRET}` } });

const test5c2 = (over = {}) => load.handler().testConnection({ tenantId: TENANT_A, connectionId: "connA", ...over });
const connA = () => mockTenants[0].authenticationConnections[0];
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

let claimWrite;
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ENTRA_CRM_MULTI_DIRECTORY;
  for (const k of Object.keys(DEV_VARS)) delete process.env[k];
  claims.length = 0;
  mockTenants.length = 0;
  mockTenants.push(
    {
      _id: TENANT_A,
      code: "ORGA",
      isActive: true,
      authenticationConnections: [entraConn("connA", DIR_A), { _id: "b2cA", connectionType: B2C, directoryId: "x", isActive: true }],
    },
    { _id: TENANT_B, code: "ORGB", isActive: true, authenticationConnections: [entraConn("connB", DIR_B)] }
  );
  claims.push(adminClaim(TENANT_A, "connA", DIR_A), adminClaim(TENANT_B, "connB", DIR_B));
  for (const fn of ["log", "info", "warn", "error"]) jest.spyOn(console, fn).mockImplementation(() => {});
  claimWrite = stubClaims();
  microsoft();
});
afterEach(() => {
  for (const k of Object.keys(DEV_VARS)) delete process.env[k];
  jest.restoreAllMocks();
});

describe("preconditions (server-loaded connection, valid verified claim)", () => {
  test("A/G tenant admin's own connection with a normal verified claim -> CONNECTED", async () => {
    const out = await test5c2();
    expect(out).toEqual({ ok: true, code: "CONNECTED", testedAt: expect.any(Date) });
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test("D missing connection / missing tenant -> CONNECTION_NOT_FOUND, Microsoft not contacted, nothing written", async () => {
    await rejectsCode(test5c2({ connectionId: "nope" }), "CONNECTION_NOT_FOUND");
    await rejectsCode(test5c2({ tenantId: "dddddddddddddddddddddddd" }), "CONNECTION_NOT_FOUND");
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(Tenant.updateOne).not.toHaveBeenCalled();
  });

  test("B (handler) another organisation's connection id under this tenant -> CONNECTION_NOT_FOUND", async () => {
    await rejectsCode(test5c2({ connectionId: "connB" }), "CONNECTION_NOT_FOUND");
    expect(axios.get).not.toHaveBeenCalled();
    expect(Tenant.updateOne).not.toHaveBeenCalled();
  });

  test("E non-Entra connection -> NOT_ENTRA_CONNECTION, Microsoft not contacted, nothing written", async () => {
    await rejectsCode(test5c2({ connectionId: "b2cA" }), "NOT_ENTRA_CONNECTION");
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(Tenant.updateOne).not.toHaveBeenCalled();
  });

  test("a connection without a valid directory GUID -> INVALID_DIRECTORY, Microsoft not contacted", async () => {
    connA().directoryId = "common";
    await rejectsCode(test5c2(), "INVALID_DIRECTORY");
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test("F no verified claim -> DIRECTORY_NOT_CLAIMED recorded, Microsoft not contacted", async () => {
    claims.splice(0, 1);
    const out = await test5c2();
    expect(out).toEqual({ ok: false, code: "DIRECTORY_NOT_CLAIMED", testedAt: expect.any(Date) });
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(connA().lastTestResult).toEqual({ ok: false, code: "DIRECTORY_NOT_CLAIMED" });
  });

  test("F2 a pending claim, another organisation's claim, another connection's claim or another directory's claim do not count", async () => {
    const variants = [
      adminClaim(TENANT_A, "connA", DIR_A, { status: "pending", verifiedAt: undefined, verifiedBy: undefined }),
      adminClaim(TENANT_B, "connA", DIR_A),
      adminClaim(TENANT_A, "connX", DIR_A),
      adminClaim(TENANT_A, "connA", DIR_B),
    ];
    for (const c of variants) {
      claims.length = 0;
      claims.push(c);
      axios.get.mockClear();
      await expect(test5c2()).resolves.toMatchObject({ ok: false, code: "DIRECTORY_NOT_CLAIMED" });
      expect(axios.get).not.toHaveBeenCalled();
    }
  });

  test("H valid DEV exception claim -> tested against the shared DEV directory, claim unchanged", async () => {
    Object.assign(process.env, DEV_VARS);
    connA().directoryId = HOME_DIR;
    claims.length = 0;
    claims.push(devClaim(TENANT_A, "connA"), devClaim(TENANT_B, "connB"));
    const before = clone(claims);
    await expect(test5c2()).resolves.toMatchObject({ ok: true, code: "CONNECTED" });
    expect(axios.get.mock.calls[0][0]).toBe(`https://login.microsoftonline.com/${HOME_DIR}/v2.0/.well-known/openid-configuration`);
    expect(axios.post.mock.calls[0][0]).toBe(`https://login.microsoftonline.com/${HOME_DIR}/oauth2/v2.0/token`);
    expect(claims).toEqual(before);
  });

  test("I DEV exception no longer valid (any DEV condition missing) -> DIRECTORY_NOT_CLAIMED, Microsoft not contacted", async () => {
    connA().directoryId = HOME_DIR;
    claims.length = 0;
    claims.push(devClaim(TENANT_A, "connA"));
    for (const missing of Object.keys(DEV_VARS)) {
      Object.assign(process.env, DEV_VARS);
      delete process.env[missing];
      axios.get.mockClear();
      await expect(test5c2()).resolves.toMatchObject({ ok: false, code: "DIRECTORY_NOT_CLAIMED" });
      expect(axios.get).not.toHaveBeenCalled();
    }
    Object.assign(process.env, DEV_VARS, { DEPLOYMENT_ENV: "uat" });
    await expect(test5c2()).resolves.toMatchObject({ ok: false, code: "DIRECTORY_NOT_CLAIMED" });
  });

  test("the connection may be active or inactive", async () => {
    connA().isActive = true;
    await expect(test5c2()).resolves.toMatchObject({ ok: true, code: "CONNECTED" });
    connA().isActive = false;
    await expect(test5c2()).resolves.toMatchObject({ ok: true, code: "CONNECTED" });
  });
});

describe("Microsoft checks", () => {
  test("J OpenID metadata of the connection's directory; then a client-credentials token for the shared app itself", async () => {
    await test5c2();
    const [metaUrl, metaOpts] = axios.get.mock.calls[0];
    expect(metaUrl).toBe(`https://login.microsoftonline.com/${DIR_A}/v2.0/.well-known/openid-configuration`);
    expect(metaOpts).toMatchObject({ timeout: expect.any(Number), maxRedirects: 0 });
    const [tokenUrl, body, tokenOpts] = axios.post.mock.calls[0];
    expect(tokenUrl).toBe(`https://login.microsoftonline.com/${DIR_A}/oauth2/v2.0/token`);
    const form = new URLSearchParams(body);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(process.env.AZURE_AD_CLIENT_SECRET);
    // The application's own audience: no Microsoft Graph, no permissions, no directory data.
    expect(form.get("scope")).toBe(`${CLIENT_ID}/.default`);
    expect(String(body)).not.toMatch(/graph\.microsoft\.com/);
    expect([...form.keys()].sort()).toEqual(["client_id", "client_secret", "grant_type", "scope"]);
    expect(tokenOpts).toMatchObject({ timeout: expect.any(Number), maxRedirects: 0 });
    expect(tokenOpts.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
  });

  test("no Graph / directory-data API is ever called", async () => {
    await test5c2();
    const urls = [...axios.get.mock.calls, ...axios.post.mock.calls].map((c) => c[0]);
    expect(urls.every((u) => u.startsWith("https://login.microsoftonline.com/"))).toBe(true);
  });

  test("K metadata issuer / endpoints not exactly the directory's -> CONFIGURATION_INVALID, no token request", async () => {
    for (const over of [
      { issuer: `https://login.microsoftonline.com/${DIR_B}/v2.0` },
      { issuer: "https://sts.windows.net/x/" },
      { token_endpoint: "https://evil.example/token" },
      { authorization_endpoint: undefined },
      { jwks_uri: undefined },
    ]) {
      microsoft({ meta: { status: 200, data: metadata(DIR_A, over) } });
      axios.post.mockClear();
      await expect(test5c2()).resolves.toMatchObject({ ok: false, code: "CONFIGURATION_INVALID" });
      expect(axios.post).not.toHaveBeenCalled();
    }
  });

  test("L unknown directory (Microsoft 90002) -> DIRECTORY_NOT_FOUND, at metadata or at token", async () => {
    microsoft({ meta: msError(400, "invalid_tenant", [90002]) });
    await expect(test5c2()).resolves.toMatchObject({ ok: false, code: "DIRECTORY_NOT_FOUND" });
    expect(axios.post).not.toHaveBeenCalled();
    microsoft({ token: msError(400, "invalid_request", [90002]) });
    await expect(test5c2()).resolves.toMatchObject({ ok: false, code: "DIRECTORY_NOT_FOUND" });
  });

  test.each([[7000229], [700016], [7000112], [65001], [500011]])(
    "M shared app / service principal missing, disabled or not consented (%s) -> APP_NOT_CONSENTED",
    async (code) => {
      microsoft({ token: msError(code === 65001 ? 400 : 401, code === 65001 ? "invalid_grant" : "invalid_client", [code]) });
      await expect(test5c2()).resolves.toMatchObject({ ok: false, code: "APP_NOT_CONSENTED" });
    }
  );

  test.each([[7000215], [7000222], [7000218]])("N shared application credential rejected (%s) -> CREDENTIAL_INVALID", async (code) => {
    microsoft({ token: msError(401, "invalid_client", [code]) });
    await expect(test5c2()).resolves.toMatchObject({ ok: false, code: "CREDENTIAL_INVALID" });
  });

  test("N classification uses structured codes, never the human-readable text", async () => {
    // Text says "invalid client secret", but the structured code says the app is missing.
    microsoft({ token: { status: 401, data: { error: "invalid_client", error_description: MS_ERROR_TEXT, error_codes: [7000229] } } });
    await expect(test5c2()).resolves.toMatchObject({ code: "APP_NOT_CONSENTED" });
    // No structured code: text alone never classifies.
    microsoft({ token: { status: 401, data: { error: "invalid_client", error_description: MS_ERROR_TEXT } } });
    await expect(test5c2()).resolves.toMatchObject({ code: "CONFIGURATION_INVALID" });
  });

  test.each([
    ["metadata timeout", { meta: networkError("ECONNABORTED") }],
    ["metadata DNS failure", { meta: networkError("ENOTFOUND") }],
    ["metadata 503", { meta: { status: 503, data: "<html>busy</html>" } }],
    ["token timeout", { token: networkError("ETIMEDOUT") }],
    ["token 500", { token: msError(500, "temporarily_unavailable", [90033]) }],
    ["token 429", { token: { status: 429, data: {} } }],
  ])("O %s -> MICROSOFT_UNAVAILABLE", async (_n, ms) => {
    microsoft(ms);
    await expect(test5c2()).resolves.toMatchObject({ ok: false, code: "MICROSOFT_UNAVAILABLE" });
  });

  test("a 200 token response without an access token is not a success", async () => {
    microsoft({ token: { status: 200, data: { token_type: "Bearer" } } });
    await expect(test5c2()).resolves.toMatchObject({ ok: false, code: "CONFIGURATION_INVALID" });
  });

  test("shared application not configured on the server -> CONFIGURATION_INVALID, Microsoft not contacted", async () => {
    const saved = process.env.AZURE_AD_CLIENT_SECRET;
    delete process.env.AZURE_AD_CLIENT_SECRET;
    try {
      await expect(test5c2()).resolves.toMatchObject({ ok: false, code: "CONFIGURATION_INVALID" });
      expect(axios.get).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
    } finally {
      process.env.AZURE_AD_CLIENT_SECRET = saved;
    }
  });

  test("result codes are the documented safe set", () => {
    expect([...load.probe().TEST_RESULT_CODES].sort()).toEqual(
      ["APP_NOT_CONSENTED", "CONFIGURATION_INVALID", "CONNECTED", "CREDENTIAL_INVALID", "DIRECTORY_NOT_CLAIMED", "DIRECTORY_NOT_FOUND", "MICROSOFT_UNAVAILABLE"]
    );
  });
});

describe("persistence: lastTestedAt / lastTestResult only, scoped to tenant + connection + directory", () => {
  test("P success writes lastTestedAt and { ok: true, code: CONNECTED }", async () => {
    const out = await test5c2();
    expect(connA().lastTestResult).toEqual({ ok: true, code: "CONNECTED" });
    expect(connA().lastTestedAt).toBeInstanceOf(Date);
    expect(connA().lastTestedAt).toBe(out.testedAt);
  });

  test("Q failure writes lastTestedAt and { ok: false, code } with the safe code only", async () => {
    microsoft({ token: msError(401, "invalid_client", [7000229]) });
    await test5c2();
    expect(connA().lastTestResult).toEqual({ ok: false, code: "APP_NOT_CONSENTED" });
    expect(connA().lastTestedAt).toBeInstanceOf(Date);
  });

  test("the update sets exactly the two fields, filtered by tenant, connection id, Entra type and stored directory", async () => {
    await test5c2();
    expect(Tenant.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = Tenant.updateOne.mock.calls[0];
    expect(filter._id).toBe(TENANT_A);
    expect(filter.authenticationConnections.$elemMatch).toEqual({ _id: "connA", connectionType: ENTRA, directoryId: DIR_A });
    expect(Object.keys(update).sort()).toEqual(["$set"]);
    expect(Object.keys(update.$set).sort()).toEqual(["authenticationConnections.$.lastTestResult", "authenticationConnections.$.lastTestedAt"]);
    expect(update.$set["authenticationConnections.$.lastTestResult"]).toEqual({ ok: true, code: "CONNECTED" });
  });

  test("R/S/T/U DirectoryClaim byte-identical; isActive, directoryId, provisioning, defaultRole and connect fields unchanged", async () => {
    connA().connectedAt = "2026-10-16T10:00:00.000Z";
    connA().connectedBy = "psUserA1";
    const claimsBefore = JSON.stringify(claims);
    const fields = ["_id", "connectionType", "directoryId", "isActive", "autoProvisionUsers", "defaultRoleId", "connectedAt", "connectedBy"];
    const pick = (c) => Object.fromEntries(fields.map((k) => [k, c[k]]));
    const before = pick(connA());
    const otherConnections = JSON.stringify([mockTenants[0].authenticationConnections[1], mockTenants[1]]);
    for (const ms of [{}, { token: msError(401, "invalid_client", [7000215]) }]) {
      microsoft(ms);
      await test5c2();
      expect(JSON.stringify(claims)).toBe(claimsBefore);
      expect(pick(connA())).toEqual(before);
      expect(JSON.stringify([mockTenants[0].authenticationConnections[1], mockTenants[1]])).toBe(otherConnections);
    }
    expect(claimWrite).not.toHaveBeenCalled();
  });

  test("V no user or role model is touched", () => {
    const fs = require("fs");
    const path = require("path");
    for (const f of ["handlers/entraConnect.handler.js", "helpers/entraConnectionTest.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      expect(src).not.toMatch(/models\/(user|role)\.model|require\(["'][^"']*(user|role)\.handler/);
    }
  });

  test("W connection directory changed while Microsoft was being called -> CONNECTION_CHANGED, nothing written", async () => {
    axios.post.mockImplementation(async () => {
      connA().directoryId = DIR_B; // edited by someone else mid-test
      return tokenOk();
    });
    await rejectsCode(test5c2(), "CONNECTION_CHANGED");
    expect(connA().lastTestResult).toBeUndefined();
    expect(connA().lastTestedAt).toBeUndefined();
  });

  test("W2 connection removed while Microsoft was being called -> CONNECTION_CHANGED", async () => {
    axios.post.mockImplementation(async () => {
      mockTenants[0].authenticationConnections.splice(0, 1);
      return tokenOk();
    });
    await rejectsCode(test5c2(), "CONNECTION_CHANGED");
  });
});

describe("status (derived) after a test", () => {
  const status = () => load.handler().getConnectionStatus({ tenantId: TENANT_A, connectionId: "connA" });

  test("Z failed test: connected -> test_failed; successful test: test_failed -> connected; claim status unchanged", async () => {
    await expect(status()).resolves.toMatchObject({ status: "connected" });
    microsoft({ token: msError(401, "invalid_client", [7000229]) });
    await test5c2();
    await expect(status()).resolves.toMatchObject({ status: "test_failed", lastTestResult: { ok: false, code: "APP_NOT_CONSENTED" } });
    microsoft();
    await test5c2();
    const s = await status();
    expect(s).toMatchObject({ status: "connected", lastTestResult: { ok: true, code: "CONNECTED" } });
    expect(s.lastTestedAt).toBeTruthy();
    expect(claims[0].status).toBe("verified");
  });

  test("status never exposes Microsoft or credential details", async () => {
    microsoft({ token: msError(401, "invalid_client", [7000215]) });
    await test5c2();
    expect(JSON.stringify(await status())).not.toMatch(/AADSTS|7000215|SECRET|invalid_client|error_description|trace/);
  });
});

describe("secrets: no token, credential or raw Microsoft error is returned, persisted or logged", () => {
  test("X the client-credentials token is never returned, persisted or logged", async () => {
    const out = await test5c2();
    const persisted = JSON.stringify({ claims, mockTenants });
    const logs = logged();
    for (const s of [MS_ACCESS_TOKEN, "ms-client-credentials-SECRET", process.env.AZURE_AD_CLIENT_SECRET]) {
      expect(JSON.stringify(out)).not.toContain(s);
      expect(persisted).not.toContain(s);
      expect(logs).not.toContain(s);
    }
    expect(Object.keys(out).sort()).toEqual(["code", "ok", "testedAt"]);
  });

  test("Y raw Microsoft errors (text, structured codes, trace ids) are never returned, persisted or logged", async () => {
    const cases = [
      { token: msError(401, "invalid_client", [7000215]) },
      { token: msError(500, "temporarily_unavailable", [90033]) },
      { meta: msError(400, "invalid_tenant", [90002]) },
      { token: networkError("ETIMEDOUT") },
      { token: { status: 401, data: { error: "invalid_client", error_description: MS_ERROR_TEXT } } },
    ];
    for (const ms of cases) {
      microsoft(ms);
      const out = await test5c2();
      const persisted = JSON.stringify(mockTenants);
      const logs = logged();
      for (const s of ["AADSTS", MS_ERROR_TEXT, "SECRET-TRACE", "trace-SECRET", "corr-SECRET", "invalid_client", "invalid_tenant", "temporarily_unavailable", process.env.AZURE_AD_CLIENT_SECRET]) {
        expect(JSON.stringify(out)).not.toContain(s);
        expect(persisted).not.toContain(s);
        expect(logs).not.toContain(s);
      }
      expect(JSON.stringify(out)).not.toMatch(/7000215|90033|90002/);
    }
  });
});

describe("controller: response shape and HTTP status", () => {
  function fakeRes() {
    const res = { statusCode: null, body: null };
    res.status = (s) => ((res.statusCode = s), res);
    res.json = (b) => ((res.body = b), res);
    res.success = (data) => res.status(200).json({ status: "success", data });
    res.sendAppError = (e) => res.status(e.status).json({ success: false, error: { message: e.message, code: e.code, status: e.status } });
    res.sendInternalError = (m) => res.status(500).json({ success: false, error: { message: m } });
    return res;
  }
  const call = async (params = {}) => {
    const res = fakeRes();
    await load.controller().testEntraConnection(
      { params: { id: TENANT_A, connectionId: "connA", ...params }, body: { directoryId: DIR_B, tenantId: TENANT_B, ok: true }, query: { directoryId: DIR_B }, ctx: { userId: "u1", tenantId: TENANT_A } },
      res
    );
    return res;
  };

  test("success -> 200 { ok: true, code: CONNECTED, testedAt }", async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ ok: true, code: "CONNECTED", testedAt: expect.any(Date) });
  });

  test.each([
    [{ token: msError(400, "invalid_request", [90002]) }, 422, "DIRECTORY_NOT_FOUND"],
    [{ token: msError(401, "invalid_client", [7000229]) }, 422, "APP_NOT_CONSENTED"],
    [{ token: msError(401, "invalid_client", [7000215]) }, 502, "CREDENTIAL_INVALID"],
    [{ token: networkError("ETIMEDOUT") }, 503, "MICROSOFT_UNAVAILABLE"],
    [{ meta: { status: 200, data: { issuer: "x" } } }, 422, "CONFIGURATION_INVALID"],
  ])("failure -> safe status + { ok: false, code, testedAt } (%#)", async (ms, http, code) => {
    microsoft(ms);
    const res = await call();
    expect(res.statusCode).toBe(http);
    expect(res.body.data).toEqual({ ok: false, code, testedAt: expect.any(Date) });
  });

  test("DIRECTORY_NOT_CLAIMED -> 409 with the result shape", async () => {
    claims.length = 0;
    const res = await call();
    expect(res.statusCode).toBe(409);
    expect(res.body.data).toEqual({ ok: false, code: "DIRECTORY_NOT_CLAIMED", testedAt: expect.any(Date) });
  });

  test("precondition errors use the standard safe error envelope; body / query directory and tenant are ignored", async () => {
    expect((await call({ connectionId: "nope" })).statusCode).toBe(404);
    expect((await call({ connectionId: "b2cA" })).statusCode).toBe(400);
    await call();
    expect(axios.get.mock.calls[0][0]).toContain(DIR_A);
    expect(Tenant.updateOne.mock.calls[0][0]._id).toBe(TENANT_A);
  });

  test("CONNECTION_CHANGED -> safe error, nothing written", async () => {
    axios.post.mockImplementation(async () => {
      connA().directoryId = DIR_B;
      return tokenOk();
    });
    const res = await call();
    expect(res.body.error).toMatchObject({ code: "CONNECTION_CHANGED" });
    expect(connA().lastTestResult).toBeUndefined();
  });
});

describe("switch OFF and sign-in unaffected", () => {
  test("Test Connection does not enable sign-in: multi-directory stays OFF, foreign directory still DIRECTORY_NOT_ENABLED", async () => {
    await test5c2();
    expect(process.env.ENTRA_CRM_MULTI_DIRECTORY).toBeUndefined();
    let code = null;
    try {
      require("../helpers/connectionAuthConfig").resolveConnectionAuthConfig({ ...connA(), isActive: true });
    } catch (e) {
      code = e.code;
    }
    expect(code).toBe("DIRECTORY_NOT_ENABLED");
  });
});
