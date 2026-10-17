/**
 * Phase 3A: connection-driven authentication configuration (compatibility mode).
 *
 *  - helpers/authAppRegistry.js: server-side app registrations (client id, redirect URI, scopes,
 *    secret) - env-backed today, never MongoDB, secret non-enumerable.
 *  - helpers/connectionAuthConfig.js: resolveConnectionAuthConfig(connection) - the directory comes
 *    from the selected connection; issuer/JWKS/endpoints are derived from it; only the CRM app's
 *    home directory is enabled (compatibility assertion); stored issuerUrl/audience are not read.
 *  - CRM sign-in: organisation code -> exactly one active Entra connection (not filtered by the env
 *    directory) -> authorize URL, token exchange and ID token verification from that connection's
 *    resolved config; the callback restores tenant + connection from the server-side state only and
 *    ignores any redirect URI from the body or Origin header; JWKS cached per directory.
 *  - B2C (legacy shared directory): same resolver boundary, no hardcoded tenant/client fallbacks.
 *
 * New modules are required inside the tests so each test fails on its own against older code.
 */
jest.mock("axios", () => ({ post: jest.fn(), get: jest.fn() }));

const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_B = "cccccccccccccccccccccccc";
const HOME_DIR = process.env.AZURE_AD_TENANT_ID; // tests/setupEntraEnv.js
const OTHER_DIR = "11111111-2222-3333-4444-555555555555";
const CLIENT_ID = process.env.AZURE_AD_CLIENT_ID;
const SECRET = process.env.AZURE_AD_CLIENT_SECRET;
const TRUSTED_REDIRECT = process.env.AZURE_AD_REDIRECT_URI;
const EVIL_REDIRECT = "https://evil.example/auth/azure-crm";
const ENTRA = "Entra ID (Azure AD)";
const B2C = "Azure B2C";

const mockTenants = [];
const mockRows = (q) =>
  mockTenants.filter((t) => {
    if (t.isActive === false) return false;
    if (q.$or) return q.$or.some((c) => (c.code && c.code === t.code) || (c._id && String(c._id) === t._id));
    if (q.code !== undefined) return q.code === t.code; // login resolution queries by Organisation Code only
    return String(q._id) === t._id;
  });
const mockQuery = (value) => ({
  lean: async () => JSON.parse(JSON.stringify(value)),
  then: (ok, ko) => Promise.resolve(value).then(ok, ko),
});
jest.mock("../models/tenant.model", () => ({
  find: (q) => ({ select: () => mockQuery(mockRows(q)) }),
  findOne: (q) => ({ select: () => mockQuery(mockRows(q)[0] || null) }),
}));
jest.mock("../helpers/jwt", () => ({ generateToken: jest.fn().mockResolvedValue({ token: "signed.jwt" }) }));

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const AzureADHandler = require("../handlers/azure.ad.handler");
const { makeTestKeypairAndJwks, signTestJwt } = require("./helpers/testJwt");

const load = {
  registry: () => require("../helpers/authAppRegistry"),
  resolver: () => require("../helpers/connectionAuthConfig"),
  context: () => require("../helpers/loginTenantContext"),
};
const resolve = (connection, ctx) => load.resolver().resolveConnectionAuthConfig(connection, ctx);
const entraConn = (id, extra = {}) => ({
  _id: id,
  connectionType: ENTRA,
  directoryId: HOME_DIR,
  isActive: true,
  // Placeholder values as stored on DEV: never read.
  issuerUrl: "https://login.microsoftonline.com/your-ad-directory-id/v2.0",
  audience: "your-ad-audience-value",
  ...extra,
});
const b2cConn = (id, extra = {}) => ({
  _id: id,
  connectionType: B2C,
  directoryId: "b2c-dir",
  isActive: true,
  issuerUrl: "https://login.microsoftonline.com/your-b2c-directory-id/v2.0",
  audience: "your-b2c-audience-value",
  ...extra,
});
const thrown = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
};
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const res = () => {
  const r = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};
async function startLogin(query) {
  const { generatePKCE } = require("../controllers/pkce.controller");
  const r = res();
  const next = jest.fn();
  await generatePKCE({ query }, r, next);
  if (next.mock.calls.length) return { error: next.mock.calls[0][0], r };
  const body = r.json.mock.calls[0][0];
  const url = new URL(body.authorizationUrls.azureAD);
  return { url, state: url.searchParams.get("state"), nonce: url.searchParams.get("nonce") };
}
const logged = () =>
  [console.log, console.error, console.warn]
    .flatMap((fn) => fn.mock.calls)
    .map((args) => args.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" "))
    .join("\n");

beforeEach(() => {
  jest.clearAllMocks();
  mockTenants.length = 0;
  mockTenants.push(
    { _id: TENANT_A, code: "MULTIAUTH", isActive: true, authenticationConnections: [entraConn("connA"), b2cConn("b2cA")] },
    { _id: TENANT_B, code: "DEVTENANTB", isActive: true, authenticationConnections: [entraConn("connB")] }
  );
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("server-side application configuration", () => {
  test("A1 entraCrm comes from the server configuration; the secret is non-enumerable and never serialised", () => {
    const app = load.registry().getEntraCrmApp();
    expect(app).toMatchObject({ application: "entraCrm", clientId: CLIENT_ID, redirectUri: TRUSTED_REDIRECT });
    expect(app.clientSecret).toBe(SECRET);
    expect(Object.keys(app)).not.toContain("clientSecret");
    expect(JSON.stringify(app)).not.toContain(SECRET);
    expect(Object.isFrozen(app)).toBe(true);
  });

  test("A2 applications are fixed per provider: no per-connection application selection exists", () => {
    const reg = load.registry();
    expect(Object.keys(reg).sort()).toEqual(["AuthConfigError", "B2C", "ENTRA", "getEntraCrmApp", "getLegacySharedB2CApp"]);
    expect(reg.getLegacySharedB2CApp()).toMatchObject({ application: "legacySharedB2C", clientId: process.env.MS_CLIENT_ID });
  });
});

describe("resolveConnectionAuthConfig - Entra", () => {
  test("E1 directory from the connection; issuer, JWKS and endpoints derived; app values from the registry", () => {
    const c = resolve(entraConn("connA"));
    const base = `https://login.microsoftonline.com/${HOME_DIR}`;
    expect(c).toMatchObject({
      provider: "entra",
      mode: "connection",
      connectionId: "connA",
      directoryId: HOME_DIR,
      application: "entraCrm",
      clientId: CLIENT_ID,
      audience: CLIENT_ID,
      redirectUri: TRUSTED_REDIRECT,
      scopes: "openid profile email offline_access",
      authorityHost: "login.microsoftonline.com",
      issuer: `${base}/v2.0`,
      jwksUri: `${base}/discovery/v2.0/keys`,
      authorizeEndpoint: `${base}/oauth2/v2.0/authorize`,
      tokenEndpoint: `${base}/oauth2/v2.0/token`,
      logoutEndpoint: `${base}/oauth2/v2.0/logout`,
    });
    // Stored placeholder issuerUrl/audience are not read.
    expect(JSON.stringify(c)).not.toMatch(/your-ad-/);
    expect(c.clientSecret).toBe(SECRET);
    expect(JSON.stringify(c)).not.toContain(SECRET);
    expect(Object.isFrozen(c)).toBe(true);
  });

  test("E2 a connection for another directory fails closed (compatibility mode)", () => {
    const e = thrown(() => resolve(entraConn("connX", { directoryId: OTHER_DIR })));
    expect(e).toMatchObject({ name: "AuthConfigError", code: "DIRECTORY_NOT_ENABLED" });
    expect(load.resolver().isOrganisationConfigError(e)).toBe(true);
    expect(e.message).not.toContain(OTHER_DIR);
  });

  test.each([
    ["inactive", { isActive: false }, "CONNECTION_INACTIVE"],
    ["isActive unset", { isActive: undefined }, "CONNECTION_INACTIVE"],
    ["no directory", { directoryId: undefined }, "INVALID_DIRECTORY"],
    ["placeholder directory", { directoryId: "your-ad-directory-id" }, "INVALID_DIRECTORY"],
    ["path in directory", { directoryId: `${HOME_DIR}/../evil` }, "INVALID_DIRECTORY"],
  ])("E3 %s -> %s", (_d, extra, code) => {
    expect(thrown(() => resolve(entraConn("c", extra)))).toMatchObject({ code });
  });

  test("E4 without a connection (legacy no-code login) the CRM app's home directory is used", () => {
    const c = resolve(null, { connectionType: ENTRA });
    expect(c).toMatchObject({ mode: "legacy-no-organisation", connectionId: null, directoryId: HOME_DIR });
  });

  test("E5 the directory tracks the selected connection: with another home directory enabled, it resolves to that directory and the former one is refused", async () => {
    await withEnv({ AZURE_AD_TENANT_ID: OTHER_DIR }, () => {
      const c = resolve(entraConn("connX", { directoryId: OTHER_DIR }));
      expect(c.directoryId).toBe(OTHER_DIR);
      for (const u of [c.issuer, c.jwksUri, c.authorizeEndpoint, c.tokenEndpoint]) {
        expect(u).toContain(`/${OTHER_DIR}/`);
        expect(u).not.toContain(HOME_DIR);
      }
      expect(thrown(() => resolve(entraConn("connA")))).toMatchObject({ code: "DIRECTORY_NOT_ENABLED" });
    });
  });

  test("E6 missing Entra configuration fails closed (names only)", async () => {
    await withEnv({ AZURE_AD_CLIENT_SECRET: undefined }, () => {
      const e = thrown(() => resolve(entraConn("connA")));
      expect(e).toMatchObject({ code: "ENTRA_NOT_CONFIGURED", missing: ["AZURE_AD_CLIENT_SECRET"] });
    });
  });
});

describe("resolveConnectionAuthConfig - Azure B2C (legacy shared directory)", () => {
  test("B1 shared B2C configuration from the server; per-policy endpoints; connection placeholders not read", () => {
    const c = resolve(b2cConn("b2cA"), { policy: "B2C_1_projectshell_signin" });
    const flow = "https://projectshellab2c.b2clogin.com/projectshellab2c.onmicrosoft.com/B2C_1_projectshell_signin";
    expect(c).toMatchObject({
      provider: "azure-b2c",
      mode: "legacy-shared-directory",
      application: "legacySharedB2C",
      clientId: process.env.MS_CLIENT_ID,
      audience: process.env.MS_CLIENT_ID,
      redirectUri: process.env.MS_REDIRECT_URI,
      directoryId: process.env.MS_B2C_DIRECTORY_ID,
      issuer: `https://projectshellab2c.b2clogin.com/${process.env.MS_B2C_DIRECTORY_ID}/v2.0/`,
      jwksUri: `${flow}/discovery/v2.0/keys`,
      authorizeEndpoint: `${flow}/oauth2/v2.0/authorize`,
      tokenEndpoint: `${flow}/oauth2/v2.0/token`,
    });
    expect(JSON.stringify(c)).not.toMatch(/your-b2c-/);
  });

  test.each(["MS_CLIENT_ID", "MS_TENANT_NAME", "MS_REDIRECT_URI", "MS_B2C_DIRECTORY_ID"])(
    "B2 missing %s fails closed instead of a hardcoded default",
    async (name) => {
      await withEnv({ [name]: undefined }, async () => {
        const e = thrown(() => resolve(null, { connectionType: B2C, policy: "B2C_1_projectshell_signin" }));
        expect(e).toMatchObject({ code: "B2C_NOT_CONFIGURED", missing: [name] });
        const { b2cAuthorizationUrl } = require("../helpers/b2cPolicy");
        expect(() => b2cAuthorizationUrl("B2C_1_projectshell_signin", { state: "s", codeChallenge: "c" })).toThrow(name);
        const B2CUsersHandler = require("../handlers/b2c.users.handler");
        await expect(B2CUsersHandler.exchangeCodeForTokens("code", "verifier", "B2C_1_projectshell_signin")).rejects.toThrow(name);
        expect(axios.post).not.toHaveBeenCalled();
      });
    }
  );

  test("B3 the B2C code has no hardcoded tenant, client id or redirect fallbacks", () => {
    for (const f of ["helpers/b2cPolicy.js", "handlers/b2c.users.handler.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      expect(src).not.toMatch(/e3688a2f-3956-42f9-8c98-6fea7a60a5b4/);
      expect(src).not.toMatch(/MS_TENANT_NAME \|\||projectshellAB2C/);
      expect(src).not.toMatch(/MS_REDIRECT_URI \|\||"http:\/\/localhost:3000"/);
      expect(src).not.toMatch(/process\.env\.(MS_CLIENT_ID|MS_B2C_DIRECTORY_ID)/);
    }
  });

  test("B4 a missing B2C configuration does not break the CRM sign-in start", async () => {
    await withEnv({ MS_CLIENT_ID: undefined }, async () => {
      const s = await startLogin({ tenant: "MULTIAUTH" });
      expect(s.url.pathname).toBe(`/${HOME_DIR}/oauth2/v2.0/authorize`);
    });
  });
});

describe("organisation selection (organisation code is a locator only)", () => {
  test("O1 the code selects the organisation and its one active Entra connection - not filtered by the env directory", async () => {
    mockTenants[1].authenticationConnections = [entraConn("connB", { directoryId: OTHER_DIR })];
    const out = await load.context().resolveLoginTenant("devtenantb");
    expect(out).toMatchObject({ tenantId: TENANT_B, connectionId: "connB" });
    expect(out.connection.directoryId).toBe(OTHER_DIR);
  });

  test("O2 zero or several active Entra connections fail closed; inactive and B2C connections do not count", async () => {
    const { resolveLoginTenant } = load.context();
    mockTenants[1].authenticationConnections = [entraConn("x", { isActive: false }), b2cConn("y")];
    await expect(resolveLoginTenant("DEVTENANTB")).rejects.toMatchObject({ code: "NO_ENTRA_CONNECTION" });
    mockTenants[1].authenticationConnections = [entraConn("x"), entraConn("y")];
    await expect(resolveLoginTenant("DEVTENANTB")).rejects.toMatchObject({ code: "MULTIPLE_ENTRA_CONNECTIONS" });
    mockTenants[1].authenticationConnections = [entraConn("x"), entraConn("y", { isActive: false })];
    await expect(resolveLoginTenant("DEVTENANTB")).resolves.toMatchObject({ connectionId: "x" });
  });

  test("O3 the callback connection is reloaded from the state ids and must still be active Entra in that organisation", async () => {
    const { loadLoginConnection } = load.context();
    await expect(loadLoginConnection({ tenantId: TENANT_B, connectionId: "connB" })).resolves.toMatchObject({ _id: "connB" });
    for (const ctx of [
      { tenantId: TENANT_B, connectionId: "connA" }, // another organisation's connection
      { tenantId: TENANT_A, connectionId: "b2cA" }, // not Entra
      { tenantId: TENANT_B, connectionId: "missing" },
      { tenantId: "dddddddddddddddddddddddd", connectionId: "connB" },
    ]) {
      await expect(loadLoginConnection(ctx)).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
    }
    mockTenants[1].authenticationConnections = [entraConn("connB", { isActive: false })];
    await expect(loadLoginConnection({ tenantId: TENANT_B, connectionId: "connB" })).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
    mockTenants[1].isActive = false;
    mockTenants[1].authenticationConnections = [entraConn("connB")];
    await expect(loadLoginConnection({ tenantId: TENANT_B, connectionId: "connB" })).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
  });
});

describe("CRM authorize URL (GET /pkce/generate)", () => {
  test("P1 built from the selected connection's directory and the trusted app registration; state holds tenant + connection", async () => {
    const s = await startLogin({ tenant: "DEVTENANTB" });
    expect(s.url.origin).toBe("https://login.microsoftonline.com");
    expect(s.url.pathname).toBe(`/${HOME_DIR}/oauth2/v2.0/authorize`);
    expect(s.url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(s.url.searchParams.get("redirect_uri")).toBe(TRUSTED_REDIRECT);
    expect(s.url.searchParams.get("scope")).toBe("openid profile email offline_access");
    const tx = require("../helpers/pkceStateStore").takeLoginTransaction(s.state);
    expect(tx).toEqual({ nonce: s.nonce, loginContext: { tenantId: TENANT_B, connectionId: "connB" } });
  });

  test("P2 a connection whose directory is not enabled -> generic 400, no authorize URL", async () => {
    mockTenants[1].authenticationConnections = [entraConn("connB", { directoryId: OTHER_DIR })];
    const out = await startLogin({ tenant: "DEVTENANTB" });
    expect(out.error).toMatchObject({ status: 400, message: "Microsoft sign-in is not available for this organisation" });
    expect(out.r.json).not.toHaveBeenCalled();
    expect(logged()).toMatch(/DIRECTORY_NOT_ENABLED/);
    expect(logged()).not.toContain(OTHER_DIR);
  });

  test("P3 several active Entra connections -> generic 400", async () => {
    mockTenants[1].authenticationConnections = [entraConn("x"), entraConn("y")];
    const out = await startLogin({ tenant: "DEVTENANTB" });
    expect(out.error).toMatchObject({ status: 400 });
  });

  test("P4 without an organisation code: legacy URL for the home directory, no tenant context", async () => {
    const s = await startLogin({});
    expect(s.url.pathname).toBe(`/${HOME_DIR}/oauth2/v2.0/authorize`);
    const tx = require("../helpers/pkceStateStore").takeLoginTransaction(s.state);
    expect(tx.loginContext).toBeNull();
  });
});

describe("CRM callback (POST /auth/azure-crm)", () => {
  async function callback(body, headers = {}, query = {}) {
    const { handleAzureADCallback } = require("../controllers/azure.ad.controller");
    const r = res();
    const next = jest.fn();
    await handleAzureADCallback({ body, headers, query }, r, next);
    return { r, next };
  }

  test("C1 a redirect URI in the body, Origin or Referer is ignored", async () => {
    const spy = jest
      .spyOn(AzureADHandler, "handleAzureADAuth")
      .mockResolvedValue({ user: { _id: "u", userEmail: "e", tokens: {} } });
    const s = await startLogin({ tenant: "DEVTENANTB" });
    await callback(
      { code: "c", codeVerifier: "v", state: s.state, redirectUri: EVIL_REDIRECT },
      { origin: "https://evil.example", referer: "https://evil.example/x" }
    );
    expect(spy).toHaveBeenCalledWith("c", "v", s.nonce, { tenantId: TENANT_B, connectionId: "connB" });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/evil\.example/);
  });

  test("C2 tenant, connection and directory hints in body / query / headers cannot replace the state", async () => {
    const spy = jest
      .spyOn(AzureADHandler, "handleAzureADAuth")
      .mockResolvedValue({ user: { _id: "u", userEmail: "e", tokens: {} } });
    const s = await startLogin({ tenant: "DEVTENANTB" });
    await callback(
      { code: "c", codeVerifier: "v", state: s.state, tenantId: TENANT_A, connectionId: "connA", directoryId: OTHER_DIR, tenant: "MULTIAUTH" },
      { "x-tenant-id": TENANT_A },
      { tenant: "MULTIAUTH", connectionId: "connA" }
    );
    expect(spy.mock.calls[0][3]).toEqual({ tenantId: TENANT_B, connectionId: "connB" });
  });

  test("C3 the controller no longer reads a redirect URI from the request", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "azure.ad.controller.js"), "utf8");
    expect(src).not.toMatch(/req\.headers\.origin|req\.headers\.referer|finalRedirectUri/);
    expect(src).not.toMatch(/\{\s*code,\s*codeVerifier,\s*redirectUri/);
  });
});

describe("CRM token exchange and handler", () => {
  test("H1 the token request uses the resolved endpoint, client, secret and trusted redirect URI", async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { id_token: "x" } });
    const config = resolve(entraConn("connB"));
    await AzureADHandler.exchangeCodeForTokens("code-1", "verifier-1", config);
    const [url, body] = axios.post.mock.calls[0];
    expect(url).toBe(`https://login.microsoftonline.com/${HOME_DIR}/oauth2/v2.0/token`);
    const p = new URLSearchParams(body);
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("client_secret")).toBe(SECRET);
    expect(p.get("redirect_uri")).toBe(TRUSTED_REDIRECT);
  });

  test("H2 no exchange without a resolved configuration (no independent env read)", async () => {
    await expect(AzureADHandler.exchangeCodeForTokens("code", "verifier")).rejects.toThrow(/resolved connection configuration/);
    await expect(AzureADHandler.exchangeCodeForTokens("code", "verifier", EVIL_REDIRECT)).rejects.toThrow();
    expect(axios.post).not.toHaveBeenCalled();
  });

  function spyFlow() {
    const exchange = jest.spyOn(AzureADHandler, "exchangeCodeForTokens").mockResolvedValue({ id_token: "i", access_token: "a" });
    const decode = jest.spyOn(AzureADHandler, "decodeIdToken").mockResolvedValue({ userEmail: "e" });
    jest.spyOn(AzureADHandler, "getUserInfoFromGraph").mockResolvedValue({});
    const find = jest.spyOn(AzureADHandler, "findOrCreateUser").mockResolvedValue({ _id: "u", tenantId: TENANT_B });
    return { exchange, decode, find };
  }

  test("H3 tenant-scoped: the connection from the state drives exchange and verification", async () => {
    const { exchange, decode, find } = spyFlow();
    const ctx = { tenantId: TENANT_B, connectionId: "connB" };
    await AzureADHandler.handleAzureADAuth("code", "verifier", "nonce", ctx);
    const config = exchange.mock.calls[0][2];
    expect(config).toMatchObject({ connectionId: "connB", directoryId: HOME_DIR, mode: "connection" });
    expect(decode.mock.calls[0]).toEqual(["i", "nonce", config]);
    expect(find.mock.calls[0][2]).toEqual(ctx);
  });

  test.each([
    ["deactivated since the login started", () => { mockTenants[1].authenticationConnections = [entraConn("connB", { isActive: false })]; }],
    ["removed since the login started", () => { mockTenants[1].authenticationConnections = []; }],
    ["moved to a directory that is not enabled", () => { mockTenants[1].authenticationConnections = [entraConn("connB", { directoryId: OTHER_DIR })]; }],
  ])("H4 connection %s -> 403 before any token request", async (_d, change) => {
    const { exchange, find } = spyFlow();
    change();
    await expect(
      AzureADHandler.handleAzureADAuth("code", "verifier", "nonce", { tenantId: TENANT_B, connectionId: "connB" })
    ).rejects.toMatchObject({ status: 403, message: "CRM sign-in is not available for this account" });
    expect(exchange).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });

  test("H5 legacy no-code login: home-directory configuration, no tenant context (existing-user-only path unchanged)", async () => {
    const { exchange, find } = spyFlow();
    await AzureADHandler.handleAzureADAuth("code", "verifier", "nonce", null);
    expect(exchange.mock.calls[0][2]).toMatchObject({ mode: "legacy-no-organisation", directoryId: HOME_DIR });
    expect(find.mock.calls[0][2]).toBeNull();
  });

  test("H6 the sign-in code no longer reads the directory or app from the environment", () => {
    for (const f of ["handlers/azure.ad.handler.js", "controllers/pkce.controller.js", "controllers/azure.ad.controller.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      expect(src).not.toMatch(/AZURE_AD_TENANT_ID|AZURE_AD_CLIENT_ID|getEntraConfig\(/);
      expect(src).not.toMatch(/login\.microsoftonline\.com\/\$\{/);
    }
  });
});

describe("ID token verification against the selected connection", () => {
  let kpA;
  let kpB;
  const claims = (dir, extra = {}) => ({
    iss: `https://login.microsoftonline.com/${dir}/v2.0`,
    aud: CLIENT_ID,
    tid: dir,
    oid: "oid-1",
    email: "staff@example.com",
    nonce: "n",
    ...extra,
  });
  const configFor = (dir) => {
    const prev = process.env.AZURE_AD_TENANT_ID;
    process.env.AZURE_AD_TENANT_ID = dir;
    try {
      return resolve(entraConn("c", { directoryId: dir }));
    } finally {
      process.env.AZURE_AD_TENANT_ID = prev;
    }
  };

  beforeAll(async () => {
    kpA = await makeTestKeypairAndJwks();
    kpB = await makeTestKeypairAndJwks();
  });
  beforeEach(() => {
    AzureADHandler._resetJwksForTests(kpA.jwks, configFor(HOME_DIR).jwksUri);
    AzureADHandler._resetJwksForTests(kpB.jwks, configFor(OTHER_DIR).jwksUri);
  });
  afterAll(() => AzureADHandler._resetJwksForTests(null));

  test("V1 a valid token for the connection's directory is accepted", async () => {
    const token = await signTestJwt(kpA.privateKey, claims(HOME_DIR));
    await expect(AzureADHandler.verifyIdToken(token, "n", configFor(HOME_DIR))).resolves.toMatchObject({ tid: HOME_DIR });
  });

  test("V2 tid mismatch is rejected", async () => {
    const token = await signTestJwt(kpA.privateKey, claims(HOME_DIR, { tid: OTHER_DIR }));
    await expect(AzureADHandler.verifyIdToken(token, "n", configFor(HOME_DIR))).rejects.toThrow(/tenant mismatch/);
  });

  test("V3 an issuer of another directory is rejected", async () => {
    const token = await signTestJwt(kpA.privateKey, claims(HOME_DIR, { iss: `https://login.microsoftonline.com/${OTHER_DIR}/v2.0` }));
    await expect(AzureADHandler.verifyIdToken(token, "n", configFor(HOME_DIR))).rejects.toMatchObject({ code: "ERR_JWT_CLAIM_VALIDATION_FAILED" });
  });

  test("V4 an audience other than the app registration's client id is rejected", async () => {
    const token = await signTestJwt(kpA.privateKey, claims(HOME_DIR, { aud: "another-client" }));
    await expect(AzureADHandler.verifyIdToken(token, "n", configFor(HOME_DIR))).rejects.toMatchObject({ code: "ERR_JWT_CLAIM_VALIDATION_FAILED" });
  });

  test("V5 JWKS are cached per directory: directory A's keys never verify a token for directory B", async () => {
    // Signed with A's key, claims otherwise valid for B: B's own JWKS is used, so the signature fails.
    const forged = await signTestJwt(kpA.privateKey, claims(OTHER_DIR));
    await expect(AzureADHandler.verifyIdToken(forged, "n", configFor(OTHER_DIR))).rejects.toMatchObject({
      code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    });
    // The same keys work for their own directory.
    const genuine = await signTestJwt(kpB.privateKey, claims(OTHER_DIR));
    await expect(AzureADHandler.verifyIdToken(genuine, "n", configFor(OTHER_DIR))).resolves.toMatchObject({ tid: OTHER_DIR });
    const otherWay = await signTestJwt(kpB.privateKey, claims(HOME_DIR));
    await expect(AzureADHandler.verifyIdToken(otherWay, "n", configFor(HOME_DIR))).rejects.toMatchObject({
      code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    });
  });

  test("V6 verification requires a resolved configuration", async () => {
    const token = await signTestJwt(kpA.privateKey, claims(HOME_DIR));
    await expect(AzureADHandler.verifyIdToken(token, "n")).rejects.toThrow(/no resolved connection configuration/);
  });

  test("V7 the handler has no process-wide single-directory JWKS", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "handlers", "azure.ad.handler.js"), "utf8");
    expect(src).not.toMatch(/jwksSingleton/);
    expect(src).toMatch(/new Map\(\)/);
  });
});

describe("secrets", () => {
  test("S1 sign-in logs carry no client secret, code, verifier, token or resolved configuration", async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { id_token: "ID.TOKEN.SECRETVALUE", access_token: "ACCESS.SECRETVALUE" } });
    jest.spyOn(AzureADHandler, "decodeIdToken").mockResolvedValue({ userEmail: "e" });
    jest.spyOn(AzureADHandler, "getUserInfoFromGraph").mockResolvedValue({});
    jest.spyOn(AzureADHandler, "findOrCreateUser").mockResolvedValue({ _id: "u", tenantId: TENANT_B });
    await AzureADHandler.handleAzureADAuth("CODE-SECRETVALUE", "VERIFIER-SECRETVALUE", "nonce", { tenantId: TENANT_B, connectionId: "connB" });
    axios.post.mockRejectedValueOnce(
      Object.assign(new Error("Request failed"), {
        config: { data: `client_secret=${SECRET}&code=CODE-SECRETVALUE` },
        request: {},
        response: { status: 400, data: { error: "invalid_grant", error_description: "AADSTS70008 x" } },
      })
    );
    await expect(
      AzureADHandler.handleAzureADAuth("CODE-SECRETVALUE", "VERIFIER-SECRETVALUE", "nonce", { tenantId: TENANT_B, connectionId: "connB" })
    ).rejects.toThrow();
    const text = logged();
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/SECRETVALUE|clientSecret/);
  });

  test("S2 the authentication connection API returns stored connection fields only, never app secrets", async () => {
    const TenantHandler = require("../handlers/tenant.handler");
    const out = await TenantHandler.getAuthenticationConnections(TENANT_A);
    const json = JSON.stringify(out);
    expect(json).not.toContain(SECRET);
    expect(json).not.toMatch(/clientSecret|appRef|redirectUri|AZURE_AD_/);
  });
});
