/**
 * Stage 5a: multi-directory Entra capability behind a default-off switch.
 *
 *  - ENTRA_CRM_MULTI_DIRECTORY: only the exact value "true" enables it. Unset / "false" / anything
 *    else keeps the single-directory compatibility assertion (DIRECTORY_NOT_ENABLED).
 *  - When enabled, a SELECTED organisation connection may name any valid directory; issuer, JWKS and
 *    endpoints derive from it. The application stays the one shared CRM app (client id, audience,
 *    scopes, redirect URI, secret): the customer is distinguished by directory only.
 *  - The Microsoft personal-account (consumer) directory is always refused; pseudo-tenants
 *    (common / organizations / consumers) stay refused by the GUID rule.
 *  - The legacy no-code CRM path is never widened: home directory, existing users only.
 *  - State binding, tid check and tenant-scoped oid lookup are unchanged.
 */
jest.mock("axios", () => ({ post: jest.fn(), get: jest.fn() }));

const TENANT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_B = "cccccccccccccccccccccccc";
const HOME_DIR = process.env.AZURE_AD_TENANT_ID; // tests/setupEntraEnv.js
const OTHER_DIR = "11111111-2222-3333-4444-555555555555";
const CONSUMER_DIR = "9188040d-6c67-4c5b-b112-36a304b66dad";
const CLIENT_ID = process.env.AZURE_AD_CLIENT_ID;
const TRUSTED_REDIRECT = process.env.AZURE_AD_REDIRECT_URI;
const SCOPES = "openid profile email offline_access";
const ENTRA = "Entra ID (Azure AD)";
const SWITCH = "ENTRA_CRM_MULTI_DIRECTORY";

const mockTenants = [];
const mockRows = (q) =>
  mockTenants.filter((t) => {
    if (t.isActive === false) return false;
    if (q.$or) return q.$or.some((c) => (c.code && c.code === t.code) || (c._id && String(c._id) === t._id));
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

const AzureADHandler = require("../handlers/azure.ad.handler");
const { makeTestKeypairAndJwks, signTestJwt } = require("./helpers/testJwt");

const resolver = () => require("../helpers/connectionAuthConfig");
const resolve = (connection, ctx) => resolver().resolveConnectionAuthConfig(connection, ctx);
const entraConn = (id, extra = {}) => ({ _id: id, connectionType: ENTRA, directoryId: HOME_DIR, isActive: true, ...extra });
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
const on = (fn) => withEnv({ [SWITCH]: "true" }, fn);
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
  const url = new URL(r.json.mock.calls[0][0].authorizationUrls.azureAD);
  return { url, state: url.searchParams.get("state"), nonce: url.searchParams.get("nonce") };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[SWITCH];
  mockTenants.length = 0;
  mockTenants.push(
    { _id: TENANT_A, code: "MULTIAUTH", isActive: true, authenticationConnections: [entraConn("connA")] },
    { _id: TENANT_B, code: "FOREIGNORG", isActive: true, authenticationConnections: [entraConn("connB", { directoryId: OTHER_DIR })] }
  );
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env[SWITCH];
  jest.restoreAllMocks();
});

describe("A/B: switch absent or not exactly 'true' -> single-directory behaviour unchanged", () => {
  test.each([
    ["absent", undefined],
    ["false", "false"],
    ["TRUE (case differs)", "TRUE"],
    ["' true' (whitespace)", " true"],
    ["1", "1"],
    ["yes", "yes"],
    ["empty", ""],
  ])("%s: home directory accepted, foreign directory -> DIRECTORY_NOT_ENABLED", async (_d, value) => {
    await withEnv({ [SWITCH]: value }, async () => {
      expect(resolve(entraConn("connA"))).toMatchObject({ directoryId: HOME_DIR, mode: "connection" });
      const e = thrown(() => resolve(entraConn("connB", { directoryId: OTHER_DIR })));
      expect(e).toMatchObject({ name: "AuthConfigError", code: "DIRECTORY_NOT_ENABLED" });
      expect(require("../helpers/authAppRegistry").getEntraCrmApp().multiDirectory).toBe(false);
    });
  });

  test("switch off: organisation-code login for a foreign directory is refused before any authorize URL", async () => {
    const out = await startLogin({ tenant: "FOREIGNORG" });
    expect(out.error).toMatchObject({ status: 400 });
    expect(out.r.json).not.toHaveBeenCalled();
  });
});

describe("C: switch exactly 'true' -> selected connection's directory is authoritative", () => {
  test("C1 a different valid directory resolves; issuer/JWKS/endpoints derive from it", async () => {
    await on(async () => {
      expect(require("../helpers/authAppRegistry").getEntraCrmApp().multiDirectory).toBe(true);
      const c = resolve(entraConn("connB", { directoryId: OTHER_DIR }));
      const base = `https://login.microsoftonline.com/${OTHER_DIR}`;
      expect(c).toMatchObject({
        mode: "connection",
        connectionId: "connB",
        directoryId: OTHER_DIR,
        issuer: `${base}/v2.0`,
        jwksUri: `${base}/discovery/v2.0/keys`,
        authorizeEndpoint: `${base}/oauth2/v2.0/authorize`,
        tokenEndpoint: `${base}/oauth2/v2.0/token`,
        logoutEndpoint: `${base}/oauth2/v2.0/logout`,
      });
    });
  });

  test("C2 the shared CRM application is unchanged: same client id, audience, scopes, redirect URI, secret", async () => {
    const home = resolve(entraConn("connA"));
    await on(async () => {
      const foreign = resolve(entraConn("connB", { directoryId: OTHER_DIR }));
      for (const k of ["application", "clientId", "audience", "redirectUri", "scopes"]) expect(foreign[k]).toBe(home[k]);
      expect(foreign).toMatchObject({ application: "entraCrm", clientId: CLIENT_ID, audience: CLIENT_ID, redirectUri: TRUSTED_REDIRECT, scopes: SCOPES });
      expect(foreign.clientSecret).toBe(home.clientSecret);
      expect(Object.keys(foreign)).not.toContain("clientSecret");
    });
  });

  test("C3 stored appRef / directoryOwnership / issuerUrl / audience still have no effect", async () => {
    await on(async () => {
      const plain = resolve(entraConn("connB", { directoryId: OTHER_DIR }));
      const noisy = resolve(
        entraConn("connB", {
          directoryId: OTHER_DIR,
          appRef: "anotherApp",
          directoryOwnership: "customer",
          issuerUrl: "https://login.microsoftonline.com/evil/v2.0",
          audience: "another-audience",
        })
      );
      expect(JSON.stringify(noisy)).toBe(JSON.stringify(plain));
    });
  });

  test("C4 organisation-code login for the foreign directory: authorize URL for that directory with the shared app", async () => {
    await on(async () => {
      const s = await startLogin({ tenant: "FOREIGNORG" });
      expect(s.url.pathname).toBe(`/${OTHER_DIR}/oauth2/v2.0/authorize`);
      expect(s.url.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(s.url.searchParams.get("redirect_uri")).toBe(TRUSTED_REDIRECT);
      expect(s.url.searchParams.get("scope")).toBe(SCOPES);
      const tx = require("../helpers/pkceStateStore").takeLoginTransaction(s.state);
      expect(tx).toEqual({ nonce: s.nonce, loginContext: { tenantId: TENANT_B, connectionId: "connB" } });
    });
  });

  test("C5 other connection checks still apply with the switch on", async () => {
    await on(async () => {
      expect(thrown(() => resolve(entraConn("c", { directoryId: OTHER_DIR, isActive: false })))).toMatchObject({ code: "CONNECTION_INACTIVE" });
      expect(thrown(() => resolve(entraConn("c", { directoryId: undefined })))).toMatchObject({ code: "INVALID_DIRECTORY" });
      expect(thrown(() => resolve(entraConn("c", { directoryId: `${OTHER_DIR}/../evil` })))).toMatchObject({ code: "INVALID_DIRECTORY" });
    });
  });
});

describe("D: the Microsoft personal-account (consumer) directory is always refused", () => {
  test.each([
    ["switch off", undefined],
    ["switch on", "true"],
  ])("%s", async (_d, value) => {
    await withEnv({ [SWITCH]: value }, async () => {
      for (const dir of [CONSUMER_DIR, CONSUMER_DIR.toUpperCase()]) {
        const e = thrown(() => resolve(entraConn("c", { directoryId: dir })));
        expect(e).toMatchObject({ name: "AuthConfigError", code: "INVALID_DIRECTORY" });
        expect(resolver().isOrganisationConfigError(e)).toBe(true);
      }
    });
  });

  test("even configured as the home directory it is refused (no-code path included)", async () => {
    await withEnv({ AZURE_AD_TENANT_ID: CONSUMER_DIR, [SWITCH]: "true" }, async () => {
      expect(thrown(() => resolve(entraConn("c", { directoryId: CONSUMER_DIR })))).toMatchObject({ code: "INVALID_DIRECTORY" });
      expect(thrown(() => resolve(null, { connectionType: ENTRA }))).toMatchObject({ code: "INVALID_DIRECTORY" });
    });
  });
});

describe("E: pseudo-tenants are refused (GUID rule unchanged)", () => {
  test.each(["common", "organizations", "consumers", "Common", " common", `${OTHER_DIR} `, "", "not-a-guid"])(
    "%p refused with the switch on and off",
    async (dir) => {
      for (const value of [undefined, "true"]) {
        await withEnv({ [SWITCH]: value }, async () => {
          expect(thrown(() => resolve(entraConn("c", { directoryId: dir })))).toMatchObject({ code: "INVALID_DIRECTORY" });
        });
      }
    }
  );
});

describe("F: the legacy no-code CRM path is never widened", () => {
  test("F1 resolves to the home directory only, switch on or off", async () => {
    for (const value of [undefined, "true"]) {
      await withEnv({ [SWITCH]: value }, async () => {
        expect(resolve(null, { connectionType: ENTRA })).toMatchObject({ mode: "legacy-no-organisation", directoryId: HOME_DIR, connectionId: null });
      });
    }
  });

  test("F2 the no-code authorize URL stays on the home directory with no tenant context", async () => {
    await on(async () => {
      const s = await startLogin({});
      expect(s.url.pathname).toBe(`/${HOME_DIR}/oauth2/v2.0/authorize`);
      expect(require("../helpers/pkceStateStore").takeLoginTransaction(s.state).loginContext).toBeNull();
    });
  });

  test("F3 a foreign-directory token is refused on the no-code path even with the switch on", async () => {
    const kp = await makeTestKeypairAndJwks();
    await on(async () => {
      const config = resolve(null, { connectionType: ENTRA });
      AzureADHandler._resetJwksForTests(kp.jwks, config.jwksUri);
      try {
        const token = await signTestJwt(kp.privateKey, {
          iss: `https://login.microsoftonline.com/${OTHER_DIR}/v2.0`,
          aud: CLIENT_ID,
          tid: OTHER_DIR,
          oid: "oid-foreign",
          email: "x@foreign.example",
          nonce: "n",
        });
        await expect(AzureADHandler.verifyIdToken(token, "n", config)).rejects.toBeTruthy();
      } finally {
        AzureADHandler._resetJwksForTests(null);
      }
    });
  });

  test("F4 the no-code handler path passes no tenant context, so it can never provision (existing users only)", async () => {
    await on(async () => {
      const exchange = jest.spyOn(AzureADHandler, "exchangeCodeForTokens").mockResolvedValue({ id_token: "i", access_token: "a" });
      jest.spyOn(AzureADHandler, "decodeIdToken").mockResolvedValue({ userEmail: "e" });
      jest.spyOn(AzureADHandler, "getUserInfoFromGraph").mockResolvedValue({});
      const find = jest.spyOn(AzureADHandler, "findOrCreateUser").mockResolvedValue({ _id: "u", tenantId: TENANT_A });
      await AzureADHandler.handleAzureADAuth("code", "verifier", "nonce", null);
      expect(exchange.mock.calls[0][2]).toMatchObject({ mode: "legacy-no-organisation", directoryId: HOME_DIR });
      expect(find.mock.calls[0][2]).toBeNull();
      const src = require("fs").readFileSync(require("path").join(__dirname, "..", "handlers", "azure.ad.handler.js"), "utf8");
      expect(src).toMatch(/resolveApplicationTenant\(\{ \.\.\.identity, allowProvisioning: false \}\)/);
    });
  });
});

describe("G: tenant isolation unchanged with the switch on", () => {
  let kpHome;
  let kpOther;
  const claims = (dir, extra = {}) => ({
    iss: `https://login.microsoftonline.com/${dir}/v2.0`,
    aud: CLIENT_ID,
    tid: dir,
    oid: "oid-1",
    email: "staff@example.com",
    nonce: "n",
    ...extra,
  });
  beforeAll(async () => {
    kpHome = await makeTestKeypairAndJwks();
    kpOther = await makeTestKeypairAndJwks();
  });
  afterAll(() => AzureADHandler._resetJwksForTests(null));

  test("G1 a token for the foreign directory verifies against that directory only; tid mismatch is refused", async () => {
    await on(async () => {
      const cfgOther = resolve(entraConn("connB", { directoryId: OTHER_DIR }));
      const cfgHome = resolve(entraConn("connA"));
      AzureADHandler._resetJwksForTests(kpOther.jwks, cfgOther.jwksUri);
      AzureADHandler._resetJwksForTests(kpHome.jwks, cfgHome.jwksUri);
      const good = await signTestJwt(kpOther.privateKey, claims(OTHER_DIR));
      await expect(AzureADHandler.verifyIdToken(good, "n", cfgOther)).resolves.toMatchObject({ tid: OTHER_DIR });
      const tidMismatch = await signTestJwt(kpOther.privateKey, claims(OTHER_DIR, { tid: HOME_DIR }));
      await expect(AzureADHandler.verifyIdToken(tidMismatch, "n", cfgOther)).rejects.toThrow(/tenant mismatch/);
      // A genuine home-directory token is refused by the foreign organisation's configuration.
      const homeToken = await signTestJwt(kpHome.privateKey, claims(HOME_DIR));
      await expect(AzureADHandler.verifyIdToken(homeToken, "n", cfgOther)).rejects.toBeTruthy();
    });
  });

  test("G2 the callback uses the state-bound tenant + connection; body/query hints are not read", async () => {
    await on(async () => {
      const exchange = jest.spyOn(AzureADHandler, "exchangeCodeForTokens").mockResolvedValue({ id_token: "i", access_token: "a" });
      jest.spyOn(AzureADHandler, "decodeIdToken").mockResolvedValue({ userEmail: "e" });
      jest.spyOn(AzureADHandler, "getUserInfoFromGraph").mockResolvedValue({});
      const find = jest.spyOn(AzureADHandler, "findOrCreateUser").mockResolvedValue({ _id: "u", tenantId: TENANT_B });
      const ctx = { tenantId: TENANT_B, connectionId: "connB" };
      await AzureADHandler.handleAzureADAuth("code", "verifier", "nonce", ctx);
      expect(exchange.mock.calls[0][2]).toMatchObject({ connectionId: "connB", directoryId: OTHER_DIR, clientId: CLIENT_ID });
      expect(find.mock.calls[0][2]).toEqual(ctx);
    });
  });

  test("G3 oid lookup and JIT stay scoped to the state-bound tenant; a token from another directory is refused", async () => {
    const { resolveTenantScopedUser } = require("../helpers/identityTenantResolution");
    const queries = [];
    const UserModel = { find: (q) => (queries.push(q), { lean: async () => [] }) };
    mockTenants[1].authenticationConnections = [entraConn("connB", { directoryId: OTHER_DIR, autoProvisionUsers: true })];
    await on(async () => {
      const base = { tenantId: TENANT_B, connectionId: "connB", connectionType: ENTRA, email: "new@foreign.example", microsoftId: "oid-1", UserModel };
      const out = await resolveTenantScopedUser({ ...base, directoryId: OTHER_DIR });
      expect(out).toMatchObject({ tenantId: TENANT_B, existingUser: null });
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.every((q) => q.tenantId === TENANT_B)).toBe(true);
      await expect(resolveTenantScopedUser({ ...base, directoryId: HOME_DIR })).rejects.toMatchObject({ code: "DIRECTORY_MISMATCH" });
    });
  });

  test("G4 a foreign-directory connection without automatic provisioning still refuses unknown users", async () => {
    const { resolveTenantScopedUser } = require("../helpers/identityTenantResolution");
    const UserModel = { find: () => ({ lean: async () => [] }) };
    await on(async () => {
      await expect(
        resolveTenantScopedUser({
          tenantId: TENANT_B,
          connectionId: "connB",
          connectionType: ENTRA,
          directoryId: OTHER_DIR,
          email: "new@foreign.example",
          microsoftId: "oid-1",
          UserModel,
        })
      ).rejects.toMatchObject({ code: "NOT_PROVISIONED" });
    });
  });
});
